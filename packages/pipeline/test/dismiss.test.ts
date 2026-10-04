import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultConfig,
	type Lens,
	loadLenses,
	type MelianConfig,
	type PullRequest,
	type ReviewProvider,
	type ReviewStatus,
	resolveRange,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	DismissHarness,
	dismissFinding,
	type Harness,
	openHarness,
	openPublishHarness,
	openSqliteStorage,
	publishReview,
	type Review,
	readVerdict,
	recordDismissal,
	reviewChangeset,
	revisionKey,
	type Storage,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdjudicationTask, type AdjudicationTaskInput } from "../src/adjudication.ts";
import { FindingsDocument } from "../src/findings.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines, writeFiles } from "./fixtures/repo.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";

// Lines 7 and 8 change together, so they are one hunk: the finding sits on line 8, and its trigger holds both lines.
const user = (label: string, body: string) =>
	lines(
		"export interface User {",
		"\tname: string;",
		"\tmanager?: User;",
		"}",
		"",
		"export function managerName(user: User): string {",
		`\tconst label = "${label}";`,
		body,
		"}",
	);

const unsafe = "\treturn user.manager.name + label;";

const nullDeref = {
	file: "src/user.ts",
	line: 8,
	rule: "null-dereference",
	severity: "P1",
	explanation: {
		what: "managerName reads name from a manager that may be undefined.",
		why: "This change dropped the optional chain, so a user without a manager throws.",
		fix: "Restore user.manager?.name with a fallback.",
	},
	failureScenario: 'managerName({ name: "Ada" }) throws TypeError: Cannot read properties of undefined.',
	evidence: [{ file: "src/user.ts", line: 8, role: "cause" }],
};

const deterministicRan = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
] as const;

const dismissal = {
	by: "Tal <tal@melian.invalid>",
	reason: "Every user here has a manager.",
	at: "2026-10-04T01:00:00Z",
};

let repo: string;
let dir: string;
let fake: FakeModels;
let config: MelianConfig;
let lenses: Lens[];
const opened: { close(ctx: typeof context): Promise<void> }[] = [];

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead(
		{ "src/user.ts": user("manager", '\treturn user.manager?.name ?? "none";') },
		{ "src/user.ts": user("boss", unsafe) },
	);
	dir = mkdtempSync(join(tmpdir(), "melian-dismiss-"));
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	config = { ...defaultConfig, models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } } };
	lenses = await loadLenses(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"]);
});

afterEach(async () => {
	for (const each of opened.splice(0)) await each.close(context);
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});

async function reviewHarness(storage: Storage): Promise<Harness> {
	const harness = await openHarness(storage, {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	opened.push(harness);
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	return harness;
}

const report = (args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall("report_finding", args), { stopReason: "toolUse" });

// The lenses' replies for one review: correctness reports the null dereference, and contracts nothing or, with
// `merged`, the same line under a rule of its own, which adjudication merges into the dereference as one defect.
function scriptFinding(merged = false): void {
	const changedReturn = { ...nullDeref, rule: "changed-return", severity: "P2" };
	scriptConversations(fake, [
		{ match: correctness, replies: [report(nullDeref), fauxAssistantMessage("Done.")] },
		{ match: contracts, replies: [...(merged ? [report(changedReturn)] : []), fauxAssistantMessage("Done.")] },
	]);
}

// Reviews main...feature, as a range, or as pull request #7 under its base's policy, which only can be published.
async function reviewed(harness: Harness, asPullRequest = false): Promise<Review> {
	const changeset = await resolveRange(repo, "main...feature");
	const { base, head } = changeset.revision;
	const pullRequest = {
		origin: {
			kind: "pull-request" as const,
			repository: { owner: "melian-agent", name: "example" },
			pullRequest: 7,
			base,
			head,
		},
		policy: { kind: "revision" as const, commit: base },
	};
	return reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: [],
		models: fake.review,
		checks: [...deterministicRan],
		...(asPullRequest ? pullRequest : {}),
	});
}

async function adjudicationTask(harness: Harness): Promise<number | undefined> {
	const root = (await harness.root(context)).id;
	return (await harness.snapshot(ReviewIndex, root, context))?.reviews[revisionKey(await revision())]?.adjudication
		?.task;
}

async function revision() {
	return (await resolveRange(repo, "main...feature")).revision;
}

async function dismiss(harness: Harness, id: string, with_ = dismissal) {
	return recordDismissal({ harness, revision: await revision(), id, dismissal: with_, repoRoot: repo });
}

// Pushes a commit onto `feature` that rewrites src/user.ts.
function push(label: string, body: string, extra: Record<string, string> = {}): void {
	writeFiles(repo, { "src/user.ts": user(label, body), ...extra });
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "push");
}

describe("recording a dismissal", () => {
	it("counts a dismissed finding out of a verdict it decides again, and a later review attaches to it", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		scriptFinding();
		const first = await reviewed(harness);
		expect(first.verdict).toMatchObject({ status: "findings", blocking: true });
		const [finding] = first.findings;

		const recorded = await dismiss(harness, finding!.properties.id);

		expect(recorded.verdict).toMatchObject({ status: "passed", blocking: false });
		expect(recorded.verdict.findings.block).toEqual([]);
		expect(recorded.replaced).toBeUndefined();
		expect(recorded.finding.properties).toMatchObject({ id: finding!.properties.id, status: "dismissed", dismissal });
		const root = (await harness.root(context)).id;
		const key = revisionKey(await revision());
		expect(await readVerdict(harness, root, key, context)).toEqual(recorded.verdict);
		const task = (await harness.snapshot(ReviewIndex, root, context))?.reviews[key]?.adjudication?.task;
		const calls = fake.provider.state.callCount;

		const again = await reviewed(harness);

		expect(again.verdict).toEqual(recorded.verdict);
		expect(fake.provider.state.callCount).toBe(calls);
		expect((await harness.snapshot(ReviewIndex, root, context))?.reviews[key]?.adjudication?.task).toBe(task);
	});

	it("replaces the reason of a finding dismissed again, keeping the first in its history", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		scriptFinding();
		const id = (await reviewed(harness)).findings[0]!.properties.id;
		await dismiss(harness, id);
		const later = {
			by: "Ana <ana@melian.invalid>",
			reason: "The caller checks it first.",
			at: "2026-10-04T02:00:00Z",
		};

		const recorded = await dismiss(harness, id, later);

		expect(recorded.replaced).toEqual(dismissal);
		expect(recorded.finding.properties.dismissal).toEqual(later);
		expect(recorded.finding.properties.pastDismissals).toEqual([{ ...dismissal, replacedAt: later.at }]);
		expect(recorded.verdict.status).toBe("passed");
	});

	it("keeps a dismissal across a new head whose trigger is unchanged", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		scriptFinding();
		await dismiss(harness, (await reviewed(harness)).findings[0]!.properties.id);
		push("boss", unsafe, { "src/other.ts": "export const other = 1;\n" });
		scriptFinding();

		const { verdict } = await reviewed(harness);

		expect(verdict).toMatchObject({ status: "passed", blocking: false });
		expect(verdict.dismissed.map((each) => each.properties.dismissal)).toEqual([dismissal]);
	});

	it("reopens a finding whose trigger changed materially, keeping the dismissal in its history", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		scriptFinding();
		const id = (await reviewed(harness)).findings[0]!.properties.id;
		await dismiss(harness, id);
		push("chief", unsafe);
		scriptFinding();
		const head = (await revision()).head;

		const { verdict } = await reviewed(harness);

		expect(verdict).toMatchObject({ status: "findings", blocking: true, dismissed: [] });
		const [reopened] = verdict.findings.block;
		expect(reopened!.properties).toMatchObject({ id, status: "new" });
		expect(reopened!.properties.dismissal).toBeUndefined();
		expect(reopened!.properties.pastDismissals).toEqual([
			{ ...dismissal, reopenedRevision: revisionKey({ base: (await revision()).base, head }) },
		]);
	});

	it("dismisses every report adjudication merged into the finding, so the defect leaves the verdict whole", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		scriptFinding(true);
		const { verdict: before } = await reviewed(harness);
		const [shown] = before.findings.block;
		const others = shown!.properties.alsoReportedAs!.map((other) => other.id);
		expect(others).toHaveLength(1);

		const recorded = await dismiss(harness, shown!.properties.id);

		expect(recorded.also).toEqual([
			expect.objectContaining({ id: others[0], ruleId: "changed-return", check: "lens.contracts" }),
		]);
		expect(recorded.verdict).toMatchObject({ status: "passed", blocking: false });
		expect(recorded.verdict.dismissed.map((each) => each.properties.id)).toEqual([shown!.properties.id]);
		expect(recorded.verdict.dismissed[0]!.properties.alsoReportedAs!.map((other) => other.id)).toEqual(others);
	});

	it("dismisses only the report the ID names when asked, leaving the report merged with it live", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		scriptFinding(true);
		const [shown] = (await reviewed(harness)).verdict.findings.block;
		const member = shown!.properties.alsoReportedAs![0]!.id;

		const recorded = await recordDismissal({
			harness,
			revision: await revision(),
			id: shown!.properties.id,
			dismissal,
			only: true,
			repoRoot: repo,
		});

		expect(recorded.also).toEqual([]);
		expect(recorded.finding.properties).toMatchObject({ id: shown!.properties.id, status: "dismissed" });
		const live = Object.values(recorded.verdict.findings).flat();
		expect(live.map((each) => each.properties.id)).toEqual([member]);
		expect(live[0]!.properties.alsoReportedAs).toEqual([
			expect.objectContaining({ id: shown!.properties.id, dismissed: true }),
		]);
	});

	it("dismisses again only the report an ID names, never a live finding that lists it as dismissed context", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		const changedReturn = { ...nullDeref, rule: "changed-return", severity: "P2" };
		scriptConversations(fake, [
			{ match: correctness, replies: [fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [report(changedReturn), fauxAssistantMessage("Done.")] },
		]);
		const old = (await reviewed(harness)).findings[0]!.properties.id;
		await dismiss(harness, old);
		push("boss", unsafe, { "src/other.ts": "export const other = 1;\n" });
		scriptFinding(true);
		const { verdict: before } = await reviewed(harness);
		const [live] = before.findings.block;
		expect(live).toMatchObject({ ruleId: "null-dereference", properties: { severity: "P1", status: "new" } });
		expect(live!.properties.alsoReportedAs!.map((other) => other.id)).toEqual([old]);
		const later = { ...dismissal, reason: "Contracts never promised a manager.", at: "2026-10-04T02:00:00Z" };

		const recorded = await dismiss(harness, old, later);

		expect(recorded.finding.properties).toMatchObject({ id: old, dismissal: later });
		expect(recorded.also).toEqual([]);
		expect(recorded.verdict).toMatchObject({ status: "findings", blocking: true });
		expect(recorded.verdict.findings.block.map((each) => each.properties.id)).toEqual([live!.properties.id]);
		expect(recorded.verdict.dismissed.map((each) => each.properties.id)).toEqual([old]);
	});

	it("waits for its own adjudication when the same dismissal is recorded again, adding no history", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		scriptFinding();
		const id = (await reviewed(harness)).findings[0]!.properties.id;
		const first = await dismiss(harness, id);
		const task = await adjudicationTask(harness);

		const again = await dismiss(harness, id);

		expect(again.replaced).toBeUndefined();
		expect(again.finding.properties.pastDismissals).toBeUndefined();
		expect(again.verdict).toEqual(first.verdict);
		expect(await adjudicationTask(harness)).toBe(task);
	});

	it("refuses to publish a verdict a cut-short dismissal left undecided, and finishes it when dismissed again", async () => {
		const path = join(dir, "changeset.sqlite");
		const first = await reviewHarness(await openSqliteStorage(path));
		scriptFinding();
		const id = (await reviewed(first, true)).findings[0]!.properties.id;
		const key = revisionKey(await revision());
		// What a dismiss killed after its commit leaves: the dismissal, and an adjudication task that never ran.
		const root = await first.root(context);
		await root.commit(async (tx) => {
			await dismissFinding(tx, root.id, id, dismissal);
			const index = await tx.doc(ReviewIndex, root.id);
			const entry = index.reviews[key]!;
			const input = {
				...(JSON.parse(entry.adjudication!.input) as AdjudicationTaskInput),
				findingsVersion: (await tx.doc(FindingsDocument, root.id)).versions[key]!,
			};
			const task = await tx.createTask(AdjudicationTask, input, { ownership: { kind: "conversation" } });
			index.reviews = {
				...index.reviews,
				[key]: { ...entry, adjudication: { task, input: JSON.stringify(input) } },
			};
			return undefined;
		}, context);
		await first.close(context);
		const { base, head } = await revision();
		const pullRequest: PullRequest = {
			repository: { owner: "melian-agent", name: "example" },
			number: 7,
			title: "t",
			url: "https://github.com/melian-agent/example/pull/7",
			state: "open",
			base: { ref: "main", sha: base },
			head: { ref: "feature", sha: head },
			fetch: { url: "https://github.com/melian-agent/example.git", headRef: "refs/pull/7/head" },
		};
		const statuses: ReviewStatus[] = [];
		const provider: ReviewProvider = {
			name: "fake",
			pullRequest: async () => pullRequest,
			postReview: async () => ({ id: "201", threads: {} }),
			replyResolved: async () => undefined,
			setStatus: async (_, status) => {
				statuses.push(status);
			},
			findPublished: async () => ({ threads: {}, replies: {} }),
		};
		const changeset = await resolveRange(repo, "main...feature");
		const publish = async () => {
			const publishing = await openPublishHarness(await openSqliteStorage(path), fake.review, provider);
			try {
				return await publishReview({ harness: publishing.harness, provider, changeset, pullRequest, base });
			} finally {
				await publishing.close(context);
			}
		};

		await expect(publish()).rejects.toMatchObject({ code: "notReviewed" });
		expect(statuses).toEqual([]);

		const dismissing = await DismissHarness.open(await openSqliteStorage(path), fake.review);
		opened.push(dismissing);
		const task = await adjudicationTask(dismissing.harness);
		const recorded = await dismiss(dismissing.harness, id);
		expect(recorded.verdict.status).toBe("passed");
		expect(await adjudicationTask(dismissing.harness)).toBe(task);
		await dismissing.close(context);
		await publish();
		expect(statuses).toEqual([{ state: "success", description: "Passed" }]);
	});

	it("refuses a revision with no stored review, and an ID its verdict does not hold", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		await expect(dismiss(harness, "0123456789abcdef")).rejects.toMatchObject({
			name: "DismissError",
			code: "notReviewed",
		});
		scriptFinding();
		await reviewed(harness);
		await expect(dismiss(harness, "0123456789abcdef")).rejects.toMatchObject({
			name: "DismissError",
			code: "unknownFinding",
		});
	});

	it("refuses a blank reason and records nothing", async () => {
		const harness = await reviewHarness(createMemoryStorage());
		scriptFinding();
		const first = await reviewed(harness);

		await expect(
			dismiss(harness, first.findings[0]!.properties.id, { ...dismissal, reason: "  " }),
		).rejects.toMatchObject({
			name: "FindingError",
			code: "invalidDismissal",
		});

		const root = (await harness.root(context)).id;
		expect(await readVerdict(harness, root, revisionKey(await revision()), context)).toEqual(first.verdict);
	});

	it("survives a reopen of the storage and a rerun of the review", async () => {
		const path = join(dir, "changeset.sqlite");
		const first = await reviewHarness(await openSqliteStorage(path));
		scriptFinding();
		const id = (await reviewed(first)).findings[0]!.properties.id;
		await first.close(context);
		const dismissing = await DismissHarness.open(await openSqliteStorage(path), fake.review);
		opened.push(dismissing);
		const recorded = await dismiss(dismissing.harness, id);
		expect(recorded.verdict.status).toBe("passed");
		const task = await adjudicationTask(dismissing.harness);
		await dismissing.close(context);
		const calls = fake.provider.state.callCount;

		const reopened = await reviewHarness(await openSqliteStorage(path));
		const { verdict } = await reviewed(reopened);

		expect(verdict).toEqual(recorded.verdict);
		expect(fake.provider.state.callCount).toBe(calls);
		expect(await adjudicationTask(reopened)).toBe(task);
	});
});
