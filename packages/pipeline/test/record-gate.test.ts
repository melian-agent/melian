import {
	Changeset,
	defaultConfig,
	everyRecordCounts,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	type RepositorySource,
	Revision,
	reviewPayloads,
	SharedRecord,
	TierAccount,
} from "@melian-agent/core";
import {
	ChangeLenses,
	type CheckRunRecord,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	type Message,
	openHarness,
	RecordGate,
	ReviewError,
	recordDismissal,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { provenRun } from "./fixtures/proven-run.ts";
import { commit, createRepository, gitIn, lines, removeRepository } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";
const finding = (file: string, severity: string) => ({
	file,
	line: 1,
	rule: "changed-return",
	severity,
	explanation: { what: "The value changed.", why: "This change rewrote it.", fix: "Restore it." },
	failureScenario: "A caller that reads the value expects 1 and gets 2.",
	evidence: [{ file, line: 1, role: "cause" }],
});
const checks: CheckRunRecord[] = [
	{ name: "guardrails", status: "ran", findings: 0, notes: [] },
	{ name: "static.biome", status: "ran", version: "2.5.0", findings: 0, notes: [] },
	{ name: "static.tsc", status: "ran", version: "5.9.3", findings: 0, notes: [] },
	{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
];
const worktree: RepositorySource = { kind: "worktree" };
const reports = (reported: object) => (messages: readonly Message[]) =>
	messages.some((message) => message.role === "toolResult")
		? fauxAssistantMessage("Done.")
		: fauxAssistantMessage(fauxToolCall("report_finding", reported as never), { stopReason: "toolUse" });
const quiet = () => fauxAssistantMessage("No findings.");

let repo: string;
let older: string;
const harnesses: Harness[] = [];

// main moves from `older` to a commit that changes src/b.ts, and feature, cut from main's tip, changes src/a.ts.
beforeEach(() => {
	repo = createRepository();
	older = commit(repo, { "src/a.ts": lines("export const a = 1;"), "src/b.ts": lines("export const b = 1;") });
	commit(repo, { "src/b.ts": lines("export const b = 2;") });
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	commit(repo, { "src/a.ts": lines("export const a = 2;") });
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close(context);
	removeRepository(repo);
});

const config: MelianConfig = { ...defaultConfig, tiers: twoLensTiers };

// One review of `range` in a harness of its own, so two reviews of one revision ask their lenses again, exporting to
// `store`. `contracts` scripts the contracts lens.
async function review(store: MemoryRecordStore, range: string, replies: readonly ScriptedReply[] = [quiet, quiet]) {
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	const routed: MelianConfig = { ...config, models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } } };
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	harnesses.push(harness);
	scriptConversations(fake, [
		{ match: correctness, replies: [quiet, quiet] },
		{ match: contracts, replies: [...replies, quiet, quiet] },
	]);
	const changeset = await Changeset.resolve(repo, range);
	const verdict = await reviewChangeset({
		harness,
		changeset,
		config: routed,
		lenses: await lensesOf(),
		standards: [],
		models: fake.review,
		checkRun: await provenRun(harness, changeset, checks),
		records: store,
		policy: worktree,
	}).then(
		(result) => result.verdict,
		(error: unknown) => {
			if (error instanceof ReviewError && error.verdict !== undefined) return error.verdict;
			throw error;
		},
	);
	return { harness, changeset, verdict };
}

async function lensesOf(): Promise<Lens[]> {
	return (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts");
}

const exported = () => new MemoryRecordStore({ payloads: reviewPayloads });

// The gate for feature into main over `records`, under `under`, the base tip's configuration.
async function gate(records: readonly RecordEnvelope[], counts = everyRecordCounts, under = config) {
	const merge = await Changeset.resolve(repo, "main...feature");
	const selection = await ChangeLenses.read({
		changeset: merge,
		lenses: await lensesOf(),
		config: under,
		tier: "full",
		policy: worktree,
		floor: "quick",
	});
	return RecordGate.decide(records, merge.id, {
		repoRoot: repo,
		target: gitIn(repo, "rev-parse", "main"),
		revision: merge.revision,
		config: under,
		policy: worktree,
		tier: TierAccount.of(under, "full", selection.tierLenses()),
		counts,
	});
}

async function listed(store: MemoryRecordStore): Promise<RecordEnvelope[]> {
	return store.list((await Changeset.resolve(repo, "main...feature")).id);
}

// Runs `step` with `branch` at `commit`, then puts it back, so a review there leaves a round of the same changeset at
// another revision.
async function at<T>(branch: string, target: string, step: () => Promise<T>): Promise<T> {
	const was = gitIn(repo, "rev-parse", branch);
	if (branch === "feature") gitIn(repo, "checkout", "--quiet", "--detach");
	gitIn(repo, "update-ref", `refs/heads/${branch}`, target);
	try {
		return await step();
	} finally {
		gitIn(repo, "update-ref", `refs/heads/${branch}`, was);
		if (branch === "feature") gitIn(repo, "checkout", "--quiet", "feature");
	}
}

const blocks = (file = "src/a.ts") => [reports(finding(file, "P1"))];
const mergeKey = async () => Revision.key((await Changeset.resolve(repo, "main...feature")).revision);

const rule = (outcome: RecordGate) =>
	[...Object.values(outcome.verdict.findings).flat()].map(({ properties }) => [
		properties.path,
		properties.resolution,
	]);

describe("the merge gate over a changeset's records", () => {
	it("passes a head whose one round of the merge's diff ran every check and found nothing", async () => {
		const store = exported();
		await review(store, "main...feature");
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), outcome.verdict.status, outcome.verdict.notRun, outcome.failures]).toEqual([
			true,
			"passed",
			[],
			[],
		]);
		expect(outcome.rounds.map(({ revision }) => revision)).toEqual([
			Revision.key((await Changeset.resolve(repo, "main...feature")).revision),
		]);
	});

	it("counts the finding of one round that another round of the same revision did not raise", async () => {
		const store = exported();
		await review(store, "main...feature");
		await review(store, "main...feature", blocks());
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), outcome.verdict.status, rule(outcome)]).toEqual([
			false,
			"findings",
			[["src/a.ts", "block"]],
		]);
	});

	it("counts the findings of a round at an older base of the tip and takes no coverage from it", async () => {
		const store = exported();
		await at("main", older, () => review(store, "main...feature", blocks()));
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), outcome.verdict.status, rule(outcome)]).toEqual([
			false,
			"not-reviewed",
			[["src/a.ts", "block"]],
		]);
		const reviewed = `${older}..${gitIn(repo, "rev-parse", "feature")}`;
		const gateKey = await mergeKey();
		expect(outcome.rounds.map(({ revision, covers }) => [revision, covers])).toEqual([
			[reviewed, { refused: `reviewed ${reviewed}, not this merge's ${await mergeKey()}` }],
		]);
		const required = (await gate([])).verdict.notRun.filter(({ name }) => name !== "records").map(({ name }) => name);
		expect(required.length).toBeGreaterThan(0);
		expect(outcome.verdict.notRun.map(({ name, status, reason }) => [name, status, reason])).toEqual(
			required.map((name) => [name, "skipped", `no round of ${gateKey} that stands as reviewed ran it`]),
		);
	});

	it("drops a finding of a counted round in a file the merge's diff leaves alone", async () => {
		const store = exported();
		await at("main", older, () => review(store, "main...feature", blocks("src/b.ts")));
		const counted = await gate(await listed(store));
		expect(counted.rounds).toHaveLength(1);
		await review(store, "main...feature");
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), outcome.verdict.status, rule(outcome)]).toEqual([true, "passed", []]);
	});

	it("counts no round of an earlier head", async () => {
		const store = exported();
		await review(store, "main...feature", blocks());
		commit(repo, { "src/a.ts": lines("export const a = 3;") });
		await review(store, "main...feature");
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), outcome.rounds.length, rule(outcome)]).toEqual([true, 1, []]);
	});

	it("counts no round whose base the tip does not hold", async () => {
		const store = exported();
		const first = gitIn(repo, "rev-parse", "feature");
		commit(repo, { "src/a.ts": lines("export const a = 3;") });
		await at("main", first, () => review(store, "main...feature", blocks()));
		await review(store, "main...feature");
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), outcome.rounds.length, rule(outcome)]).toEqual([true, 1, []]);
	});

	it("reads not reviewed when no round counts", async () => {
		const outcome = await gate([]);
		const head = gitIn(repo, "rev-parse", "feature");

		expect([outcome.passes(), outcome.verdict.status, outcome.failures]).toEqual([
			false,
			"not-reviewed",
			[`no round reviewed head ${head} at a base the base tip holds`],
		]);
	});

	it("counts no round whose records do not count", async () => {
		const store = exported();
		await review(store, "main...feature");
		const outcome = await gate(await listed(store), () => false);

		expect([outcome.passes(), outcome.rounds]).toEqual([false, []]);
	});

	it("fails the whole set when a counted round names a record the store does not hold", async () => {
		const store = exported();
		await review(store, "main...feature");
		const records = await listed(store);
		const round = SharedRecord.parseEnvelope(records.find(({ kind }) => kind === "round")!);
		const gone = round.manifest()!.read.find(({ kind }) => kind === "lens")!;
		const outcome = await gate(records.filter((each) => SharedRecord.parseEnvelope(each).id !== gone.id));

		expect([outcome.passes(), outcome.verdict.status, outcome.rounds, outcome.failures]).toEqual([
			false,
			"not-reviewed",
			[],
			[`round ${round.id} names records the store does not hold: ${gone.id}`],
		]);
	});

	it("fails the whole set when a record fails its checks", async () => {
		const store = exported();
		await review(store, "main...feature");
		const records = await listed(store);
		const lens = records.findIndex(({ kind }) => kind === "lens");
		const broken = records.map((each, index) =>
			index === lens ? ({ ...each, payload: { ...(each.payload as object), name: 7 } } as RecordEnvelope) : each,
		);
		const outcome = await gate(broken);

		expect([outcome.passes(), outcome.rounds, outcome.failures]).toEqual([
			false,
			[],
			[expect.stringMatching(/^a record fails its checks: /)],
		]);
	});

	it("takes no coverage from a round that does not account for the tip's tier", async () => {
		const store = exported();
		await review(store, "main...feature");
		const narrower: MelianConfig = { ...config, tiers: { ...twoLensTiers, full: ["standard"] } };
		const outcome = await gate(await listed(store), everyRecordCounts, narrower);

		expect([outcome.passes(), outcome.rounds.map(({ covers }) => covers)]).toEqual([
			false,
			[{ refused: "does not account for the base tip's tier (otherChecks)" }],
		]);
	});

	it("dismisses a finding that its one round's revision holds a shared dismissal of", async () => {
		const store = exported();
		const { harness, changeset, verdict } = await review(store, "main...feature", blocks());
		const { id } = Object.values(verdict.findings).flat()[0]!.properties;
		await recordDismissal({
			harness,
			revision: changeset.revision,
			id,
			dismissal: { by: "maintainer", reason: "a is meant to be 2", at: "2026-11-20T00:00:00.000Z" },
			repoRoot: repo,
			records: { store, changeset: changeset.id },
		});
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), rule(outcome), outcome.verdict.dismissed.map((each) => each.id)]).toEqual([
			true,
			[],
			[id],
		]);
	});

	it("keeps a finding live when one counted round holds its dismissal and another, at another base, does not", async () => {
		const store = exported();
		await at("main", older, () => review(store, "main...feature", blocks()));
		const { harness, changeset, verdict } = await review(store, "main...feature", blocks());
		const { id } = Object.values(verdict.findings).flat()[0]!.properties;
		await recordDismissal({
			harness,
			revision: changeset.revision,
			id,
			dismissal: { by: "maintainer", reason: "a is meant to be 2", at: "2026-11-20T00:00:00.000Z" },
			repoRoot: repo,
			records: { store, changeset: changeset.id },
		});
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), rule(outcome), outcome.verdict.dismissed]).toEqual([
			false,
			[["src/a.ts", "block"]],
			[],
		]);
		expect(outcome.ended.map(({ finding }) => finding)).toEqual([id]);
	});
});
