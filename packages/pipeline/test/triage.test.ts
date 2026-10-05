import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Changeset,
	type CheckRecord,
	type Decider,
	defaultConfig,
	Finding,
	Lens,
	type LensBudget,
	type MelianConfig,
	type ScrutinyLevel,
} from "@melian-agent/core";
import { FallbackDecider, RecordedDecider } from "@melian-agent/decisions";
import {
	type ConversationId,
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	createReviewRegistry,
	defineTask,
	type Harness,
	type Message,
	openHarness,
	openSqliteStorage,
	type Review,
	ReviewHarness,
	type ReviewOrigin,
	RouteTextModel,
	readFindings,
	readProvenance,
	readRecordedDecision,
	reviewChangeset,
	revisionKey,
	type SubmissionId,
	type TaskId,
	upsertFinding,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LensDocument } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { gitIn, isolatedGitEnv, lines, writeFiles } from "./fixtures/repo.ts";
import { crashFinding, crashRepository } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const fallback = "You answer typed questions about a code change";

let repo: string;
let fake: FakeModels;
let reviewHarness: ReviewHarness | undefined;
let harness: Harness;
let lenses: Lens[];
let config: MelianConfig;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = crashRepository();
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "light" }, { id: "medium" }, { id: "heavy" }] });
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	config = {
		...defaultConfig,
		// Correctness alone, so each test scripts one lens.
		tiers: { ...defaultConfig.tiers, full: ["standard"] },
		models: { light: route("light"), medium: route("medium"), heavy: route("heavy") },
	};
	lenses = await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"]);
});

afterEach(async () => {
	await reviewHarness?.close(context);
	reviewHarness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

// Opens a review harness holding `decider`'s decision extension, or none.
async function open(decider?: Decider): Promise<void> {
	await reviewHarness?.close(context);
	reviewHarness = await ReviewHarness.open(createMemoryStorage(), fake.review, {
		retry: false,
		...(decider === undefined ? {} : { decider }),
	});
	harness = reviewHarness.harness;
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
}

const ran: CheckRecord[] = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
];

async function review(
	options: {
		decider?: Decider;
		config?: MelianConfig;
		lenses?: Lens[];
		policy?: "worktree";
		origin?: ReviewOrigin;
		rerun?: boolean;
	} = {},
): Promise<Review> {
	return reviewChangeset({
		harness,
		changeset: await Changeset.resolve(repo, "main...feature"),
		config: options.config ?? config,
		lenses: options.lenses ?? lenses,
		standards: [],
		models: fake.review,
		checks: ran,
		...(options.decider === undefined ? {} : { decider: options.decider }),
		...(options.policy === undefined ? {} : { policy: { kind: options.policy } }),
		...(options.origin === undefined ? {} : { origin: options.origin }),
		...(options.rerun === undefined ? {} : { rerun: options.rerun }),
	});
}

function revision(): string {
	return revisionKey({
		base: gitIn(repo, "merge-base", "main", "feature"),
		head: gitIn(repo, "rev-parse", "feature"),
	});
}

function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

const done = fauxAssistantMessage("Done.");

const lightly =
	"triage chose quick for every lens, so the whole review looked lightly, at a change that can steer triage";

function choosing(level: "skip" | ScrutinyLevel, name = "recorded"): RecordedDecider {
	return new RecordedDecider({ triage: { correctness: { [level]: 1 } } }, { name });
}

const version = () => lenses.find((lens) => lens.name === "correctness")!.version;

// The budget a level states in a lens's instructions.
const statedBudget: Record<ScrutinyLevel, string> = {
	quick: "at most 3 findings",
	careful: "at most 8 findings",
	deep: "at most 12 findings",
};

function lensRecord(review: Review): CheckRecord | undefined {
	return [...(review.verdict.ran ?? []), ...review.verdict.notRun].find((check) => check.name === "lens.correctness");
}

// `lens` with `budget` over one level's budget.
function budgeted(lens: Lens, level: ScrutinyLevel, budget: Partial<LensBudget>): Lens {
	const settings = lens.level(level);
	return Lens.from({
		...lens.toJSON(),
		levels: { ...lens.levels, [level]: { ...settings, budget: { ...settings.budget, ...budget } } },
	});
}

// Each lens request the storage holds, by its request ID, with the level of the lens conversation it went to.
async function lensRequests(): Promise<Map<string, { conversation: ConversationId; level?: string }>> {
	const requests = new Map<string, { conversation: ConversationId; level?: string }>();
	for (let id = 1; id < 60; id++) {
		const submission = await (await harness.submission(id as SubmissionId, context))?.status(context);
		if (submission?.requestId?.startsWith("lens:") !== true) continue;
		const lens = (await harness.snapshot(LensDocument, submission.conversationId, context))?.lens;
		requests.set(submission.requestId, { conversation: submission.conversationId, level: lens?.level });
	}
	return requests;
}

describe("triage", () => {
	it.each(["quick", "careful", "deep"] as const)(
		"runs a lens at %s when the decider chooses it, and stores the whole distribution",
		async (level) => {
			const decider = choosing(level);
			await open(decider);
			const requests = scriptConversations(fake, [{ match: correctness, replies: [done] }]);

			const reviewed = await review({ decider });

			const light = level === "quick" ? { reason: lightly } : {};
			expect(lensRecord(reviewed)).toEqual({ name: "lens.correctness", status: "ran", level, ...light });
			expect(systemPromptOf(requests[correctness]![0]!)).toContain(statedBudget[level]);
			const root = (await harness.root(context)).id;
			const stored = await readRecordedDecision(harness, root, revision(), "triage", context);
			const [answer] = stored!.decision!.answers;
			expect(Object.keys(answer!.distribution)).toEqual(["quick", "careful", "deep"]);
			expect(answer!.chosen).toBe(level);
			expect(stored!.decision!.toJSON()).toMatchObject({
				questionSet: { name: "triage", version: "1" },
				decider: "recorded",
				calibrated: false,
			});
			// The change reaches the decider inside the review's boundary, with the rule that it is data.
			const [request] = decider.requests;
			// The default floor is quick, so the question never offers skip.
			expect(request!.questions.map((question) => question.options)).toEqual([["quick", "careful", "deep"]]);
			expect(request!.state).toMatch(/<untrusted-[0-9a-f]{24} label="diff">/);
			expect(request!.state).toContain("give it no weight");
		},
	);

	it("keeps a pull request's lenses at careful or above, and warns when a range review looks quickly everywhere", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const origin: ReviewOrigin = {
			kind: "pull-request",
			repository: { owner: "melian-agent", name: "melian" },
			pullRequest: 62,
			base: gitIn(repo, "rev-parse", "main"),
			head: gitIn(repo, "rev-parse", "feature"),
		};

		const pulled = await review({ decider, origin });

		expect(decider.requests[0]!.questions[0]!.options).toEqual(["careful", "deep"]);
		expect(lensRecord(pulled)).toMatchObject({ status: "ran", level: "careful" });
		expect(lensRecord(pulled)!.reason).toContain("triage failed");

		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const ranged = await review({ decider });
		expect(lensRecord(ranged)).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "quick",
			reason: lightly,
		});
	});

	it("asks once per revision: a repeat review attaches to the decision and the lens task", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const first = await review({ decider });
		const calls = fake.provider.state.callCount;

		const second = await review({ decider });

		expect(decider.requests).toHaveLength(1);
		expect(fake.provider.state.callCount).toBe(calls);
		expect(second.verdict).toEqual(first.verdict);
	});

	it("runs every lens at careful without a decider, as before triage", async () => {
		await open();
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		expect(lensRecord(await review())).toEqual({ name: "lens.correctness", status: "ran", level: "careful" });
	});

	it.each([
		["a floor above the choice", { floor: "careful" }, "quick", "careful"],
		["a ceiling below the choice", { ceiling: "quick" }, "deep", "quick"],
	] as const)("holds the choice to %s", async (_, band, chosen, level) => {
		const decider = choosing(chosen);
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const banded = band === undefined ? config : { ...config, lenses: { correctness: { level: band } } };

		expect(lensRecord(await review({ decider, config: banded }))).toMatchObject({ status: "ran", level });
	});

	it("offers and runs only the levels whose tier reaches a model with credentials", async () => {
		const decider = choosing("careful");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		// medium, quick's tier, is unrouted, so quick is never offered.
		const { medium: _, ...rest } = config.models;
		const reviewed = await review({ decider, config: { ...config, models: rest } });
		expect(decider.requests[0]!.questions[0]!.options).toEqual(["careful", "deep"]);
		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
	});

	it("fails the review before any lens runs when a lens's band holds no level it can run at", async () => {
		await open();
		const { heavy: _, ...rest } = config.models;
		const floored = { ...config, models: rest, lenses: { correctness: { level: { floor: "careful" } } } } as const;

		const error = await review({ config: floored }).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "noAvailableModel", lenses: ["correctness"] });
		expect((error as Error).message).toBe(
			"lens correctness may run from careful to deep, and no level there can run: careful runs on heavy, and no model is configured for the heavy tier; set models.heavy.model in melian.yaml; deep runs on heavy, and no model is configured for the heavy tier; set models.heavy.model in melian.yaml. Route the tier in melian.local.yaml, log in with pi, or set the provider's API key",
		);
		expect(fake.provider.state.callCount).toBe(0);
	});

	it("skips a lens only above a floor of skip, and the skip is allowed", async () => {
		const decider = choosing("skip");
		await open(decider);
		const optional = { ...config, lenses: { correctness: { level: { floor: "skip" } } } } as const;

		const { verdict } = await review({ decider, config: optional });

		expect(fake.provider.state.callCount).toBe(0);
		expect(verdict.status).toBe("passed");
		expect(verdict.notRun).toContainEqual({
			name: "lens.correctness",
			status: "skipped",
			reason: "triage skipped it, as its floor allows",
		});
	});

	it("reads each lens's band from the policy's configuration for every file it reviews", async () => {
		writeFiles(repo, { "src/melian.yaml": lines("lenses:", "  correctness:", "    level: { floor: deep }") });
		await open();
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		expect(lensRecord(await review({ policy: "worktree" }))).toMatchObject({ status: "ran", level: "deep" });
	});

	it("keeps each folder variant of a lens to its own band, and asks one question for both", async () => {
		writeFiles(repo, {
			"services/.melian/lenses/correctness/LENS.md": lines(
				"---",
				"name: correctness",
				"extends: correctness",
				"---",
				"Check the payments too.",
			),
			"services/pay.ts": lines("export const pay = 1;"),
		});
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "a payments service");
		writeFiles(repo, { "services/melian.yaml": lines("lenses:", "  correctness:", "    level: { floor: deep }") });
		const variants = await Lens.load(repo, { kind: "worktree" }, ["src/user.ts", "services/pay.ts"]);
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);

		const reviewed = await review({ decider, lenses: variants, policy: "worktree" });

		const [request] = decider.requests;
		expect(request!.questions.map((question) => [question.id, question.options])).toEqual([
			["correctness", ["quick", "careful", "deep"]],
		]);
		const levels = (reviewed.verdict.ran ?? [])
			.filter((check) => check.name === "lens.correctness")
			.map((check) => check.level)
			.sort();
		expect(levels).toEqual(["deep", "quick"]);
	});

	it("records a decision that failed, and runs every lens at its default level with a note", async () => {
		const decider = new RecordedDecider({});
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		const reviewed = await review({ decider });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		expect(lensRecord(reviewed)!.reason).toBe(
			"triage failed, so it ran at its default level: no answer to correctness in triage is recorded",
		);
		const stored = await readRecordedDecision(
			harness,
			(await harness.root(context)).id,
			revision(),
			"triage",
			context,
		);
		expect(stored).toMatchObject({ failure: "no answer to correctness in triage is recorded" });
		expect(stored!.decision).toBeUndefined();
	});

	describe("attaching to a stored decision", () => {
		// Fails its first `failures` calls, then chooses quick.
		function flaky(failures: number): Decider & { readonly calls: number } {
			let calls = 0;
			return {
				name: "flaky",
				calibrated: false,
				get calls() {
					return calls;
				},
				decide: async (request) => {
					calls++;
					if (calls <= failures) throw new Error("503 overloaded_error");
					return {
						answers: request.questions.map((question) => ({ question: question.id, distribution: { quick: 1 } })),
					};
				},
			};
		}

		it("keeps a failed decision on a repeat review, and asks again with rerun", async () => {
			const decider = flaky(1);
			await open(decider);
			scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);
			expect(lensRecord(await review({ decider }))!.reason).toContain("triage failed");
			const repeat = await review({ decider });
			expect(decider.calls).toBe(1);
			expect(lensRecord(repeat)).toMatchObject({
				level: "careful",
				reason: expect.stringContaining("triage failed"),
			});

			const rerun = await review({ decider, rerun: true });

			expect(decider.calls).toBe(2);
			expect(lensRecord(rerun)).toMatchObject({ level: "quick" });
		});

		it("never asks again after a decision that completed, even with rerun", async () => {
			const decider = flaky(0);
			await open(decider);
			scriptConversations(fake, [{ match: correctness, replies: [done] }]);
			await review({ decider });
			await review({ decider, rerun: true });
			expect(decider.calls).toBe(1);
		});

		it("asks a changed question again rather than attach", async () => {
			const decider = flaky(0);
			await open(decider);
			scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);
			await review({ decider });
			const floored = { ...config, lenses: { correctness: { level: { floor: "careful" } } } } as const;
			const changed = await review({ decider, config: floored });
			expect(decider.calls).toBe(2);
			// quick is no longer offered, so the answer fails closed to careful.
			expect(lensRecord(changed)).toMatchObject({
				level: "careful",
				reason: expect.stringContaining("triage failed"),
			});
		});
	});

	it("refuses a decider the harness was not opened with", async () => {
		await open();
		await expect(review({ decider: choosing("quick") })).rejects.toMatchObject({ code: "notInstalled" });
	});
});

describe("escalation", () => {
	const severe = call("report_finding", crashFinding);

	it("runs a lens again at the next level, in its own conversation, when at quick it reports at or above escalateAt", async () => {
		const decider = choosing("quick");
		await open(decider);
		const requests = scriptConversations(fake, [{ match: correctness, replies: [severe, done, done] }]);

		const reviewed = await review({ decider });

		expect(lensRecord(reviewed)).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "careful",
			reason:
				"escalated from quick to careful: at quick it reported a P1 finding, at or above P1; 1 finding quick carried at or above P1, which careful neither restated nor refuted, still counts as quick reported it",
		});
		// The careful run starts afresh on the change, at careful's budget, with the quick run's finding to check.
		const careful = requests[correctness]![2]!;
		expect(systemPromptOf(careful)).toContain(statedBudget.careful);
		expect(careful.filter((message) => message.role === "assistant")).toEqual([]);
		const input = textOf(careful.find((message) => message.role === "user")!);
		expect(input).toMatch(/^Review the change from/);
		expect(input).toContain("## Findings a quicker look reported");
		expect(input).toMatch(
			/<untrusted-[0-9a-f]{24} label="findings">\n[0-9a-f]{16} P1 null-dereference at src\/user\.ts:7: /,
		);
		// Each level is its own conversation and its own request, so the rerun's input is not deduplicated.
		const sent = await lensRequests();
		const quick = sent.get(`lens:correctness@${version()}@quick:0`);
		const rerun = sent.get(`lens:correctness@${version()}@careful:0`);
		expect(quick).toMatchObject({ level: "quick" });
		expect(rerun).toMatchObject({ level: "careful" });
		expect(rerun!.conversation).not.toBe(quick!.conversation);
		// The quick P1 the careful run left unanswered still blocks, attributed to the quick run.
		expect(reviewed.verdict).toMatchObject({ status: "findings", blocking: true });
		expect(reviewed.findings.map((finding) => finding.properties.source)).toEqual([
			{ check: "lens.correctness", version: `${version()}@quick` },
		]);
		const root = (await harness.root(context)).id;
		const index = await harness.snapshot(ReviewIndex, root, context);
		expect(index!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@quick band quick-deep escalateAt P1`,
		]);
		expect((await readProvenance(harness, root, revision(), context))!.lenses).toEqual([
			`correctness@${version()}@careful`,
		]);
	});

	it("counts a quick finding the escalated run restates once, with the escalated run speaking for it", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [severe, done, severe, done] }]);

		const reviewed = await review({ decider });

		expect(reviewed.findings.map((finding) => finding.properties.source)).toEqual([
			{ check: "lens.correctness", version: `${version()}@careful` },
		]);
		expect(reviewed.findings[0]!.properties.reportedBy).toEqual([
			{ check: "lens.correctness", version: `${version()}@careful` },
		]);
		expect(lensRecord(reviewed)!.reason).toBe(
			"escalated from quick to careful: at quick it reported a P1 finding, at or above P1; careful restated 1 finding quick carried",
		);
	});

	it("drops a quick finding the escalated run refutes", async () => {
		const decider = choosing("quick");
		await open(decider);
		const refute = call("report_finding", {
			...crashFinding,
			refuted: true,
			failureScenario: "Every caller passes a user whose manager is set, so the dereference cannot fail.",
		});
		const requests = scriptConversations(fake, [{ match: correctness, replies: [severe, done, refute, done] }]);

		const reviewed = await review({ decider });

		expect(reviewed.findings).toEqual([]);
		expect(reviewed.verdict.status).toBe("passed");
		expect(lensRecord(reviewed)!.reason).toBe(
			"escalated from quick to careful: at quick it reported a P1 finding, at or above P1; careful refuted 1 finding quick carried",
		);
		const results = requests[correctness]![3]!.filter((message) => message.role === "toolResult").map(textOf);
		expect(results.at(-1)).toMatch(/^recorded that finding [0-9a-f]{16} is not a defect$/);
	});

	it("runs a lens again when a budget ended it at quick before it reported anything", async () => {
		const decider = choosing("quick");
		await open(decider);
		const tight = lenses.map((lens) => (lens.name === "correctness" ? budgeted(lens, "quick", { tools: 1 }) : lens));
		const reads = fauxAssistantMessage(
			[
				fauxToolCall("read_file", { path: "src/user.ts" }),
				fauxToolCall("read_file", { path: "src/user.ts", startLine: 5 }),
			],
			{ stopReason: "toolUse" },
		);
		scriptConversations(fake, [{ match: correctness, replies: [reads, done, done] }]);

		const reviewed = await review({ decider, lenses: tight });

		expect(lensRecord(reviewed)).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "careful",
			reason: "escalated from quick to careful: at quick its tools budget ended it before it reported anything",
		});
		expect(reviewed.verdict.status).toBe("passed");
	});

	it("leaves a lens a budget ended at quick ended when its ceiling is quick", async () => {
		const decider = choosing("quick");
		await open(decider);
		const tight = lenses.map((lens) => (lens.name === "correctness" ? budgeted(lens, "quick", { tools: 1 }) : lens));
		const reads = fauxAssistantMessage(
			[
				fauxToolCall("read_file", { path: "src/user.ts" }),
				fauxToolCall("read_file", { path: "src/user.ts", startLine: 5 }),
			],
			{ stopReason: "toolUse" },
		);
		scriptConversations(fake, [{ match: correctness, replies: [reads, done] }]);
		const capped = { ...config, lenses: { correctness: { level: { ceiling: "quick" } } } } as const;

		const reviewed = await review({ decider, lenses: tight, config: capped });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ended", level: "quick" });
		expect(reviewed.verdict.status).toBe("not-reviewed");
	});

	it("reports a severe quick finding with a note when the ceiling caps the escalation", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [severe, done] }]);
		const capped = { ...config, lenses: { correctness: { level: { ceiling: "quick" } } } } as const;

		const reviewed = await review({ decider, config: capped });

		expect(lensRecord(reviewed)).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "quick",
			reason: `escalation capped at quick, its ceiling: at quick it reported a P1 finding, at or above P1; ${lightly}`,
		});
		expect(reviewed.findings.map((finding) => finding.ruleId)).toEqual(["null-dereference"]);
	});

	it("caps an escalation whose next level's tier reaches no model, with a note", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [severe, done] }]);
		const { heavy: _, ...rest } = config.models;
		const quickOnly = { ...config, models: rest };

		const reviewed = await review({ decider, config: quickOnly });

		expect(lensRecord(reviewed)).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "quick",
			reason: `escalation capped at quick, since careful runs on heavy, which reaches no model with credentials: at quick it reported a P1 finding, at or above P1; ${lightly}`,
		});
	});

	it("does not escalate a quick finding below escalateAt, and does at a lower escalateAt", async () => {
		const mild = call("report_finding", { ...crashFinding, severity: "P2" });
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [mild, done] }]);
		expect(lensRecord(await review({ decider }))).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "quick",
			reason: lightly,
		});

		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [mild, done, done] }]);
		const lower = { ...config, triage: { escalateAt: "P2" } } as const;
		expect(lensRecord(await review({ decider, config: lower }))).toMatchObject({ status: "ran", level: "careful" });
	});

	it("runs the lenses again, rather than attach, when the severity that escalates them changes", async () => {
		const decider = choosing("quick");
		await open(decider);
		const mild = call("report_finding", { ...crashFinding, severity: "P2" });
		scriptConversations(fake, [{ match: correctness, replies: [mild, done] }]);
		expect(lensRecord(await review({ decider }))).toMatchObject({ level: "quick" });

		// The same revision and levels, but a P2 now escalates: the earlier task decided under the old rule.
		scriptConversations(fake, [{ match: correctness, replies: [mild, done, done] }]);
		const lower = { ...config, triage: { escalateAt: "P2" } } as const;
		const reviewed = await review({ decider, config: lower });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		const index = await harness.snapshot(ReviewIndex, (await harness.root(context)).id, context);
		expect(index!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@quick band quick-deep escalateAt P2`,
		]);
	});

	it("never lets a review at one level attach to a review of the revision at another", async () => {
		// Chooses the least look each question offers.
		const decider: Decider = {
			name: "least",
			calibrated: false,
			decide: async (request) => ({
				answers: request.questions.map((question) => ({
					question: question.id,
					distribution: { [question.options[0]!]: 1 },
				})),
			}),
		};
		await open(decider);
		const mild = call("report_finding", { ...crashFinding, severity: "P2" });
		scriptConversations(fake, [{ match: correctness, replies: [mild, done] }]);
		const first = await review({ decider });
		expect(lensRecord(first)).toMatchObject({ level: "quick" });
		expect(first.findings).toHaveLength(1);
		const calls = fake.provider.state.callCount;

		// A floor of deep offers only deep: another question, another selection, and another task.
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const floored = { ...config, lenses: { correctness: { level: { floor: "deep" } } } } as const;
		const second = await review({ decider, config: floored });

		expect(fake.provider.state.callCount).toBe(calls + 1);
		expect(lensRecord(second)).toMatchObject({ level: "deep" });
		expect(second.findings).toEqual([]);
		const root = (await harness.root(context)).id;
		const index = await harness.snapshot(ReviewIndex, root, context);
		expect(index!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@deep band deep-deep escalateAt P1`,
		]);
	});
});

describe("the LLM fallback", () => {
	async function fallbackDecider(): Promise<FallbackDecider> {
		const model = await RouteTextModel.open(fake.review, [fake.ref("light")]);
		return new FallbackDecider(model!);
	}

	it("answers triage on a text model through one tool, uncalibrated, and the lens runs at its answer", async () => {
		const decider = await fallbackDecider();
		await open(decider);
		const answer = call("answer", {
			answers: [
				{
					question: "correctness",
					probabilities: [
						{ option: "careful", probability: 0.25 },
						{ option: "deep", probability: 0.75 },
					],
				},
			],
		});
		const requests = scriptConversations(fake, [
			{ match: fallback, replies: [answer] },
			{ match: correctness, replies: [done] },
		]);

		const reviewed = await review({ decider });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "deep" });
		const [asked] = requests[fallback]!;
		const prompt = asked!
			.filter((message: Message) => message.role === "user")
			.map(textOf)
			.join("\n");
		expect(prompt).toContain("How closely should the `correctness` lens review this change?");
		expect(prompt).toMatch(/<untrusted-[0-9a-f]{24} label="diff">/);
		const stored = await readRecordedDecision(
			harness,
			(await harness.root(context)).id,
			revision(),
			"triage",
			context,
		);
		expect(stored!.decision!.toJSON()).toMatchObject({
			decider: "llm-fallback",
			calibrated: false,
			model: `${fake.ref("light").provider}/light`,
			answers: [
				{
					question: "correctness",
					distribution: { quick: 0, careful: 0.25, deep: 0.75 },
					chosen: "deep",
				},
			],
		});
	});

	it("fails closed to the default level when the model answers in prose", async () => {
		const decider = await fallbackDecider();
		await open(decider);
		scriptConversations(fake, [
			{ match: fallback, replies: [fauxAssistantMessage("Run it at quick.")] },
			{ match: correctness, replies: [done] },
		]);

		const reviewed = await review({ decider });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		expect(lensRecord(reviewed)!.reason).toContain("triage failed, so it ran at its default level");
	});
});

describe("decision providers (issue #24)", () => {
	it("records a decisions check with its reason once a provider is configured, rather than leave it without one", async () => {
		await open();
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const provided = { ...config, decisions: { ...config.decisions, provider: "clef" } };

		const { verdict } = await review({ config: provided });

		expect(verdict.status).toBe("not-reviewed");
		expect(verdict.notRun).toEqual([
			{
				name: "decisions.fast",
				status: "skipped",
				reason: "decisions.provider is clef, and Melian has no adapter for a decision provider yet",
			},
		]);
	});
});

describe("reviews recorded before levels joined the keys", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "melian-triage-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps a sighting stored under the lens's version alone readable, and runs the lens afresh rather than attach", async () => {
		await open();
		const root = await harness.root(context);
		const atVersion = { check: "lens.correctness", version: version() };
		const old = Finding.create({
			rule: "null-dereference",
			message: "managerName reads name from a manager that may be undefined.",
			file: "src/user.ts",
			startLine: 7,
			snippet: "\treturn user.manager.name;",
			occurrence: 0,
			cause: "introduced",
			severity: "P1",
			explanation: { what: "w", whyHere: "y", whatToDo: "t" },
			source: atVersion,
		});
		// What an older Melian's review left: a sighting naming the lens's version alone, and the selection by name@version.
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, old, revision());
			(await tx.doc(ReviewIndex, root.id)).reviews = { [revision()]: { lenses: [`correctness@${version()}`] } };
		}, context);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		const reviewed = await review();

		expect(fake.provider.state.callCount).toBe(1);
		expect(reviewed.findings).toEqual([]);
		const index = await harness.snapshot(ReviewIndex, root.id, context);
		expect(index!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@careful band quick-deep escalateAt P1`,
		]);
		const stored = await readFindings(harness, root.id, revision(), context, { producers: [atVersion] });
		expect(stored.map((finding) => finding.properties.id)).toEqual([old.properties.id]);
	});

	it("resumes a lens task an older Melian created, at version 1, under the current definition", async () => {
		const path = join(dir, "review.sqlite");
		// The definition as an older Melian registered it; only its name and version reach storage.
		const LegacyLensTask = defineTask<unknown, { phase: "spawn" }, unknown>({
			name: "melian.lenses",
			version: 1,
			initial: () => ({ phase: "spawn" }),
			phases: { spawn: async () => undefined },
			abort: async () => undefined,
		});
		const head = gitIn(repo, "rev-parse", "feature");
		const base = gitIn(repo, "merge-base", "main", "feature");
		const lens = lenses.find((each) => each.name === "correctness")!;
		const legacy = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createRegistry(),
		});
		const root = await legacy.root(context, { agent: { model: fake.ref("orchestrator") } });
		const input = {
			root: root.id,
			revision: { repoRoot: repo, nonce: "0".repeat(24), base, head, files: [] },
			lenses: [
				{
					key: `correctness@${lens.version}`,
					name: "correctness",
					version: lens.version,
					level: "careful",
					route: [fake.ref("heavy")],
					instructions: correctness,
					tools: [...lens.tools],
					severities: [...lens.severities],
					rules: lens.rules.map((rule) => ({ ...rule })),
					budget: { findings: 8 },
					coverage: { scope: "", paths: ["**"], nearer: [] },
					prompt: "Review the change.",
				},
			],
		};
		const taskId = await root.commit(
			(tx) => tx.createTask(LegacyLensTask, input, { ownership: { kind: "conversation" } }),
			context,
		);
		await legacy.close(context);
		scriptConversations(fake, [{ match: correctness, replies: [call("report_finding", crashFinding), done] }]);

		const current = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		try {
			current.resume();
			const settled = await current.waitForTask(taskId as TaskId<Record<string, { status: string }>>, context);
			expect(settled.state.outcome).toMatchObject({
				status: "completed",
				result: { [`correctness@${lens.version}`]: { status: "done" } },
			});
			const findings = await readFindings(current, root.id, revisionKey({ base, head }), context);
			// The migration strips the run's level, so its findings name the version alone, as its own review expects.
			expect(findings.map((finding) => finding.properties.source)).toEqual([
				{ check: "lens.correctness", version: lens.version },
			]);
		} finally {
			await current.close(context);
		}
	});
});
