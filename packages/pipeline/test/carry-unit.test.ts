import {
	type ChangedFile,
	Finding,
	type FindingInput,
	type Hunk,
	Revision,
	type Verification,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SightingCarry } from "../src/carry.ts";
import { FindingsDocument, upsertVerification } from "../src/findings.ts";

const hunk = (file: string, index: number, old: [number, number], now: [number, number], text: string): Hunk => ({
	file,
	index,
	oldStart: old[0],
	oldLines: old[1],
	newStart: now[0],
	newLines: now[1],
	header: "",
	text,
});
const changed = (path: string, hunks: Hunk[], extra: Partial<ChangedFile> = {}): ChangedFile => ({
	status: "modified",
	path,
	binary: false,
	hunks,
	...extra,
});
const at = (head: string, files: ChangedFile[]) => Revision.from({ base: "a".repeat(40), head, files });

// The move from H1 to H2: two lines inserted after line 1 of a.ts, line 8 of a.ts rewritten, gone.ts deleted.
const map = at("c".repeat(40), [
	changed("src/a.ts", [
		hunk("src/a.ts", 0, [1, 0], [2, 2], "+x\n+y"),
		hunk("src/a.ts", 1, [8, 1], [10, 1], "-a 8\n+A 8"),
	]),
	changed("src/gone.ts", [hunk("src/gone.ts", 0, [1, 4], [0, 0], "-g")], { status: "deleted" }),
]);
// The whole diff at H2: base to H2, where a.ts lines 2-3 and 10 are new.
const whole = at("c".repeat(40), [
	changed("src/a.ts", [
		hunk("src/a.ts", 0, [1, 0], [2, 2], "+x\n+y"),
		hunk("src/a.ts", 1, [8, 1], [10, 1], "-a 8\n+A 8"),
	]),
]);

const input = (overrides: Partial<FindingInput>): FindingInput => ({
	rule: "null-dereference",
	message: "m",
	file: "src/a.ts",
	startLine: 5,
	snippet: "a 5",
	occurrence: 0,
	cause: "pre-existing",
	severity: "P2",
	source: { check: "lens.correctness", version: "1@careful" },
	failureScenario: "It throws.",
	explanation: { what: "w", whyHere: "h", whatToDo: "t" },
	...overrides,
});
const confirmed: Verification = {
	verdict: "confirmed",
	reason: "r",
	executor: "llm",
	model: "faux/judge",
	version: "1",
};

let harness: Harness;
let root: Awaited<ReturnType<Harness["root"]>>["id"];

beforeEach(async () => {
	const fake = createFakeModels();
	harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createReviewRegistry() });
	root = (await harness.root(context, { agent: { model: fake.ref() } })).id;
});

afterEach(async () => {
	await harness.close(context);
});

const store = async (findings: Finding[], revision: string, verified: Finding[] = []) =>
	(await harness.root(context)).commit(async (tx) => {
		for (const finding of findings) await upsertFinding(tx, root, finding, revision);
		for (const finding of verified)
			await upsertVerification(tx, root, revision, finding.id, finding.properties.source, confirmed);
	}, context);
const document = async () => (await harness.snapshot(FindingsDocument, root, context))!;
const still = at("c".repeat(40), []);
const carry = (from: string, to: string, round = "r1", move = map) =>
	new SightingCarry(harness, root).carry({ from, round, to, revision: whole, map: move }, context);

describe("SightingCarry.carry", () => {
	it("moves a lens sighting and its evidence, keeps its verification, and carries no deterministic one", async () => {
		const moved = Finding.create(
			input({
				evidence: [
					{ file: "src/a.ts", startLine: 6, endLine: 7, role: "context", revision: "head", snippet: "a 6" },
					{ file: "src/a.ts", startLine: 3, role: "context", revision: "base", snippet: "a 3" },
					{ file: "src/gone.ts", startLine: 2, role: "context", revision: "head", snippet: "g 2" },
				],
			}),
		);
		const guardrail = Finding.create(input({ rule: "guardrail/x/y", source: { check: "guardrails", version: "1" } }));
		await store([moved, guardrail], "B..H1", [moved]);
		const result = await carry("B..H1", "B..H2");
		expect(result).toEqual({
			carried: [
				{ id: moved.id, source: { check: "carried/lens.correctness", version: "1@careful" }, changed: false },
			],
			lost: [],
		});
		const record = (await document()).items[moved.id]!;
		const copy = record.sightings["B..H2"]!["carried/lens.correctness@1@careful"]!;
		expect(copy.properties.path).toBe("src/a.ts");
		expect(copy.locations[0]!.physicalLocation.region.startLine).toBe(7);
		expect(copy.locations[0]!.physicalLocation.region.endLine).toBeUndefined();
		expect(copy.properties.evidence).toEqual([
			{ file: "src/a.ts", startLine: 8, endLine: 9, role: "context", revision: "head", snippet: "a 6" },
			{ file: "src/a.ts", startLine: 3, role: "context", revision: "base", snippet: "a 3" },
		]);
		expect(copy.properties.trigger).toBeUndefined();
		expect(record.carried?.["B..H2"]).toEqual({ "carried/lens.correctness@1@careful": { from: "r1" } });
		expect(record.verifications?.["B..H2"]?.["carried/lens.correctness@1@careful"]).toEqual(
			record.verifications?.["B..H1"]?.["lens.correctness@1@careful"],
		);
		expect((await document()).items[guardrail.id]!.sightings["B..H2"]).toBeUndefined();
	});

	it("marks a sighting whose lines the move changed, places it after the hunk, gives it the head's trigger, and copies no verdict", async () => {
		const edited = Finding.create(input({ startLine: 8, endLine: 8, snippet: "a 8" }));
		await store([edited], "B..H1", [edited]);
		const result = await carry("B..H1", "B..H2");
		expect(result.carried).toEqual([expect.objectContaining({ id: edited.id, changed: true })]);
		const record = (await document()).items[edited.id]!;
		const copy = record.sightings["B..H2"]!["carried/lens.correctness@1@careful"]!;
		expect(copy.locations[0]!.physicalLocation.region).toMatchObject({ startLine: 11, endLine: 11 });
		expect(copy.properties.evidence).toEqual(edited.properties.evidence);
		expect(record.carried?.["B..H2"]).toEqual({
			"carried/lens.correctness@1@careful": { from: "r1", changed: true },
		});
		expect(record.verifications?.["B..H2"]).toBeUndefined();
		const introduced = Finding.create(input({ startLine: 1, snippet: "a 1" }));
		await store([introduced], "B..H3");
		const map2 = at("d".repeat(40), []);
		await new SightingCarry(harness, root).carry(
			{ from: "B..H3", round: "r3", to: "B..H4", revision: whole, map: map2 },
			context,
		);
		const lifted = (await document()).items[introduced.id]!.sightings["B..H4"]![
			"carried/lens.correctness@1@careful"
		]!;
		expect(lifted.properties.cause).toBe("pre-existing");
		const onHunk = Finding.create(input({ startLine: 2, snippet: "x" }));
		await store([onHunk], "B..H5");
		await new SightingCarry(harness, root).carry(
			{ from: "B..H5", round: "r5", to: "B..H6", revision: whole, map: map2 },
			context,
		);
		const triggered = (await document()).items[onHunk.id]!.sightings["B..H6"]!["carried/lens.correctness@1@careful"]!;
		expect(triggered.properties.cause).toBe("introduced");
		expect(triggered.properties.trigger).toMatchObject({ file: "src/a.ts", index: 0, snippet: "x\ny" });
	});

	it("loses a sighting in a file the move deleted, keeps the first round across heads, and lists each revision once", async () => {
		const lost = Finding.create(input({ file: "src/gone.ts", startLine: 2, snippet: "g 2" }));
		const kept = Finding.create(input({ startLine: 5, endLine: 6 }));
		await store([lost, kept], "B..H1");
		expect((await carry("B..H1", "B..H2")).lost).toEqual([lost.id]);
		const before = (await document()).versions["B..H2"] ?? 0;
		await carry("B..H2", "B..H3", "r2", still);
		await carry("B..H2", "B..H3", "r2", still);
		const state = await document();
		expect(state.revisions.filter((each) => each === "B..H3")).toHaveLength(1);
		expect(state.versions["B..H3"]).toBe(2);
		expect(before).toBe(1);
		const record = state.items[kept.id]!;
		expect(Object.keys(record.sightings["B..H3"]!)).toEqual(["carried/lens.correctness@1@careful"]);
		expect(record.carried?.["B..H3"]).toEqual({ "carried/lens.correctness@1@careful": { from: "r1" } });
		expect(
			record.sightings["B..H3"]!["carried/lens.correctness@1@careful"]!.locations[0]!.physicalLocation.region,
		).toMatchObject({
			startLine: 7,
			endLine: 8,
		});
	});
});

describe("SightingCarry.clear", () => {
	it("deletes only the carried sightings at the revision, their verdicts and marks, and counts a change once", async () => {
		const finding = Finding.create(input({}));
		await store([finding], "B..H1", [finding]);
		await carry("B..H1", "B..H2");
		await store([finding], "B..H2", [finding]);
		const other = Finding.create(input({ startLine: 6, snippet: "a 6" }));
		await store([other], "B..H1");
		await carry("B..H1", "B..H2");
		const before = (await document()).versions["B..H2"]!;
		await new SightingCarry(harness, root).clear("B..H2", context);
		let state = await document();
		expect(Object.keys(state.items[finding.id]!.sightings["B..H2"]!)).toEqual(["lens.correctness@1@careful"]);
		expect(Object.keys(state.items[finding.id]!.verifications!["B..H2"]!)).toEqual(["lens.correctness@1@careful"]);
		expect(state.items[finding.id]!.carried?.["B..H2"]).toEqual({});
		expect(state.items[other.id]!.sightings["B..H2"]).toBeUndefined();
		expect(state.items[other.id]!.sightings["B..H1"]).toBeDefined();
		expect(state.versions["B..H2"]).toBe(before + 1);
		await new SightingCarry(harness, root).clear("B..H2", context);
		await new SightingCarry(harness, root).clear("B..H9", context);
		state = await document();
		expect(state.versions["B..H2"]).toBe(before + 1);
		expect(state.versions["B..H9"]).toBeUndefined();
	});
});
