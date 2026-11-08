import {
	Changeset,
	defaultConfig,
	Finding,
	type FindingInput,
	type FindingSource,
	injectionAttemptRuleId,
	Merge,
	Revision,
	type Severity,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	dismissFinding,
	type Harness,
	openHarness,
	readFindings,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSightings,
	dismissedRoots,
	FindingsDocument,
	overlapsSite,
	type Restating,
	recordInheritances,
	replaceInheritances,
	upsertVerification,
} from "../src/findings.ts";
import type { Tx } from "../src/harness.ts";
import { provingHunk, type ReviewState, reviewFiles } from "../src/lens-tools.ts";
import { Predecessors } from "../src/restatement.ts";
import { createRepository, gitIn, removeRepository, writeFiles } from "./fixtures/repo.ts";

const correctness: FindingSource = { check: "lens.correctness", version: "1@careful" };
const contracts: FindingSource = { check: "lens.contracts", version: "1@careful" };
const dismissal = { by: "Tal <tal@melian.invalid>", reason: "Accepted.", at: "2026-11-01T00:00:00Z" };

let harness: Harness;
let root: Awaited<ReturnType<Harness["root"]>>["id"];

const lens = (overrides: Partial<FindingInput> & { snippet: string }): Finding =>
	Finding.create({
		rule: "fail-open",
		file: "a.ts",
		startLine: 5,
		occurrence: 0,
		severity: "P2",
		cause: "pre-existing",
		message: "The guard fails open.",
		source: correctness,
		explanation: { what: "What", whyHere: "Why", whatToDo: "Fix" },
		failureScenario: "A cold run reads a cached kill.",
		evidence: [{ file: "a.ts", startLine: 5, role: "context", revision: "head", snippet: overrides.snippet }],
		...overrides,
	});

async function commit<T>(write: (tx: Tx) => Promise<T>): Promise<T> {
	const owner = await harness.root(context);
	return owner.commit(write, context);
}

beforeEach(async () => {
	const fake = createFakeModels();
	harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
	root = (await harness.root(context, { agent: { model: fake.ref() } })).id;
});

afterEach(async () => {
	await harness.close(context);
});

describe("recording restatement links", () => {
	const at = "base..head";
	const first = lens({ snippet: "first restated" });
	const second = lens({ snippet: "second restated", source: contracts });
	const oldRoot = lens({ snippet: "old root" });
	const newRoot = lens({ snippet: "new root" });
	const claims: Restating["claims"] = [
		{ id: first.id, source: correctness, ruleId: "fail-open" },
		{ id: second.id, source: contracts, ruleId: "fail-open" },
	];
	const members = [first.id, second.id];

	async function seed(options: { reported?: Severity; oldSeverity?: Severity; newSeverity?: Severity } = {}) {
		await commit(async (tx) => {
			for (const each of [first, second])
				await upsertFinding(
					tx,
					root,
					options.reported === undefined
						? each
						: lens({
								snippet: each.properties.evidence![0]!.snippet,
								source: each.properties.source,
								severity: options.reported,
							}),
					at,
				);
			for (const each of [oldRoot, newRoot]) await upsertFinding(tx, root, each, "base..earlier");
			await dismissFinding(tx, root, oldRoot.id, dismissal, "base..earlier", options.oldSeverity ?? "P2");
			await dismissFinding(
				tx,
				root,
				newRoot.id,
				{ ...dismissal, at: "2026-11-02T00:00:00Z" },
				"base..earlier",
				options.newSeverity ?? "P2",
			);
		});
	}

	async function judge(id: string, source: FindingSource, matches: Record<string, string>, version = "v1") {
		await commit((tx) =>
			upsertVerification(tx, root, at, id, source, {
				verdict: "confirmed",
				reason: "Traced.",
				matches: matches as Record<string, "same" | "different">,
				executor: "llm",
				model: "faux/judge",
				version,
			}),
		);
	}

	const derive = (dismissed: string[], version = "v1", restClaims = claims) =>
		commit((tx) => recordInheritances(tx, root, at, [{ members, claims: restClaims, dismissed }], version));
	const links = async () => (await harness.snapshot(FindingsDocument, root, context))!.inherited?.[at];

	it("links every member to a root every claim judged the same", async () => {
		await seed();
		await judge(first.id, correctness, { [oldRoot.id]: "same" });
		await judge(second.id, contracts, { [oldRoot.id]: "same" });
		expect(await derive([oldRoot.id])).toBe(true);
		const link = { from: oldRoot.id, kind: "inherited", dismissedAt: dismissal.at };
		expect(await links()).toEqual({ [first.id]: link, [second.id]: link });
		expect(await derive([oldRoot.id])).toBe(false);
	});

	it("needs a same answer from each merged claim: one different, or one missing, links nothing", async () => {
		await seed();
		await judge(first.id, correctness, { [oldRoot.id]: "same" });
		await derive([oldRoot.id]);
		expect(await links()).toBeUndefined();
		await judge(second.id, contracts, { [oldRoot.id]: "different" });
		await derive([oldRoot.id]);
		expect(await links()).toBeUndefined();
	});

	it("reads a claim's judgement only at this revision and under its own producer", async () => {
		await seed();
		await judge(first.id, correctness, { [oldRoot.id]: "same" });
		await commit(async (tx) => {
			// The second claim's ID sighted by another producer, and at another revision, each judged the same there.
			await upsertFinding(tx, root, lens({ snippet: "second restated", source: correctness }), at);
			await upsertVerification(tx, root, at, second.id, correctness, {
				verdict: "confirmed",
				reason: "Traced.",
				matches: { [oldRoot.id]: "same" },
				executor: "llm",
				model: "faux/judge",
				version: "v1",
			});
		});
		await derive([oldRoot.id]);
		expect(await links()).toBeUndefined();
		const elsewhere = "base..elsewhere";
		const third = lens({ snippet: "third restated" });
		await commit(async (tx) => {
			await upsertFinding(tx, root, third, at);
			await upsertFinding(tx, root, third, elsewhere);
			await upsertVerification(tx, root, elsewhere, third.id, correctness, {
				verdict: "confirmed",
				reason: "Traced.",
				matches: { [oldRoot.id]: "same" },
				executor: "llm",
				model: "faux/judge",
				version: "v1",
			});
		});
		await derive([oldRoot.id], "v1", [claims[0]!, { id: third.id, source: correctness, ruleId: "fail-open" }]);
		expect(await links()).toBeUndefined();
	});

	it("revokes a link when a later round's judgement differs, or a new verifier version has judged nothing", async () => {
		await seed();
		await judge(first.id, correctness, { [oldRoot.id]: "same" });
		await judge(second.id, contracts, { [oldRoot.id]: "same" });
		await derive([oldRoot.id]);
		expect(await links()).toBeDefined();
		expect(await derive([oldRoot.id], "v2")).toBe(true);
		expect(await links()).toBeUndefined();
		await derive([oldRoot.id]);
		await judge(first.id, correctness, { [oldRoot.id]: "different" }, "v3");
		await judge(second.id, contracts, { [oldRoot.id]: "same" }, "v3");
		await derive([oldRoot.id], "v3");
		expect(await links()).toBeUndefined();
	});

	it("leaves no link for a root it was not asked about, or with no claims", async () => {
		await seed();
		await judge(first.id, correctness, { [oldRoot.id]: "same" });
		await judge(second.id, contracts, { [oldRoot.id]: "same" });
		await derive([]);
		expect(await links()).toBeUndefined();
		await derive(["0123456789abcdef"]);
		expect(await links()).toBeUndefined();
		await derive([oldRoot.id], "v1", []);
		expect(await links()).toBeUndefined();
	});

	it.each([
		{ reported: "P1", root: "P2", kind: "proposed" },
		{ reported: "P2", root: "P2", kind: "inherited" },
		{ reported: "P3", root: "P2", kind: "inherited" },
	] as const)("fences a $reported restatement of a $root root: $kind", async ({ reported, root: severity, kind }) => {
		await seed({ reported, oldSeverity: severity });
		await judge(first.id, correctness, { [oldRoot.id]: "same" });
		await judge(second.id, contracts, { [oldRoot.id]: "same" });
		await derive([oldRoot.id]);
		expect((await links())?.[first.id]).toEqual({ from: oldRoot.id, kind, dismissedAt: dismissal.at });
	});

	it("fences on the severity a lens reported, before the verifier lowered it", async () => {
		await seed({ reported: "P1", oldSeverity: "P2" });
		await commit((tx) =>
			upsertVerification(tx, root, at, first.id, correctness, {
				verdict: "confirmed",
				reason: "Narrower.",
				lowered: { from: "P1", to: "P2", reason: "Narrower." },
				matches: { [oldRoot.id]: "same" },
				executor: "llm",
				model: "faux/judge",
				version: "v1",
			}),
		);
		await judge(second.id, contracts, { [oldRoot.id]: "same" });
		await derive([oldRoot.id]);
		expect((await links())?.[first.id]?.kind).toBe("proposed");
	});

	it("fences across every member: one higher claim makes the whole defect a proposal", async () => {
		await seed({ oldSeverity: "P2" });
		await commit((tx) =>
			upsertFinding(tx, root, lens({ snippet: "second restated", source: contracts, severity: "P1" }), at),
		);
		await judge(first.id, correctness, { [oldRoot.id]: "same" });
		await judge(second.id, contracts, { [oldRoot.id]: "same" });
		await derive([oldRoot.id]);
		expect(await links()).toEqual({
			[first.id]: { from: oldRoot.id, kind: "proposed", dismissedAt: dismissal.at },
			[second.id]: { from: oldRoot.id, kind: "proposed", dismissedAt: dismissal.at },
		});
	});

	it("never carries a dismissal stored without a severity, nor one that no longer stands", async () => {
		await seed();
		const legacy = lens({ snippet: "legacy root" });
		await commit(async (tx) => {
			await upsertFinding(tx, root, legacy, "base..earlier");
			await dismissFinding(tx, root, legacy.id, dismissal, "base..earlier");
		});
		await judge(first.id, correctness, { [legacy.id]: "same", [first.id]: "same" });
		await judge(second.id, contracts, { [legacy.id]: "same", [first.id]: "same" });
		await derive([legacy.id]);
		expect(await links()).toBeUndefined();
		// A finding that only inherits is no root: its lifecycle holds no dismissal.
		await derive([first.id]);
		expect(await links()).toBeUndefined();
	});

	it.each([
		{ name: "a trust-boundary claim", check: "lens.trust-boundary", rule: "fail-open" },
		{ name: "a tests claim", check: "lens.tests", rule: "fail-open" },
		{ name: "an untested-behaviour claim", check: "lens.correctness", rule: "untested-behaviour" },
	])("proposes, never inherits, for $name", async ({ check, rule }) => {
		await seed();
		await judge(first.id, correctness, { [oldRoot.id]: "same" });
		await judge(second.id, contracts, { [oldRoot.id]: "same" });
		const floored = claims.map((claim, index) =>
			index === 1 ? { ...claim, source: { ...claim.source, check }, ruleId: rule } : claim,
		);
		// The floored claim's record sits under its own source.
		await commit(async (tx) => {
			const moved = lens({ snippet: "second restated", source: { check, version: "1@careful" }, rule });
			await upsertFinding(tx, root, moved, at);
			await upsertVerification(
				tx,
				root,
				at,
				moved.id,
				{ check, version: "1@careful" },
				{
					verdict: "confirmed",
					reason: "Traced.",
					matches: { [oldRoot.id]: "same" },
					executor: "llm",
					model: "faux/judge",
					version: "v1",
				},
			);
			floored[1] = { id: moved.id, source: { check, version: "1@careful" }, ruleId: rule };
		});
		await derive([oldRoot.id], "v1", floored);
		expect((await links())?.[first.id]).toEqual({ from: oldRoot.id, kind: "proposed", dismissedAt: dismissal.at });
	});

	it("breaks a tie between roots dismissed at one time by the lower ID", async () => {
		await seed();
		const tied = lens({ snippet: "tied root" });
		await commit(async (tx) => {
			await upsertFinding(tx, root, tied, "base..earlier");
			await dismissFinding(tx, root, tied.id, { ...dismissal, reason: "Tied." }, "base..earlier", "P2");
		});
		for (const [id, source] of [
			[first.id, correctness],
			[second.id, contracts],
		] as const)
			await judge(id, source, { [oldRoot.id]: "same", [tied.id]: "same" });
		const lower = [oldRoot.id, tied.id].sort()[0]!;
		await derive([oldRoot.id, tied.id]);
		expect((await links())?.[first.id]?.from).toBe(lower);
		await derive([tied.id, oldRoot.id]);
		expect((await links())?.[first.id]?.from).toBe(lower);
	});

	it("takes the latest dismissal among the roots judged the same, after fencing each", async () => {
		await seed({ reported: "P1", oldSeverity: "P1", newSeverity: "P2" });
		for (const [id, source] of [
			[first.id, correctness],
			[second.id, contracts],
		] as const)
			await judge(id, source, { [oldRoot.id]: "same", [newRoot.id]: "same" });
		await derive([oldRoot.id, newRoot.id]);
		expect((await links())?.[first.id]).toEqual({
			from: newRoot.id,
			kind: "proposed",
			dismissedAt: "2026-11-02T00:00:00Z",
		});
		// With only the older root, the fence holds and it inherits.
		await derive([oldRoot.id]);
		expect((await links())?.[first.id]).toEqual({ from: oldRoot.id, kind: "inherited", dismissedAt: dismissal.at });
		// The newer root judged different leaves the older one.
		for (const [id, source] of [
			[first.id, correctness],
			[second.id, contracts],
		] as const)
			await judge(id, source, { [oldRoot.id]: "same", [newRoot.id]: "different" }, "v4");
		await derive([newRoot.id, oldRoot.id], "v4");
		expect((await links())?.[first.id]?.from).toBe(oldRoot.id);
	});

	it("reopens every inheritor when the root reopens", async () => {
		await seed();
		await commit((tx) =>
			replaceInheritances(tx, root, at, {
				[first.id]: { from: oldRoot.id, kind: "inherited", dismissedAt: dismissal.at },
				[second.id]: { from: oldRoot.id, kind: "inherited", dismissedAt: dismissal.at },
			}),
		);
		const read = async () => (await readFindings(harness, root, at, context)).map((each) => each.properties.status);
		expect(await read()).toEqual(["dismissed", "dismissed"]);
		await commit((tx) =>
			upsertFinding(
				tx,
				root,
				Finding.from({
					...oldRoot.toJSON(),
					properties: {
						...oldRoot.properties,
						cause: "introduced",
						trigger: { file: "a.ts", index: 0, snippet: "x" },
					},
				}),
				"base..later",
			),
		);
		expect((await harness.snapshot(FindingsDocument, root, context))!.items[oldRoot.id]!.lifecycle.status).toBe(
			"new",
		);
		expect(await read()).toEqual(["new", "new"]);
	});
});

describe("finding the roots a defect may restate", () => {
	let repo: string;
	let base: string;
	let h1: string;
	const ten = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
	const text = (rows: readonly string[]) => `${rows.join("\n")}\n`;

	const step = (rows: readonly string[], extra: Record<string, string> = {}) => {
		writeFiles(repo, { "a.ts": text(rows), ...extra });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "step");
		return gitIn(repo, "rev-parse", "HEAD").trim();
	};
	const withLine5 = () => [...ten.slice(0, 4), "changed 5", ...ten.slice(5)];

	beforeEach(() => {
		repo = createRepository();
		base = step(ten);
		h1 = step(withLine5());
	});
	afterEach(() => removeRepository(repo));

	async function reviewOf(head: string): Promise<{ state: ReviewState; key: string; revision: Revision }> {
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const state: ReviewState = {
			repoRoot: repo,
			nonce: "n",
			base,
			head,
			files: reviewFiles(changeset.revision.files),
		};
		return { state, key: Revision.key({ base, head }), revision: changeset.revision };
	}

	const introduced = (snippet: string, startLine: number, endLine: number, overrides: Partial<FindingInput> = {}) =>
		lens({
			snippet,
			startLine,
			endLine,
			cause: "introduced",
			trigger: { file: "a.ts", index: 0, snippet: "changed 5" },
			evidence: [{ file: "a.ts", startLine, role: "cause", revision: "head", snippet }],
			...overrides,
		});

	// D, the root, at the first head's lines 5 to 6, dismissed at P2.
	async function dismissRoot(
		found: Finding = introduced("changed 5\nline 6", 5, 6),
		severity: Severity | null = "P2",
	) {
		const { key } = await reviewOf(h1);
		await commit(async (tx) => {
			await upsertFinding(tx, root, found, key);
			await dismissFinding(tx, root, found.id, dismissal, key, severity ?? undefined);
		});
		return found;
	}

	async function predecessorsAt(head: string, restated: Finding, extra: Finding[] = []): Promise<string[]> {
		const { state, key, revision } = await reviewOf(head);
		await commit(async (tx) => {
			for (const each of [restated, ...extra])
				await upsertFinding(
					tx,
					root,
					each,
					key,
					state.files.flatMap((file) => file.hunks.map(provingHunk)),
				);
		});
		const findings = await readFindings(harness, root, key, context, { asReported: true });
		const defect = new Merge(findings, defaultConfig, revision)
			.defects()
			.find((each) => [each.speaker.id, ...each.members.map((member) => member.id)].includes(restated.id));
		expect(defect).toBeDefined();
		const predecessors = await Predecessors.open(harness, root, key, state, context);
		return (await predecessors.of(defect!)).map((each) => each.id);
	}

	it("offers a root of the same rule and file whose region git maps unchanged onto the restatement's", async () => {
		const found = await dismissRoot();
		const h2 = step(withLine5(), { "b.ts": "other\n" });
		const restated = introduced("changed 5", 5, 5);
		const { state, key, revision } = await reviewOf(h2);
		await commit((tx) => upsertFinding(tx, root, restated, key));
		const findings = await readFindings(harness, root, key, context, { asReported: true });
		const [defect] = new Merge(findings, defaultConfig, revision).defects();
		const shown = await (await Predecessors.open(harness, root, key, state, context)).of(defect!);
		expect(shown).toEqual([
			{ id: found.id, failureScenario: found.properties.failureScenario, evidence: found.properties.evidence },
		]);
	});

	it("maps the region across lines added above it", async () => {
		const found = await dismissRoot();
		const h2 = step(["new 0", ...withLine5()]);
		const restated = introduced("changed 5", 6, 6, { trigger: { file: "a.ts", index: 1, snippet: "changed 5" } });
		expect(await predecessorsAt(h2, restated)).toEqual([found.id]);
		// The root's mapped lines are 6 to 7; a restatement at line 8 does not overlap them.
		const below = introduced("line 7", 8, 8, { trigger: { file: "a.ts", index: 1, snippet: "changed 5" } });
		expect(await predecessorsAt(h2, below)).toEqual([]);
	});

	it.each([
		{ name: "another rule", overrides: { rule: "other-rule" } },
		{ name: "another file", overrides: { file: "c.ts" } },
	])("offers nothing for $name", async ({ overrides }) => {
		await dismissRoot();
		const h2 = step(withLine5(), { "b.ts": "other\n", "c.ts": text(withLine5()) });
		const restated = introduced("changed 5", 5, 5, {
			...overrides,
			...(overrides.file === undefined
				? {}
				: {
						evidence: [{ file: "c.ts", startLine: 5, role: "cause", revision: "head", snippet: "changed 5" }],
						trigger: { file: "c.ts", index: 0, snippet: "changed 5" },
					}),
		});
		expect(await predecessorsAt(h2, restated)).toEqual([]);
	});

	it("offers nothing to a defect whose merged lens claims hold another rule beside the root's", async () => {
		await dismissRoot();
		const h2 = step(withLine5(), { "b.ts": "other\n" });
		const restated = introduced("changed 5", 5, 5);
		const beside = introduced("changed 5", 5, 5, { rule: "other-rule", source: contracts, severity: "P3" });
		expect(await predecessorsAt(h2, restated, [beside])).toEqual([]);
	});

	it("opens over a root conversation that holds no findings yet", async () => {
		const { state, key, revision } = await reviewOf(h1);
		const predecessors = await Predecessors.open(harness, root, key, state, context);
		const [defect] = new Merge([introduced("changed 5", 5, 5)], defaultConfig, revision).defects();
		expect(await predecessors.of(defect!)).toEqual([]);
	});

	it("offers nothing to a defect a deterministic check also reported", async () => {
		await dismissRoot();
		const h2 = step(withLine5(), { "b.ts": "other\n" });
		const restated = introduced("changed 5", 5, 5);
		const statically = Finding.from({
			...restated.toJSON(),
			properties: { ...restated.properties, source: { check: "static.biome", version: "2" } },
		});
		expect(await predecessorsAt(h2, restated, [statically])).toEqual([]);
	});

	it("offers nothing to an injection attempt, even of a dismissed injection attempt", async () => {
		await dismissRoot(introduced("changed 5\nline 6", 5, 6, { rule: injectionAttemptRuleId, severity: "P1" }));
		const h2 = step(withLine5(), { "b.ts": "other\n" });
		expect(
			await predecessorsAt(h2, introduced("changed 5", 5, 5, { rule: injectionAttemptRuleId, severity: "P1" })),
		).toEqual([]);
	});

	it("offers nothing for a root dismissed without a recorded severity", async () => {
		await dismissRoot(undefined, null);
		const h2 = step(withLine5(), { "b.ts": "other\n" });
		expect(await predecessorsAt(h2, introduced("changed 5", 5, 5))).toEqual([]);
	});

	it("offers nothing when the root's accepted trigger is no hunk of its file at this revision", async () => {
		await dismissRoot();
		const h2 = step([...ten.slice(0, 4), "changed 5 again", ...ten.slice(5)]);
		expect(
			await predecessorsAt(
				h2,
				introduced("changed 5 again", 5, 5, { trigger: { file: "a.ts", index: 0, snippet: "changed 5 again" } }),
			),
		).toEqual([]);
	});

	it("offers an affected root only while every hunk its proof accepted is here, and holds the restatement's proof", async () => {
		const { state } = await reviewOf(h1);
		const proof = state.files.flatMap((file) => file.hunks.map(provingHunk));
		const affected = (snippet: string, startLine: number, hunks = proof) =>
			lens({
				snippet,
				startLine,
				cause: "affected",
				evidence: [
					{ file: "a.ts", startLine: 5, role: "cause", revision: "head", proves: true, snippet: "changed 5" },
				],
				trigger: { file: "a.ts", index: 0, snippet: "changed 5", proof: hunks },
			});
		const found = affected("line 8", 8);
		const { key } = await reviewOf(h1);
		await commit(async (tx) => {
			await upsertFinding(tx, root, found, key, proof);
			await dismissFinding(tx, root, found.id, dismissal, key, "P2");
		});
		const h2 = step(withLine5(), { "b.ts": "other\n" });
		expect(await predecessorsAt(h2, affected("line 8\nline 9", 8))).toEqual([found.id]);
		// A restatement proved by a hunk the root's proof never accepted asks a question the dismissal did not answer.
		const h3 = step([...withLine5().slice(0, 9), "changed 10"], { "b.ts": "other\n" });
		const { state: third } = await reviewOf(h3);
		const wider = third.files.flatMap((file) => file.hunks.map(provingHunk));
		expect(await predecessorsAt(h3, affected("line 8 wider", 8, wider))).toEqual([]);
		// Once the accepted hunk is gone, the dismissal no longer stands here.
		const h4 = step([...ten.slice(0, 4), "changed 5 again", ...ten.slice(5)]);
		const { state: fourth } = await reviewOf(h4);
		expect(
			await predecessorsAt(
				h4,
				affected(
					"line 8",
					8,
					fourth.files.flatMap((file) => file.hunks.map(provingHunk)),
				),
			),
		).toEqual([]);
	});

	it.each([
		{
			name: "a line changed beside the root's region",
			rows: () => [...withLine5().slice(0, 6), "changed 7", ...ten.slice(7)],
		},
		{
			name: "a line inserted beside the root's region",
			rows: () => [...withLine5().slice(0, 6), "inserted", ...ten.slice(6)],
		},
		{ name: "a line deleted beside the root's region", rows: () => [...withLine5().slice(0, 6), ...ten.slice(7)] },
	])("offers nothing after $name", async ({ rows }) => {
		await dismissRoot();
		const h2 = step(rows());
		expect(await predecessorsAt(h2, introduced("changed 5", 5, 5))).toEqual([]);
	});

	it("offers nothing when a change touches the restatement's own region, even clear of the root's", async () => {
		await dismissRoot(introduced("changed 5", 5, 5));
		const h2 = step([...withLine5().slice(0, 7), "changed 8", ...ten.slice(8)]);
		expect(await predecessorsAt(h2, introduced("changed 5\nline 6\nline 7", 5, 7))).toEqual([]);
	});

	it("offers nothing when git cannot read the head that last showed the root", async () => {
		const found = introduced("changed 5\nline 6", 5, 6);
		const gone = Revision.key({ base, head: "0123456789abcdef0123456789abcdef01234567" });
		await commit(async (tx) => {
			await upsertFinding(tx, root, found, gone);
			await dismissFinding(tx, root, found.id, dismissal, gone, "P2");
		});
		const h2 = step(withLine5(), { "b.ts": "other\n" });
		expect(await predecessorsAt(h2, introduced("changed 5", 5, 5))).toEqual([]);
	});

	it("never offers a member of the defect as its own root", async () => {
		const found = await dismissRoot(introduced("changed 5", 5, 5));
		const h2 = step(withLine5(), { "b.ts": "other\n" });
		const live = introduced("changed 5", 5, 5, { source: contracts });
		expect(live.id).toBe(found.id);
		// The root's own ID sighted again is the defect, and a lifecycle dismissal already speaks for it.
		const { state, key, revision } = await reviewOf(h2);
		await commit((tx) => upsertFinding(tx, root, live, key));
		const findings = await readFindings(harness, root, key, context, { asReported: true });
		const [defect] = new Merge(findings, defaultConfig, revision).defects();
		expect(await (await Predecessors.open(harness, root, key, state, context)).of(defect!)).toEqual([]);
	});
});

it("reads two sightings as one site only for one path and rule on overlapping lines", () => {
	const site = { path: "a.ts", ruleId: "fail-open", line: 5, endLine: 6 };
	expect(overlapsSite(site, { ...site, line: 6, endLine: 9 })).toBe(true);
	expect(overlapsSite(site, { ...site, line: 7, endLine: 9 })).toBe(false);
	expect(overlapsSite(site, { ...site, line: 1, endLine: 4 })).toBe(false);
	expect(overlapsSite(site, { ...site, path: "b.ts" })).toBe(false);
	expect(overlapsSite(site, { ...site, ruleId: "other" })).toBe(false);
});

it("lists every maintainer's dismissal with a recorded severity, in ID order, and nothing else", async () => {
	const [one, two, live, legacy, cleared] = ["one", "two", "live", "legacy", "cleared"].map((snippet) =>
		lens({ snippet }),
	);
	const roots = [one!, two!].sort((a, b) => (a.id < b.id ? 1 : -1));
	await commit(async (tx) => {
		for (const each of [...roots, live!, legacy!, cleared!]) await upsertFinding(tx, root, each, "base..first");
		for (const each of roots) await dismissFinding(tx, root, each.id, dismissal, "base..first", "P2");
		await dismissFinding(tx, root, legacy!.id, dismissal, "base..first");
		await upsertFinding(tx, root, cleared!, "base..second");
		await dismissFinding(tx, root, cleared!.id, dismissal, "base..second", "P2");
		await clearSightings(tx, root, "base..second", [correctness]);
	});
	const state = (await harness.snapshot(FindingsDocument, root, context))!;
	const expected = [...roots]
		.sort((a, b) => (a.id < b.id ? -1 : 1))
		.map((each) => ({
			id: each.id,
			ruleId: "fail-open",
			path: "a.ts",
			cause: "pre-existing",
			line: 5,
			endLine: 5,
			revision: "base..first",
			dismissedAt: dismissal.at,
			severity: "P2",
			hash: state.items[each.id]!.lifecycle.dismissedTrigger!.hash,
			accepted: [],
			proof: [],
			failureScenario: "A cold run reads a cached kill.",
			evidence: each.properties.evidence,
		}));
	expect(Object.keys(state.items).slice(0, 2)).not.toEqual(expected.map((each) => each.id));
	expect(dismissedRoots(state)).toStrictEqual(expected);
});

it("names a root's failure scenario and evidence only when it has them, and keeps its accepted proof apart", async () => {
	const proof = [{ file: "a.ts", hash: "1".repeat(64) }];
	const later = [{ file: "b.ts", hash: "2".repeat(64) }];
	const bare = Finding.create({
		rule: "guardrail/forbidden-paths",
		file: "a.ts",
		startLine: 1,
		discriminator: "path",
		severity: "P2",
		cause: "introduced",
		message: "Forbidden path.",
		source: { check: "guardrails" },
		explanation: { what: "What", whyHere: "Why", whatToDo: "Fix" },
	});
	const affected = (hunks: typeof proof) =>
		lens({
			snippet: "affected",
			startLine: 8,
			cause: "affected",
			evidence: [{ file: "a.ts", startLine: 5, role: "cause", revision: "head", proves: true, snippet: "x" }],
			trigger: { file: "a.ts", index: 0, snippet: "x", proof: hunks },
		});
	await commit(async (tx) => {
		await upsertFinding(tx, root, bare, "base..first");
		await dismissFinding(tx, root, bare.id, dismissal, "base..first", "P2");
		await upsertFinding(tx, root, affected(proof), "base..first", proof);
		await dismissFinding(tx, root, affected(proof).id, dismissal, "base..first", "P2");
		// A later sighting proved by one more hunk, which does not reopen the dismissal, widens the proof alone.
		await upsertFinding(tx, root, affected([...proof, ...later]), "base..second", [...proof, ...later]);
	});
	const state = (await harness.snapshot(FindingsDocument, root, context))!;
	expect(state.items[affected(proof).id]!.lifecycle.status).toBe("dismissed");
	const listed = Object.fromEntries(dismissedRoots(state).map((each) => [each.id, each]));
	expect(Object.keys(listed[bare.id]!)).not.toContain("failureScenario");
	expect(Object.keys(listed[bare.id]!)).not.toContain("evidence");
	expect(listed[affected(proof).id]).toMatchObject({ accepted: proof, proof: [...proof, ...later] });
});
