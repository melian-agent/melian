import {
	type ChangedFile,
	ExternalFinding,
	type ExternalFindingInput,
	Finding,
	Revision,
	type Verification,
} from "@melian-agent/core";
import { MissCause, MissLines, type Stage } from "@melian-agent/pipeline";
import { describe, expect, it } from "vitest";

const file = "src/user.ts";
const coverage = { scope: "", paths: ["**"], nearer: [] };

const hunk = (newStart: number, newLines: number) => ({
	file,
	index: 0,
	oldStart: newStart,
	oldLines: 0,
	newStart,
	newLines,
	header: "",
	text: "",
});
const changed = (...hunks: ReturnType<typeof hunk>[]): ChangedFile => ({
	status: "modified",
	path: file,
	binary: false,
	hunks,
});
// The diff shows lines 9 to 11 of the file.
const revision = Revision.from({ base: "b".repeat(40), head: "c".repeat(40), files: [changed(hunk(9, 3))] });
// The diff shows only lines 20 and 21, away from the miss.
const elsewhere = Revision.from({ base: "b".repeat(40), head: "c".repeat(40), files: [changed(hunk(20, 2))] });

function miss(input: Partial<ExternalFindingInput> = {}): ExternalFinding {
	return ExternalFinding.create({
		reviewer: { name: "codex" },
		file,
		line: 10,
		title: "a miss",
		body: "body",
		source: { kind: "file", path: "codex.json", position: 0 },
		...input,
	});
}

function lens(conversation: number, overrides: Partial<Stage> = {}): Stage {
	return {
		id: `conversation:${conversation}`,
		name: "melian.lens",
		subject: "correctness@1@careful",
		task: 7,
		conversation,
		outcome: "completed",
		timing: "available",
		reused: false,
		resumed: false,
		coverage,
		shown: [],
		...overrides,
	};
}

const verification = (verdict: Verification["verdict"]): Verification => ({
	verdict,
	reason: "Traced the code.",
	executor: "llm",
	model: "faux/judge",
	version: "1",
});

function reported(
	options: { start?: number; end?: number; check?: string; path?: string; verdict?: Verification["verdict"] } = {},
): Finding {
	const made = Finding.create({
		rule: "null-deref",
		file: options.path ?? file,
		startLine: options.start ?? 10,
		endLine: options.end ?? options.start ?? 10,
		snippet: `line ${options.start ?? 10} ${options.check ?? ""}`,
		occurrence: 0,
		severity: "P1",
		cause: "introduced",
		message: "A null user",
		source: { check: options.check ?? "lens.correctness", version: "1" },
		explanation: { what: "Null", whyHere: "New read", whatToDo: "Check it" },
	}).toJSON();
	return Finding.from({
		...made,
		properties: {
			...made.properties,
			...(options.verdict === undefined ? {} : { verification: verification(options.verdict) }),
		},
	});
}

const cause = (stages: readonly Stage[], findings: readonly Finding[] = [], external = miss(), diff = revision) =>
	MissCause.of(external, findings, { stages, revision: diff })!.firstRead;

describe("MissCause", () => {
	it("reads `no record` for a round whose telemetry this storage does not hold", () => {
		const sighting = reported({ verdict: "refuted" });
		expect(MissCause.of(miss(), [sighting])?.toJSON()).toEqual({
			firstRead: "no record",
			runs: [],
			sightings: [
				{
					id: sighting.properties.id,
					finding: sighting.id,
					check: "lens.correctness",
					rule: "null-deref",
					verification: "refuted",
				},
			],
		});
	});

	it("reads `no record` when every lens run lacks what its prompt was shown, as an older Melian's do", () => {
		const { shown: _, ...older } = lens(1);
		expect(cause([older], [reported()])).toBe("no record");
		expect(cause([older, { ...older, id: "conversation:2", conversation: 2 }])).toBe("no record");
		// One run that records it is enough to read the rest.
		expect(cause([older, lens(2)])).toBe("never shown");
		// A lens task with no conversation, and a check, are not runs whose prompt could record it.
		expect(cause([lens(1), { ...older, conversation: undefined }])).toBe("never shown");
		expect(cause([{ ...older, conversation: undefined }])).toBe("not covered");
		expect(cause([{ ...older, name: "melian.check" }])).toBe("not covered");
	});

	it("reads `not covered` when no lens run's coverage holds the file", () => {
		const stages = [
			lens(1, { coverage: { ...coverage, paths: ["docs/**"] } }),
			lens(2, { coverage: undefined }),
			lens(3, { conversation: undefined, shown: [file] }),
			lens(4, { name: "melian.verification", shown: [file] }),
		];
		expect(MissCause.of(miss(), [], { stages, revision })?.toJSON()).toEqual({
			firstRead: "not covered",
			runs: [],
			sightings: [],
		});
		expect(cause([])).toBe("not covered");
	});

	it("reads `cut short` when every covering run ended before completing, and was never shown the lines", () => {
		expect(cause([lens(1, { outcome: "ended", ended: "tokens" })])).toBe("cut short");
		expect(cause([lens(1, { outcome: "failed" }), lens(2, { outcome: "ended", ended: "tools" })])).toBe("cut short");
	});

	it("reads `never shown` when a covering run completed without being shown or reading the lines", () => {
		expect(cause([lens(1)])).toBe("never shown");
		expect(cause([lens(1, { outcome: "ended", ended: "tokens" }), lens(2)])).toBe("never shown");
		expect(cause([lens(1, { shown: ["src/other.ts"] })])).toBe("never shown");
		// Shown the file whole, but its diff holds none of the lines.
		expect(cause([lens(1, { shown: [file] })], [], miss(), elsewhere)).toBe("never shown");
		// A prober runs probes, not a review, so the lines it was shown are not a lens's sight of them.
		expect(cause([lens(1), lens(2, { role: "prober", shown: [file] })])).toBe("never shown");
		expect(cause([lens(1, { role: "prober", shown: [file] })])).toBe("not covered");
		expect(cause([lens(1, { role: "planner", shown: [file] })])).toBe("seen, not reported");
	});

	it("reads `seen, not reported` when a covering run was shown the lines, and no lens reported there", () => {
		expect(cause([lens(1, { shown: [file] })])).toBe("seen, not reported");
		expect(cause([lens(1), lens(2, { shown: [file] })])).toBe("seen, not reported");
		// A run the budget cut that saw them still saw them.
		expect(cause([lens(1, { outcome: "ended", ended: "tokens", shown: [file] })])).toBe("seen, not reported");
	});

	it("reads `seen, not reported` for a run that read a line of the miss, at either end and none past", () => {
		const read = (path: string, first: number, last: number) =>
			lens(1, { read: [{ path, ranges: [[first, last]] }] });
		const wide = miss({ line: 10, endLine: 12 });
		expect(cause([read(file, 12, 14)], [], wide, elsewhere)).toBe("seen, not reported");
		expect(cause([read(file, 5, 10)], [], wide, elsewhere)).toBe("seen, not reported");
		expect(cause([read(file, 13, 20)], [], wide, elsewhere)).toBe("never shown");
		expect(cause([read(file, 1, 9)], [], wide, elsewhere)).toBe("never shown");
		expect(cause([read("src/other.ts", 10, 12)], [], wide, elsewhere)).toBe("never shown");
		const twice = lens(1, {
			read: [
				{ path: "src/other.ts", ranges: [[10, 12]] },
				{
					path: file,
					ranges: [
						[1, 2],
						[11, 11],
					],
				},
			],
		});
		expect(cause([twice], [], wide, elsewhere)).toBe("seen, not reported");
	});

	it("reads a miss with no line GitHub still places against the whole file", () => {
		for (const external of [miss({ line: undefined }), miss({ outdated: true }), miss({ revision: "base" })]) {
			expect(cause([lens(1, { shown: [file] })], [], external, elsewhere)).toBe("seen, not reported");
			expect(cause([lens(1, { read: [{ path: file, ranges: [[40, 41]] }] })], [], external, elsewhere)).toBe(
				"seen, not reported",
			);
			expect(cause([lens(1)], [], external, elsewhere)).toBe("never shown");
			expect(cause([lens(1)], [reported({ start: 90 })], external, elsewhere)).toBe("reported, not matched");
		}
	});

	it("reads `reported, refuted` when every lens claim at the lines was refuted", () => {
		expect(cause([lens(1)], [reported({ verdict: "refuted" })])).toBe("reported, refuted");
		expect(
			cause([lens(1)], [reported({ verdict: "refuted" }), reported({ start: 9, end: 11, verdict: "refuted" })]),
		).toBe("reported, refuted");
	});

	it("reads `reported, not matched` when a lens claim at the lines stood, or no verifier judged it", () => {
		expect(cause([lens(1)], [reported()])).toBe("reported, not matched");
		expect(cause([lens(1)], [reported({ verdict: "plausible" })])).toBe("reported, not matched");
		expect(
			cause([lens(1)], [reported({ verdict: "refuted" }), reported({ start: 9, end: 11, verdict: "confirmed" })]),
		).toBe("reported, not matched");
		// A claim outranks what the telemetry says, even with no covering run.
		expect(cause([], [reported()])).toBe("reported, not matched");
	});

	it("counts as a sighting only a lens's finding at the file whose lines meet the miss's", () => {
		const wide = miss({ line: 10, endLine: 12 });
		expect(cause([lens(1)], [reported({ start: 12, end: 14 })], wide)).toBe("reported, not matched");
		expect(cause([lens(1)], [reported({ start: 8, end: 10 })], wide)).toBe("reported, not matched");
		expect(cause([lens(1)], [reported({ start: 13, end: 15 })], wide)).toBe("never shown");
		expect(cause([lens(1)], [reported({ start: 5, end: 9 })], wide)).toBe("never shown");
		expect(cause([lens(1)], [reported({ path: "src/other.ts" })], wide)).toBe("never shown");
		expect(cause([lens(1)], [reported({ check: "static.biome" })], wide)).toBe("never shown");
	});

	it("has no cause for a miss with no file", () => {
		expect(MissCause.of(miss({ file: undefined }), [], { stages: [lens(1)], revision })).toBeUndefined();
	});

	it("records each covering run but a prober, and each sighting, as IDs and numbers, once each", () => {
		const sighting = reported({ verdict: "refuted" });
		const lowered = reported({ start: 11 });
		const stored = lowered.toJSON();
		const withLowered = Finding.from({
			...stored,
			properties: {
				...stored.properties,
				verification: {
					...verification("confirmed"),
					lowered: { from: "P1", to: "P2", reason: "Guarded upstream." },
				},
			},
		});
		const stages = [
			lens(1, {
				subject: "trust-boundary@2@deep",
				role: "planner",
				outcome: "ended",
				ended: "tools",
				shown: [file],
				read: [
					{ path: file, ranges: [[8, 10]] },
					{ path: "src/other.ts", ranges: [[1, 9]] },
				],
			}),
			lens(2, { subject: "trust-boundary@2@deep", role: "prober", shown: undefined }),
			lens(3, { coverage: { ...coverage, paths: ["docs/**"] } }),
		];
		expect(
			MissCause.of(miss({ line: 10, endLine: 11 }), [sighting, sighting, withLowered], {
				stages,
				revision,
			})?.toJSON(),
		).toEqual({
			firstRead: "reported, not matched",
			runs: [
				{
					lens: "trust-boundary@2",
					level: "deep",
					role: "planner",
					stage: "conversation:1",
					conversation: 1,
					ended: "tools",
					shownWhole: true,
					read: [[10, 10]],
				},
			],
			sightings: [
				{
					id: sighting.properties.id,
					finding: sighting.id,
					check: "lens.correctness",
					rule: "null-deref",
					verification: "refuted",
				},
				{
					id: withLowered.properties.id,
					finding: withLowered.id,
					check: "lens.correctness",
					rule: "null-deref",
					verification: "confirmed",
					lowered: true,
				},
			],
		});
	});

	it("records every lens claim a merged sighting carries, and no check's", () => {
		const own = reported();
		const stored = own.toJSON();
		const other = { id: "a".repeat(16), ruleId: "x", source: { check: "lens.tests", version: "1" } };
		const merged = Finding.from({
			...stored,
			properties: {
				...stored.properties,
				failureScenario: "A null user reaches the read.",
				otherClaims: [
					other,
					{ id: "b".repeat(16), ruleId: "x", source: { check: "static.tsc", version: "1" } },
					{ ...other, verification: verification("refuted") },
				],
			},
		});
		expect(MissCause.of(miss(), [merged], { stages: [], revision })?.sightings).toEqual([
			{
				id: own.properties.id,
				finding: own.id,
				check: "lens.correctness",
				rule: "null-deref",
				verification: "unverified",
			},
			{ id: "a".repeat(16), finding: own.id, check: "lens.tests", rule: "x", verification: "unverified" },
		]);
	});
});

describe("MissLines", () => {
	it("delivers the read lines of the file cut to the ranges, or whole for a miss with none", () => {
		const stage = lens(1, {
			read: [
				{
					path: file,
					ranges: [
						[1, 4],
						[8, 20],
					],
				},
				{ path: "src/other.ts", ranges: [[1, 99]] },
			],
		});
		expect(
			MissLines.of(file, [
				[3, 9],
				[12, 12],
			]).delivered(stage),
		).toEqual([
			[3, 4],
			[8, 9],
			[12, 12],
		]);
		expect(MissLines.of(file, [[5, 7]]).delivered(stage)).toEqual([]);
		expect(MissLines.of(file).delivered(stage)).toEqual([
			[1, 4],
			[8, 20],
		]);
		expect(MissLines.of(file).delivered(lens(2))).toEqual([]);
	});

	it("knows a prompt that carried the file whole showed a range only from the diff it was given", () => {
		const shown = lens(1, { shown: [file] });
		expect(MissLines.of(file, [[10, 10]], revision).saw(shown)).toBe(true);
		expect(MissLines.of(file, [[10, 10]], elsewhere).saw(shown)).toBe(false);
		expect(MissLines.of(file, [[10, 10]]).saw(shown)).toBe(false);
		expect(MissLines.of(file, undefined, elsewhere).saw(shown)).toBe(true);
		expect(MissLines.of(file).shownWhole(lens(2, { shown: undefined }))).toBe(false);
	});
});
