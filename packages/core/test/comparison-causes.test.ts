import {
	Adjudication,
	Comparison,
	type ComparisonEntry,
	ComparisonExport,
	ComparisonSet,
	defaultConfig,
	ExternalFinding,
	type ExternalFindingInput,
	type MissCauseRecord,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const base = "a".repeat(40);
const head = "b".repeat(40);
const by = { by: "Ada <ada@example.com>", at: "2026-11-21T01:00:00Z" };
let sequence = 0;
const report = (input: Partial<ExternalFindingInput> = {}) =>
	ExternalFinding.create({
		reviewer: { name: "codex" },
		file: "src/run.ts",
		line: 12,
		title: "Null manager",
		body: "First paragraph.",
		source: { kind: "file", path: "codex.json", position: sequence, ref: String(sequence++) },
		...input,
	});

function entry(
	externals: ExternalFinding[],
	causes?: Record<string, MissCauseRecord>,
	round = "c.r1",
): ComparisonEntry {
	const comparison = Comparison.of({ base, head });
	comparison.import("file:codex.json", { findings: externals, skippedBodies: 0 }, by.at);
	const verdict = new Adjudication({ findings: [], checks: [], manifest: [], config: defaultConfig }).adjudicate();
	comparison.compare(verdict);
	return { changeset: "c", round, comparison, verdict, ...(causes === undefined ? {} : { causes }) };
}

const valid = (record: ComparisonEntry, ...findings: ExternalFinding[]) => {
	for (const finding of findings)
		record.comparison.adjudicate(finding.id, { ...by, verdict: "valid", reason: "needs-execution" });
	return record;
};

const read = (firstRead: MissCauseRecord["firstRead"], extra: Partial<MissCauseRecord> = {}): MissCauseRecord => ({
	firstRead,
	runs: [],
	sightings: [],
	...extra,
});

const facts: MissCauseRecord = {
	firstRead: "reported, refuted",
	runs: [
		{
			lens: "trust-boundary@2",
			level: "deep",
			role: "planner",
			stage: "conversation:4",
			conversation: 4,
			ended: "tools",
			shownWhole: true,
			read: [
				[12, 12],
				[14, 16],
			],
		},
		{
			lens: "correctness@1",
			level: "careful",
			stage: "conversation:5",
			conversation: 5,
			ended: "completed",
			shownWhole: false,
			read: [],
		},
	],
	sightings: [
		{
			id: "1".repeat(16),
			finding: "2".repeat(16),
			check: "lens.correctness",
			rule: "null-deref",
			verification: "refuted",
			lowered: true,
		},
	],
};

describe("ComparisonExport first reads", () => {
	it("records each round's first reads in JSON under a note that dates them to the export", () => {
		const miss = report();
		const first = valid(entry([miss], { [miss.id]: facts }), miss);
		const later = valid(entry([miss], { [miss.id]: read("never shown") }, "c.r2"), miss);
		expect(JSON.parse(new ComparisonExport([first, later], "range").renderJson()).missCauses).toEqual({
			note: "Melian's first read of each valid miss, computed from the round's own records when this record was exported. A later rule can change it. It is not a person's reason.",
			rounds: { "c.r1": { [miss.id]: facts }, "c.r2": { [miss.id]: read("never shown") } },
		});
	});

	it("records no first reads when no attributed entry carries one", () => {
		const miss = report();
		const entries = [
			entry([miss]),
			entry([miss], {}),
			{ ...entry([miss], { [miss.id]: facts }), unattributed: `${base}..${head}`, verdict: undefined },
		];
		const record = new ComparisonExport(entries, "range");
		expect(JSON.parse(record.renderJson())).not.toHaveProperty("missCauses");
		expect(record.render()).not.toContain("first read");
	});

	it("writes each first read beside the miss's row, with every run's and sighting's facts", () => {
		const miss = report();
		const other = report({ line: 40 });
		const text = new ComparisonExport(
			[valid(entry([miss, other], { [miss.id]: facts, [other.id]: read("not covered") }), miss, other)],
			"range",
		).render();
		const section = text.split("## Melian's first read of each miss\n\n")[1]!.split("\n## ")[0]!;
		expect(section.split("\n").filter((line) => line !== "")).toEqual([
			"Melian's first read of each valid miss, computed from the round's own records when this record was exported. A later rule can change it. It is not a person's reason.",
			`- A1, ${miss.id}, c.r1: reported, refuted. Covering runs: trust-boundary@\u20602 deep planner, conversation:4: tools, shown the file whole, read lines 12, 14-16; correctness@\u20601 careful, conversation:5: completed, not shown the file whole, read none of its lines. Sightings: ${"1".repeat(16)} of ${"2".repeat(16)}, lens.correctness null-deref: refuted, lowered.`,
			`- A2, ${other.id}, c.r1: not covered. Covering runs: none. Sightings: none.`,
		]);
	});

	it("names a miss its tables do not show by its ID alone, and a round-less entry by its revision", () => {
		const miss = report();
		const record = { ...valid(entry([miss]), miss), causes: { ["9".repeat(16)]: read("no record") } };
		const { round: _, ...roundless } = record;
		const text = new ComparisonExport([roundless], "range").render();
		expect(text).toContain(`- ${"9".repeat(16)}, ${base.slice(0, 12)}..${head.slice(0, 12)}: no record.`);
	});
});

describe("ComparisonSet first-read totals", () => {
	it("counts each defect once, by its first valid finding's read, and counts no other finding", () => {
		const miss = report();
		const again = report({ reviewer: { name: "claude-code" } });
		const noise = report({ line: 80 });
		const pending = report({ line: 120 });
		const record = valid(
			entry([miss, again, noise, pending], {
				[miss.id]: read("cut short"),
				[again.id]: read("never shown"),
				[noise.id]: read("not covered"),
				[pending.id]: read("not covered"),
			}),
			miss,
			again,
		);
		record.comparison.adjudicate(noise.id, { ...by, verdict: "noise" });
		const lone = report({ line: 200 });
		const second = valid(entry([lone], { [lone.id]: read("seen, not reported") }, "c.r2"), lone);
		const set = new ComparisonSet([record, second, { ...second, round: "c.r3", causes: {} }]);
		expect(set.stats().causes).toEqual({
			"not covered": 0,
			"cut short": 1,
			"never shown": 0,
			"seen, not reported": 1,
			"reported, refuted": 0,
			"reported, not matched": 0,
			"no record": 0,
		});
		expect(set.renderStats()).toContain(
			[
				'First read "not covered": 0.',
				'First read "cut short": 1.',
				'First read "never shown": 0.',
				'First read "seen, not reported": 1.',
				'First read "reported, refuted": 0.',
				'First read "reported, not matched": 0.',
				'First read "no record": 0.',
			].join("\n"),
		);
	});

	it("skips a defect whose first valid finding has no read and takes the next one that has", () => {
		const miss = report();
		const again = report({ reviewer: { name: "claude-code" } });
		const set = new ComparisonSet([valid(entry([miss, again], { [again.id]: read("never shown") }), miss, again)]);
		expect(set.stats().causes?.["never shown"]).toBe(1);
	});

	it("gives no totals when no attributed entry was read with first reads", () => {
		const miss = report();
		const set = new ComparisonSet([
			valid(entry([miss]), miss),
			{ ...valid(entry([miss], { [miss.id]: read("cut short") }), miss), unattributed: `${base}..${head}` },
		]);
		expect(set.stats()).not.toHaveProperty("causes");
		expect(set.renderStats()).not.toContain("First read");
	});
});
