import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AccountPayload,
	Changeset,
	defaultConfig,
	everyRecordCounts,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	Rendering,
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
import { accountKey, ReviewRecords } from "../src/review-records.ts";
import { provenRun } from "./fixtures/proven-run.ts";
import { commit, createRepository, gitIn, lines, removeRepository } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";
const finding = (file: string, severity: string, line = 1, rule = "changed-return", causes = [{ file, line }]) => ({
	file,
	line,
	rule,
	severity,
	explanation: { what: "The value changed.", why: "This change rewrote it.", fix: "Restore it." },
	failureScenario: "A caller that reads the value expects 1 and gets 2.",
	evidence: causes.map((cause) => ({ ...cause, role: "cause" })),
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
// One reply per finding, each reporting it, then the lens's last word.
const reportsEach = (...found: object[]): ScriptedReply[] => [
	...found.map(
		(each) => () => fauxAssistantMessage(fauxToolCall("report_finding", each as never), { stopReason: "toolUse" }),
	),
	() => fauxAssistantMessage("Done."),
];

let repo: string;
let older: string;
const harnesses: Harness[] = [];

// main moves from `older` to a commit that changes src/b.ts, and feature, cut from main's tip, changes src/a.ts. No
// commit changes src/u.ts.
beforeEach(() => {
	repo = createRepository();
	older = commit(repo, {
		"src/a.ts": lines("export const a = 1;"),
		"src/b.ts": lines("export const b = 1;"),
		"src/u.ts": lines("export const u = 1;"),
	});
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
async function review(
	store: MemoryRecordStore,
	range: string,
	replies: readonly ScriptedReply[] = [quiet, quiet],
	ran: CheckRunRecord[] = checks,
	base: MelianConfig = config,
	verifier: readonly ScriptedReply[] = [],
) {
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	const routed: MelianConfig = {
		...base,
		models: { ...base.models, heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
	};
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	harnesses.push(harness);
	scriptConversations(fake, [
		{ match: correctness, replies: [quiet, quiet] },
		{ match: contracts, replies: [...replies, quiet, quiet] },
		...(verifier.length === 0 ? [] : [{ match: "Melian adversarial verifier", replies: verifier }]),
	]);
	const changeset = await Changeset.resolve(repo, range);
	const verdict = await reviewChangeset({
		harness,
		changeset,
		config: routed,
		lenses: await lensesOf(),
		standards: [],
		models: fake.review,
		checkRun: await provenRun(harness, changeset, ran),
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

	it("holds a pre-existing finding the merge's own round resolves acknowledge, in a file the change leaves alone", async () => {
		writeFileSync(join(repo, "melian.yaml"), lines("resolution:", "  preExisting:", "    P1: acknowledge"));
		const store = exported();
		const { verdict } = await review(store, "main...feature", blocks("src/u.ts"));
		expect(verdict.findings.acknowledge.map(({ properties }) => properties.path)).toEqual(["src/u.ts"]);
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), outcome.verdict.status, rule(outcome)]).toEqual([
			false,
			"findings",
			[["src/u.ts", "acknowledge"]],
		]);
	});

	it("drops a stacked parent's pre-existing finding in a file the merge's diff leaves alone", async () => {
		writeFileSync(join(repo, "melian.yaml"), lines("resolution:", "  preExisting:", "    P1: acknowledge"));
		const store = exported();
		await at("main", older, () => review(store, "main...feature", blocks("src/u.ts")));
		await review(store, "main...feature");
		const outcome = await gate(await listed(store));

		expect(outcome.rounds).toHaveLength(2);
		expect([outcome.passes(), outcome.verdict.status, rule(outcome)]).toEqual([true, "passed", []]);
	});

	it("names no ended dismissal of a finding the gate's verdict reads as dismissed", async () => {
		writeFileSync(join(repo, "melian.yaml"), lines("resolution:", "  preExisting:", "    P1: acknowledge"));
		const store = exported();
		await at("main", older, () => review(store, "main...feature", blocks("src/b.ts")));
		const { harness, changeset, verdict } = await review(store, "main...feature", blocks("src/b.ts"));
		const { id } = Object.values(verdict.findings).flat()[0]!.properties;
		await recordDismissal({
			harness,
			revision: changeset.revision,
			id,
			dismissal: { by: "maintainer", reason: "b is fine", at: "2026-11-20T00:00:00.000Z" },
			repoRoot: repo,
			records: { store, changeset: changeset.id },
		});
		const outcome = await gate(await listed(store));

		expect([outcome.verdict.dismissed.map((each) => each.id), outcome.ended]).toEqual([[id], []]);
	});

	it("names no dismissal of a stacked parent's finding outside the merge's diff", async () => {
		const store = exported();
		const parent = await at("main", older, () => review(store, "main...feature", blocks("src/b.ts")));
		await at("main", older, () =>
			recordDismissal({
				harness: parent.harness,
				revision: parent.changeset.revision,
				id: Object.values(parent.verdict.findings).flat()[0]!.properties.id,
				dismissal: { by: "maintainer", reason: "b is fine", at: "2026-11-20T00:00:00.000Z" },
				repoRoot: repo,
				records: { store, changeset: parent.changeset.id },
			}),
		);
		await review(store, "main...feature");
		const outcome = await gate(await listed(store));

		expect([rule(outcome), outcome.ended]).toEqual([[], []]);
	});

	it("names a dismissal once, though two counted rounds read it as ended by the same round", async () => {
		const store = exported();
		const parent = await at("main", older, () => review(store, "main...feature", blocks()));
		const { id } = Object.values(parent.verdict.findings).flat()[0]!.properties;
		await at("main", older, () =>
			recordDismissal({
				harness: parent.harness,
				revision: parent.changeset.revision,
				id,
				dismissal: { by: "maintainer", reason: "a is meant to be 2", at: "2026-11-20T00:00:00.000Z" },
				repoRoot: repo,
				records: { store, changeset: parent.changeset.id },
			}),
		);
		await review(store, "main...feature", blocks());
		const outcome = await gate(await listed(store));

		expect([rule(outcome), outcome.ended.map(({ finding }) => finding)]).toEqual([[["src/a.ts", "block"]], [id]]);
	});

	// The maintainer ruled on 2026-11-20 that a round at another revision ends a dismissal, and a revision is a base and a
	// head, so a stacked parent's round of this head, recorded later, ends one made on the merge's own round.
	it("fails closed on a dismissal of the merge's own round that a later round at an older base ends, naming it", async () => {
		writeFileSync(join(repo, "melian.yaml"), lines("resolution:", "  preExisting:", "    P1: acknowledge"));
		const store = exported();
		const { harness, changeset, verdict } = await review(store, "main...feature", blocks("src/b.ts"));
		const { id } = Object.values(verdict.findings).flat()[0]!.properties;
		await recordDismissal({
			harness,
			revision: changeset.revision,
			id,
			dismissal: { by: "maintainer", reason: "b is fine", at: "2026-11-20T00:00:00.000Z" },
			repoRoot: repo,
			records: { store, changeset: changeset.id },
		});
		await at("main", older, () => review(store, "main...feature"));
		const records = await listed(store);
		const parent = records
			.map((each) => SharedRecord.parseEnvelope(each))
			.find(({ kind, revision }) => kind === "round" && revision !== Revision.key(changeset.revision))!;
		const outcome = await gate(records);

		expect([outcome.passes(), rule(outcome)]).toEqual([false, [["src/b.ts", "acknowledge"]]]);
		expect(outcome.ended.map(({ finding, madeAt, round, at }) => [finding, madeAt, round, at])).toEqual([
			[id, Revision.key(changeset.revision), parent.id, parent.revision],
		]);
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

// Each counted finding as its path, line, resolution and severity, in the verdict's order.
const placed = (outcome: RecordGate) =>
	[...Object.values(outcome.verdict.findings).flat()].map((each) => [
		each.properties.path,
		each.lines()[0],
		each.properties.resolution,
		each.properties.severity,
	]);

// feature's head changes four lines of src/a.ts and adds src/c.ts, so findings can sit on several changed lines.
function widen() {
	commit(repo, {
		"src/a.ts": lines("export const a = 2;", "export const a2 = 2;", "export const a3 = 3;", "export const a4 = 4;"),
		"src/c.ts": lines("export const c = 1;", "export const c2 = 2;"),
	});
}

describe("the merge gate's merged findings", () => {
	it("keeps each finding at its strictest resolution and severity, whichever round raised it", async () => {
		widen();
		const store = exported();
		const a = (line: number, severity: string) => finding("src/a.ts", severity, line);
		await review(store, "main...feature", reportsEach(a(1, "P1"), a(2, "P2"), a(3, "P0"), a(4, "P1")));
		await review(store, "main...feature", reportsEach(a(1, "P2"), a(2, "P1"), a(3, "P1"), a(4, "P0")));
		const outcome = await gate(await listed(store));

		expect(placed(outcome)).toEqual([
			["src/a.ts", 1, "block", "P1"],
			["src/a.ts", 2, "block", "P1"],
			["src/a.ts", 3, "block", "P0"],
			["src/a.ts", 4, "block", "P0"],
		]);
		expect([outcome.passes(), outcome.verdict.status, outcome.verdict.blocking]).toEqual([false, "findings", true]);
	});

	it("orders the findings of every round by path, then line, then ID", async () => {
		widen();
		const store = exported();
		await review(store, "main...feature", reportsEach(finding("src/c.ts", "P1", 2), finding("src/a.ts", "P1", 4)));
		await review(
			store,
			"main...feature",
			reportsEach(finding("src/c.ts", "P1", 1), finding("src/a.ts", "P1", 2), {
				...finding("src/a.ts", "P1", 2),
				endLine: 3,
			}),
		);
		const outcome = await gate(await listed(store));

		expect(placed(outcome).map(([path, line]) => [path, line])).toEqual([
			["src/a.ts", 2],
			["src/a.ts", 2],
			["src/a.ts", 4],
			["src/c.ts", 1],
			["src/c.ts", 2],
		]);
		const ids = outcome.verdict.findings.block.slice(0, 2).map(({ id }) => id);
		expect(ids).toEqual([...ids].sort());
	});

	// A P1 on a line the merge leaves alone is pre-existing, and so advisory.
	it.each([
		["acknowledge", "P2", 1],
		["advisory", "P1", 2],
	])("reads findings that neither pass nor block when the one finding is %s", async (resolution, severity, line) => {
		commit(repo, { "src/a.ts": lines("export const a2 = 2;", "export const a = 1;") });
		const store = exported();
		await review(store, "main...feature", [reports(finding("src/a.ts", severity, line))]);
		const outcome = await gate(await listed(store));

		expect([placed(outcome), outcome.verdict.status, outcome.verdict.blocking]).toEqual([
			[["src/a.ts", line, resolution, severity]],
			"findings",
			false,
		]);
		expect(outcome.passes()).toBe(resolution === "advisory");
	});

	it("does not pass a head with one finding that blocks and one that awaits an answer", async () => {
		widen();
		const store = exported();
		await review(store, "main...feature", reportsEach(finding("src/a.ts", "P1"), finding("src/a.ts", "P2", 2)));
		const outcome = await gate(await listed(store));

		expect([outcome.passes(), placed(outcome).map(([, , resolution]) => resolution)]).toEqual([
			false,
			["block", "acknowledge"],
		]);
	});

	it("counts a finding off the merge's diff whose cause is proved by a hunk on it", async () => {
		commit(repo, { "src/z.ts": lines("export const z = 1;") });
		const store = exported();
		const proved = finding("src/u.ts", "P1", 1, "changed-return", [
			{ file: "src/b.ts", line: 1 },
			{ file: "src/z.ts", line: 1 },
		]);
		await at("main", older, () => review(store, "main...feature", [reports(proved)]));
		const outcome = await gate(await listed(store));

		const [counted] = Object.values(outcome.verdict.findings).flat();
		expect(counted?.properties.path).toBe("src/u.ts");
		expect(counted?.properties.trigger?.file).toBe("src/b.ts");
		expect(counted?.properties.trigger?.proof?.map(({ file }) => file)).toEqual(["src/b.ts", "src/z.ts"]);
	});

	it("counts a finding off the merge's diff whose trigger is on it", async () => {
		const store = exported();
		const proved = finding("src/b.ts", "P1", 1, "changed-return", [{ file: "src/a.ts", line: 1 }]);
		await review(store, "main...feature", [reports(proved)]);
		const outcome = await gate(await listed(store));

		expect(rule(outcome)).toEqual([["src/b.ts", "block"]]);
	});

	it("lists no dismissal of a finding in a file the merge's diff leaves alone", async () => {
		const store = exported();
		const { harness, changeset, verdict } = await at("main", older, () =>
			review(store, "main...feature", blocks("src/b.ts")),
		);
		const { id } = Object.values(verdict.findings).flat()[0]!.properties;
		await recordDismissal({
			harness,
			revision: changeset.revision,
			id,
			dismissal: { by: "maintainer", reason: "b is meant to be 2", at: "2026-11-20T00:00:00.000Z" },
			repoRoot: repo,
			records: { store, changeset: changeset.id },
		});
		const outcome = await gate(await listed(store));

		expect([outcome.rounds.length, rule(outcome), outcome.verdict.dismissed]).toEqual([1, [], []]);
	});
});

describe("the merge gate's refusals", () => {
	it("counts no round of another changeset", async () => {
		const store = exported();
		await review(store, "main...feature", blocks());
		const merge = await Changeset.resolve(repo, "main...feature");
		const outcome = await RecordGate.decide(await listed(store), `${merge.id}-other`, {
			repoRoot: repo,
			target: gitIn(repo, "rev-parse", "main"),
			revision: merge.revision,
			config,
			policy: worktree,
			tier: TierAccount.of(config, "full", { loaded: [], selected: [] }),
			counts: everyRecordCounts,
		});

		expect([outcome.rounds, rule(outcome), outcome.verdict.status]).toEqual([[], [], "not-reviewed"]);
	});

	it("throws an error that is not a record's own", async () => {
		const store = exported();
		await review(store, "main...feature");
		const broken = new Error("the counting rule broke");

		await expect(
			gate(await listed(store), () => {
				throw broken;
			}),
		).rejects.toBe(broken);
	});

	it("cannot decide when git cannot tell whether a round's base is in the tip's history", async () => {
		const first = gitIn(repo, "rev-parse", "feature");
		commit(repo, { "src/a.ts": lines("export const a = 3;") });
		const store = exported();
		await at("main", first, () => review(store, "main...feature"));
		const records = await listed(store);
		const merge = await Changeset.resolve(repo, "main...feature");
		// The round's base is feature's first commit; removing its object leaves git unable to answer.
		const object = gitIn(repo, "rev-parse", "--git-path", `objects/${first.slice(0, 2)}/${first.slice(2)}`);
		rmSync(join(repo, object));
		const outcome = await RecordGate.decide(records, merge.id, {
			repoRoot: repo,
			target: gitIn(repo, "rev-parse", "main"),
			revision: merge.revision,
			config,
			policy: worktree,
			tier: TierAccount.of(config, "full", { loaded: [], selected: [] }),
			counts: everyRecordCounts,
		});

		expect([outcome.verdict.status, outcome.failures, outcome.rounds, outcome.ended, outcome.unjudged]).toEqual([
			"not-reviewed",
			[`git cannot tell whether round ${roundId(records)}'s base ${first} is in the base tip's history`],
			[],
			[],
			[],
		]);
	});

	it("cannot decide when a counted round's records cannot stand for it", async () => {
		const store = exported();
		const { changeset } = await review(store, "main...feature", blocks());
		const records = (await listed(store)).map((each) => SharedRecord.parseEnvelope(each));
		const round = records.find(({ kind }) => kind === "round")!;
		const named = new Set(round.manifest()!.read.map(({ id }) => id));
		const account = records.find(({ kind, id }) => kind === "account" && named.has(id))!;
		const second = SharedRecord.parseEnvelope({
			...account.toJSON(),
			payload: { ...(account.payload as object), allowSkip: ["static.tsc"] },
		});
		const byId = new Map(records.map((each) => [each.id, each]));
		const { base, head } = changeset.revision;
		const manifest = round.manifest()!;
		const twice = ReviewRecords.of(changeset.id, { base, head }).round(
			[...manifest.read.map(({ id }) => byId.get(id)!), second],
			undefined,
			manifest.replaces,
			manifest.before,
		);
		const outcome = await gate(
			[...records.filter((each) => each !== round), second, twice].map((each) => each.toJSON()),
		);

		expect([outcome.passes(), outcome.verdict.status, outcome.rounds, outcome.failures]).toEqual([
			false,
			"not-reviewed",
			[],
			[`round ${twice.id} names no account, or more than one`],
		]);
	});
});

// The store's records with its one round replaced by a round of the same revision that reads `read`, and replaces and
// follows the rounds given.
async function reround(
	store: MemoryRecordStore,
	change: {
		read?: (read: SharedRecord[]) => SharedRecord[];
		keep?: (record: SharedRecord) => boolean;
		replaces?: string[];
		before?: string[];
	},
): Promise<{ records: RecordEnvelope[]; round: SharedRecord }> {
	const records = (await listed(store)).map((each) => SharedRecord.parseEnvelope(each));
	const round = records.find(({ kind }) => kind === "round")!;
	const byId = new Map(records.map((each) => [each.id, each]));
	const manifest = round.manifest()!;
	const { base, head } = Revision.parseKey(round.revision!)!;
	const read = manifest.read.map(({ id }) => byId.get(id)!);
	const forgedRead = change.read?.(read) ?? read;
	const forged = ReviewRecords.of(round.changeset, { base, head }).round(
		forgedRead,
		undefined,
		change.replaces ?? manifest.replaces,
		change.before ?? manifest.before,
	);
	return {
		records: [
			...new Map(
				[...records.filter((each) => each !== round && (change.keep?.(each) ?? true)), ...forgedRead, forged].map(
					(each) => [each.id, each],
				),
			).values(),
		].map((each) => each.toJSON()),
		round: forged,
	};
}

// Two reviews of the merge, each raising the same blocking finding in other words, and what each round said of it.
async function saidPerRound(store: MemoryRecordStore) {
	const what = new Map<string, string>();
	let last: Awaited<ReturnType<typeof review>> | undefined;
	for (const words of ["a is 2 now.", "a no longer reads 1."]) {
		last = await review(store, "main...feature", [
			reports({
				...finding("src/a.ts", "P1"),
				explanation: { what: words, why: "This change rewrote it.", fix: "Restore it." },
			}),
		]);
		const rounds = (await listed(store))
			.filter(({ kind }) => kind === "round")
			.map((each) => SharedRecord.parseEnvelope(each).id);
		what.set(rounds.find((id) => !what.has(id))!, words);
	}
	return { what, last };
}

describe("the merge gate's choice among rounds", () => {
	it("keeps the first counted round's copy of a finding one dismissal clears in two rounds", async () => {
		const store = exported();
		const said = await saidPerRound(store);
		const { harness, changeset, verdict } = said.last!;
		await recordDismissal({
			harness,
			revision: changeset.revision,
			id: Object.values(verdict.findings).flat()[0]!.properties.id,
			dismissal: { by: "maintainer", reason: "a is meant to be 2", at: "2026-11-20T00:00:00.000Z" },
			repoRoot: repo,
			records: { store, changeset: changeset.id },
		});
		const outcome = await gate(await listed(store));

		expect([outcome.rounds.length, rule(outcome)]).toEqual([2, []]);
		expect(outcome.verdict.dismissed.map(({ properties }) => properties.explanation.what)).toEqual([
			said.what.get(outcome.rounds[0]!.id),
		]);
	});

	it("keeps the first counted round's copy of a finding two rounds raised at one resolution and severity", async () => {
		const store = exported();
		const said = await saidPerRound(store);
		const outcome = await gate(await listed(store));

		expect(outcome.rounds).toHaveLength(2);
		expect(outcome.verdict.findings.block.map(({ properties }) => properties.explanation.what)).toEqual([
			said.what.get(outcome.rounds[0]!.id),
		]);
	});

	it("keeps a stricter resolution over a severity that ranks higher but resolves looser", async () => {
		widen();
		writeFileSync(join(repo, "melian.yaml"), lines("resolution:", "  P0: advisory"));
		const store = exported();
		const a = (line: number, severity: string) => finding("src/a.ts", severity, line);
		await review(store, "main...feature", reportsEach(a(1, "P0"), a(2, "P1")));
		await review(store, "main...feature", reportsEach(a(1, "P1"), a(2, "P0")));
		const outcome = await gate(await listed(store));

		expect(placed(outcome)).toEqual([
			["src/a.ts", 1, "block", "P1"],
			["src/a.ts", 2, "block", "P1"],
		]);
	});

	it("orders findings that start on one line by ID, whatever their severity", async () => {
		widen();
		const store = exported();
		const at2 = (severity: string, endLine?: number) => ({
			...finding("src/a.ts", severity, 2),
			...(endLine === undefined ? {} : { endLine }),
		});
		await review(store, "main...feature", reportsEach(at2("P1"), at2("P1", 3), at2("P0", 4)));
		const outcome = await gate(await listed(store));

		const ids = outcome.verdict.findings.block.map(({ id }) => id);
		expect(ids).toHaveLength(3);
		expect(ids).toEqual([...ids].sort());
	});

	it("orders the dismissed findings of every round by path, then line", async () => {
		widen();
		const store = exported();
		const earlier = await at("main", older, () =>
			review(store, "main...feature", reportsEach(finding("src/a.ts", "P1", 1), finding("src/c.ts", "P1", 2))),
		);
		const current = await review(
			store,
			"main...feature",
			reportsEach(finding("src/a.ts", "P1", 2), finding("src/c.ts", "P1", 1)),
		);
		for (const { harness, changeset, verdict } of [earlier, current])
			for (const { id } of Object.values(verdict.findings).flat())
				await recordDismissal({
					harness,
					revision: changeset.revision,
					id,
					dismissal: { by: "maintainer", reason: "meant", at: "2026-11-20T00:00:00.000Z" },
					repoRoot: repo,
					records: { store, changeset: changeset.id },
				});
		const outcome = await gate(await listed(store));

		expect(outcome.verdict.dismissed.map((each) => [each.properties.path, each.lines()[0]])).toEqual([
			["src/a.ts", 1],
			["src/a.ts", 2],
			["src/c.ts", 1],
			["src/c.ts", 2],
		]);
	});
});

describe("the merge gate's forged rounds", () => {
	it("covers nothing for a round that replaces another", async () => {
		const store = exported();
		await review(store, "main...feature");
		const { records, round } = await reround(store, { replaces: ["0".repeat(64)] });
		const outcome = await gate(records);

		expect([outcome.passes(), outcome.rounds]).toEqual([
			false,
			[{ id: round.id, revision: round.revision, covers: { refused: `replaces ${"0".repeat(64)}` } }],
		]);
	});

	it("covers nothing for a round that names a record of another revision", async () => {
		const store = exported();
		const { harness, changeset, verdict } = await review(store, "main...feature", blocks());
		await recordDismissal({
			harness,
			revision: changeset.revision,
			id: Object.values(verdict.findings).flat()[0]!.properties.id,
			dismissal: { by: "maintainer", reason: "a is meant to be 2", at: "2026-11-20T00:00:00.000Z" },
			repoRoot: repo,
			records: { store, changeset: changeset.id },
		});
		const dismissal = (await listed(store))
			.map((each) => SharedRecord.parseEnvelope(each))
			.find(({ kind }) => kind === "dismissal")!;
		// The account names the dismissal among its records, as a round that read it would, so only the revision differs.
		const forgedAccount = (account: SharedRecord) => {
			const payload = account.payload as AccountPayload;
			const claimed = { ...payload, records: [...payload.records, dismissal.id].sort() };
			return SharedRecord.parseEnvelope({
				...account.toJSON(),
				key: accountKey(account.revision!, claimed),
				payload: claimed,
			});
		};
		const { records, round } = await reround(store, {
			read: (read) => [...read.map((each) => (each.kind === "account" ? forgedAccount(each) : each)), dismissal],
			keep: (each) => each.kind !== "account",
		});
		const outcome = await gate(records);

		expect([outcome.passes(), outcome.rounds]).toEqual([
			false,
			[
				{
					id: round.id,
					revision: round.revision,
					covers: { refused: `names record ${dismissal.id} of another revision` },
				},
			],
		]);
	});

	it("names a dismissal no reader can judge, since a counted round follows a round the store does not hold", async () => {
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
		const first = (await listed(store)).find(({ kind }) => kind === "round")!;
		const { records, round } = await reround(store, { before: ["0".repeat(64)] });
		const outcome = await gate([...records, first]);

		expect([rule(outcome), outcome.verdict.dismissed]).toEqual([[["src/a.ts", "block"]], []]);
		expect(outcome.unjudged.map(({ finding: dismissed, round: since }) => [dismissed, since])).toContainEqual([
			id,
			round.id,
		]);
	});

	it("covers nothing for a round whose verifier failed, so a finding it never judged does not pass", async () => {
		const store = exported();
		const broken = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "the request was malformed" });
		await review(store, "main...feature", blocks(), checks, config, [broken, broken, broken, broken]);
		const outcome = await gate(await listed(store));
		expect(outcome.passes()).toBe(false);
		expect(outcome.rounds.map(({ covers }) => covers)).toEqual([
			{ refused: "did not run its verifier, so not every finding it raised was judged" },
		]);
		const [round] = outcome.rounds;
		expect(outcome.verdict.notRun.map(({ name, reason }) => [name, reason])).toEqual(
			["guardrails", "static.biome", "static.tsc", "decisions.fast", "lens.correctness", "lens.contracts"].map(
				(name) => [name, `round ${round!.id} would cover it, but did not run its verifier, so it covers nothing`],
			),
		);
	});

	it("blocks on the finding of a round no verifier model could serve, and takes no coverage from it", async () => {
		const store = exported();
		const unserved: MelianConfig = { ...config, models: { verifier: { model: "nowhere/none" } } };
		const { verdict } = await review(store, "main...feature", blocks(), checks, unserved);
		expect(verdict.status).toBe("not-reviewed");
		const outcome = await gate(await listed(store));
		expect(rule(outcome)).toEqual([["src/a.ts", "block"]]);
		expect(outcome.rounds.map(({ covers }) => covers)).toEqual([
			{ refused: "did not run its verifier, so not every finding it raised was judged" },
		]);
	});

	it("takes the coverage of a second round whose verifier ran, beside one whose verifier failed", async () => {
		const store = exported();
		const broken = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "the request was malformed" });
		// The second round's verifier judges and refutes its finding, so that round's account names the verifier.
		const refutes = (messages: readonly Message[]) =>
			messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage("Done.")
				: fauxAssistantMessage(
						fauxToolCall("report_verdict", {
							claim: "c1",
							answers: { code: "yes", guard: "yes", base: "no" },
							verdict: "refuted",
							reason: "A guard prevents it.",
							evidence: [{ file: "src/a.ts", line: 1, role: "context" }],
						}),
						{ stopReason: "toolUse" },
					);
		await review(store, "main...feature", blocks(), checks, config, [broken, broken, broken, broken]);
		const second = await review(store, "main...feature", blocks(), checks, config, [
			refutes,
			refutes,
			refutes,
			refutes,
		]);
		expect((second.verdict.ran ?? []).map(({ name }) => name)).toContain("verifier");
		const outcome = await gate(await listed(store));
		expect(outcome.verdict.notRun).toEqual([]);
		expect(outcome.rounds.map(({ covers }) => covers)).toEqual(
			expect.arrayContaining([{ refused: "did not run its verifier, so not every finding it raised was judged" }]),
		);
		expect(outcome.passes()).toBe(true);
	});

	it("does not count a check that failed as covered, though the policy lets it be skipped", async () => {
		const leave: MelianConfig = { ...config, checks: { ...config.checks, allowSkip: ["static.tsc"] } };
		const store = exported();
		const failed: CheckRunRecord = { name: "static.tsc", status: "failed", reason: "tsc exited 2", error: "exit 2" };
		await review(
			store,
			"main...feature",
			[quiet, quiet],
			checks.map((each) => (each.name === "static.tsc" ? failed : each)),
			leave,
		);
		const outcome = await gate(await listed(store), everyRecordCounts, leave);

		expect(outcome.rounds.map(({ covers }) => covers)).toEqual([
			["guardrails", "static.biome", "lens.correctness", "lens.contracts", "decisions.fast"],
		]);
		expect(outcome.verdict.notRun.map(({ name }) => name)).toEqual(["static.tsc"]);
	});

	it("takes no coverage of a lens that ran below the floor the base tip now sets for it", async () => {
		const store = exported();
		const { verdict } = await review(store, "main...feature");
		expect((verdict.ran ?? []).find(({ name }) => name === "lens.contracts")?.level).toBe("careful");
		writeFileSync(join(repo, "melian.yaml"), "lenses:\n  contracts:\n    level: { floor: deep }\n");
		const outcome = await gate(await listed(store));

		expect(outcome.rounds.map(({ covers }) => covers)).toEqual([
			["guardrails", "static.biome", "static.tsc", "lens.correctness", "decisions.fast"],
		]);
		expect(outcome.verdict.notRun.map(({ name }) => name)).toEqual(["lens.contracts"]);
		expect(outcome.passes()).toBe(false);
	});

	it("names the level a lens ran at and the floor the base tip now sets, so a builder can tell it from a lens that never ran", async () => {
		const store = exported();
		await review(store, "main...feature");
		writeFileSync(join(repo, "melian.yaml"), "lenses:\n  contracts:\n    level: { floor: deep }\n");
		const outcome = await gate(await listed(store));
		const [round] = outcome.rounds;
		const said = `round ${round!.id} ran it at careful, below the floor of deep the base tip sets for it now, so a new round must run it at that floor`;

		expect(outcome.verdict.notRun.map(({ name, reason }) => [name, reason])).toEqual([["lens.contracts", said]]);
		const rendered = outcome.verdict.render(new Rendering({ color: false, emoji: false, ids: true, decided: true }));
		expect(rendered).toContain(`lens.contracts  skipped: ${said}`);
	});

	it("names the first round that ran a lens below its floor, when two did", async () => {
		const store = exported();
		await review(store, "main...feature");
		await review(store, "main...feature", reportsEach(finding("src/a.ts", "P3")));
		writeFileSync(join(repo, "melian.yaml"), "lenses:\n  contracts:\n    level: { floor: deep }\n");
		const outcome = await gate(await listed(store));
		expect(outcome.rounds).toHaveLength(2);
		const [first] = outcome.rounds;

		expect(outcome.verdict.notRun.map(({ name, reason }) => [name, reason])).toEqual([
			[
				"lens.contracts",
				`round ${first!.id} ran it at careful, below the floor of deep the base tip sets for it now, so a new round must run it at that floor`,
			],
		]);
	});

	it("takes the coverage of a lens that ran at the floor the base tip sets for it", async () => {
		const store = exported();
		await review(store, "main...feature");
		writeFileSync(join(repo, "melian.yaml"), "lenses:\n  contracts:\n    level: { floor: careful }\n");
		const outcome = await gate(await listed(store));

		expect(outcome.rounds.map(({ covers }) => covers)).toEqual([
			["guardrails", "static.biome", "static.tsc", "lens.correctness", "lens.contracts", "decisions.fast"],
		]);
		expect(outcome.passes()).toBe(true);
	});
});

function roundId(records: readonly RecordEnvelope[]): string {
	return SharedRecord.parseEnvelope(records.find(({ kind }) => kind === "round")!).id;
}
