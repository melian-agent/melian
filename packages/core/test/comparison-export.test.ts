import {
	Adjudication,
	Comparison,
	type ComparisonEntry,
	ComparisonExport,
	defaultConfig,
	ExternalFinding,
	type ExternalFindingInput,
	Finding,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const base = "a".repeat(40);
const at = "2026-10-05T01:00:00Z";
const by = { by: "Ada <ada@example.com>", at };
const own = (startLine = 12) =>
	Finding.create({ ...evalInput, snippet: `eval(line${startLine})`, startLine, endLine: startLine });
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
const verdictOf = ({ findings }: { findings: readonly Finding[] }) =>
	new Adjudication({ findings, checks: [], manifest: [], config: defaultConfig }).adjudicate();

function entry(
	options: {
		externals?: ExternalFinding[];
		findings?: Finding[];
		head?: string;
		at?: string;
		reviewers?: ExternalFinding["reviewer"][];
	} = {},
): ComparisonEntry {
	const { externals = [], findings = [] } = options;
	const comparison = Comparison.of({ base, head: options.head ?? "b".repeat(40) });
	comparison.import(
		"file:codex.json",
		{
			findings: externals,
			skippedBodies: 0,
			...(options.reviewers === undefined ? {} : { reviewers: options.reviewers }),
		},
		options.at ?? at,
	);
	const verdict = verdictOf({ findings });
	comparison.compare(verdict);
	return { changeset: "c", comparison, verdict };
}
const render = (entries: ComparisonEntry[], target = "range", url?: string) =>
	new ComparisonExport(entries, target, url).render();
const sections = (text: string) => [...text.matchAll(/^## ([A-Z]+)\. (.*)$/gm)].map((each) => `${each[1]} ${each[2]}`);

describe("ComparisonExport header", () => {
	it("lists reviewers in order, with version and login, and links a pull request", () => {
		const text = render(
			[
				entry({
					externals: [report({ reviewer: { name: "codex", version: "6.1" } })],
					reviewers: [
						{ name: "codex", version: "6.1" },
						{ name: "coderabbit", login: "coderabbitai[bot]" },
						{ name: "claude-code" },
					],
				}),
			],
			"#7",
			"https://github.com/o/r/pull/7",
		);
		expect(text).toContain("# Comparison review: pull request [\\#\u20607](https://github.com/o/r/pull/7)");
		expect(text).toContain(
			"Reviewers: claude-code; coderabbit \\(coderabbitai\\[bot\\]\\); codex 6.1; Melian's own review, in 1 stored round.",
		);
	});

	it("names no reviewer when none took part, and counts rounds", () => {
		const comparison = Comparison.of({ base, head: "b".repeat(40) });
		const text = render([{ changeset: "c", comparison }]);
		expect(text).toContain("Reviewers: Melian's own review, in 1 stored round.");
		expect(text).toContain("# Comparison review: range\n");
		expect(render([entry(), entry({ head: "c".repeat(40) })])).toContain("in 2 stored rounds.");
	});

	it("reads reviewers from the findings of an older record that stored none", () => {
		const record = entry({ externals: [report({ reviewer: { name: "claude-code" } })] });
		const stored = record.comparison.toJSON();
		for (const each of Object.values(stored.imports ?? {})) delete each.reviewers;
		const older = { ...record, comparison: Comparison.from(stored) };
		expect(render([older])).toContain("Reviewers: claude-code; Melian's own review");
	});
});

describe("ComparisonExport sections", () => {
	it("orders rounds by first comparison time, then head, and letters every section", () => {
		const entries = [
			entry({ head: "d".repeat(40), at: "2026-10-06T00:00:00Z" }),
			entry({ head: "c".repeat(40), at: "2026-10-05T00:00:00Z" }),
			entry({ head: "b".repeat(40), at: "2026-10-05T00:00:00Z" }),
		];
		const text = render(entries);
		expect(sections(text).filter((each) => each.includes("round"))).toEqual([
			"A Melian review, round 1",
			"B Melian review, round 2",
			"C Melian review, round 3",
		]);
		const heads = [...text.matchAll(/^At ([0-9a-f]{12}):/gm)].map((each) => each[1]);
		expect(heads).toEqual(["b".repeat(12), "c".repeat(12), "d".repeat(12)]);
	});

	it("letters past Z the way a spreadsheet does", () => {
		const entries = Array.from({ length: 14 }, (_, index) =>
			entry({ head: String.fromCharCode(98 + index).repeat(40), reviewers: [{ name: "codex" }] }),
		);
		const letters = sections(render(entries)).map((each) => each.split(" ")[0]);
		expect(letters.slice(0, 3)).toEqual(["A", "B", "C"]);
		expect(letters[25]).toBe("Z");
		expect(letters[26]).toBe("AA");
		expect(letters[27]).toBe("AB");
	});

	it("gives each reviewer one section holding every finding, in name order, with Not decided and Pending cells", () => {
		const entries = [
			entry({
				externals: [
					report({ reviewer: { name: "codex" }, title: "One", line: 10 }),
					report({ reviewer: { name: "codex" }, title: "Two", line: 20 }),
					report({ reviewer: { name: "claude-code" }, title: "Three", line: 30 }),
				],
				reviewers: [{ name: "codex" }, { name: "claude-code" }],
			}),
		];
		const text = render(entries);
		expect(sections(text).slice(0, 3)).toEqual([
			"A claude-code, round 1",
			"B codex, round 1",
			"C Melian review, round 1",
		]);
		expect(text).toContain("2 findings at");
		expect(text).toContain("1 finding at");
		expect(text).toMatch(/\| B1 \| codex \| src\/run\.ts:10 \| One: First paragraph\. \| Pending \| Not decided \|/);
		expect(text).toMatch(/\| B2 \| codex \| src\/run\.ts:20 \| Two: First paragraph\. \| Pending \| Not decided \|/);
	});

	it("shows an empty section for a reviewer that reported nothing", () => {
		const text = render([entry({ reviewers: [{ name: "claude-code" }] })]);
		expect(text).toContain("## A. claude-code, round 1\n\n0 findings at");
	});

	it("shows the Melian review's status, golden, location and dismissals, limited to the comparison", () => {
		const single = own(12);
		const range = Finding.create({ ...evalInput, snippet: "eval(range)", startLine: 20, endLine: 22 });
		const extra = own(50);
		const record = entry({ findings: [single, range] });
		record.comparison.adjudicate(single.id, { ...by, verdict: "valid", golden: "correctness" });
		const withExtra = { ...record, verdict: verdictOf({ findings: [single, range, extra] }) };
		const text = render([withExtra]);
		expect(text).toContain("2 findings at");
		expect(text).toContain(`verdict ${withExtra.verdict.status}`);
		expect(text).toContain("src/run.ts:12 |");
		expect(text).toContain("src/run.ts:20-22");
		expect(text).toMatch(/\| valid \| correctness \|/);
		expect(text).toMatch(/\| Pending \| Not decided \|/);
		expect(text).not.toContain("src/run.ts:50");
		const bare = render([{ changeset: "c", comparison: record.comparison }]);
		expect(bare).toContain("0 findings at");
		expect(bare).toContain("verdict not recorded.");
		expect(render([entry({ findings: [single] })])).toContain("1 finding at");
	});
});

describe("ComparisonExport decisions and counts", () => {
	it("lists notes in finding order, names authors without email, and skips blank notes", () => {
		const [low, high] = [report({ line: 10 }), report({ line: 90 })].sort((a, b) => a.id.localeCompare(b.id)) as [
			ExternalFinding,
			ExternalFinding,
		];
		const record = entry({ externals: [high, low] });
		record.comparison.adjudicate(high.id, { ...by, verdict: "noise", note: "second note" });
		record.comparison.adjudicate(low.id, { ...by, verdict: "noise", note: "first note" });
		const blank = report({ line: 60 });
		const other = entry({ externals: [blank] });
		other.comparison.adjudicate(blank.id, { ...by, verdict: "noise", note: "   " });
		const text = render([record]);
		expect(text.indexOf("first note")).toBeLessThan(text.indexOf("second note"));
		expect(text).toContain("by Ada (");
		expect(text).not.toContain("ada@example.com");
		expect(text).not.toContain("No maintainer notes recorded.");
		const none = render([other]);
		expect(none).toContain("No maintainer notes recorded.");
		expect(none).not.toContain("- From");
	});

	it("counts matched external findings, not their pairs, and leaves the drain notice out", () => {
		const first = own(12);
		const second = own(14);
		const between = report({ line: 13 });
		const record = entry({ externals: [between], findings: [first, second] });
		const text = render([record]);
		expect(text).toContain("1 matched external findings, 0 external-only defects, 0 Melian-only findings.");
		expect(text).not.toContain("Drain");
	});

	it("escapes the counts and the differences listing", () => {
		const external = report({ title: "a_b", reviewer: { name: "coderabbit", login: "coderabbitai[bot]" } });
		const text = render([entry({ externals: [external], reviewers: [external.reviewer] })]);
		expect(text.split("## Counts")[1]!.split("## Differences")[0]).toContain(
			"coderabbit:coderabbitai\\[bot\\]: recall",
		);
		expect(text.split("## Differences")[1]).toContain("src/run.ts:12  a\\_b");
	});

	it("words judgements, with a duplicate's original and its absence", () => {
		const finding = own(12);
		const external = report({ line: 70 });
		const record = entry({ externals: [external], findings: [finding] });
		record.comparison.adjudicate(external.id, { ...by, verdict: "duplicate", of: finding.id });
		expect(render([record])).toContain(`duplicate of ${finding.id}`);
		const stored = record.comparison.toJSON();
		delete stored.adjudications![external.id]!.current.of;
		expect(render([{ ...record, comparison: Comparison.from(stored) }])).toContain("duplicate of not recorded");
		const valid = entry({ externals: [external] });
		valid.comparison.adjudicate(external.id, { ...by, verdict: "valid", severity: "P1", reason: "no-owner" });
		expect(render([valid])).toContain("valid, P1, no-owner");
	});
});

describe("ComparisonExport paragraphs", () => {
	const summary = (body: string) => {
		const text = render([entry({ externals: [report({ body, title: "T" })] })]);
		return /\| T: ([^|]*) \|/.exec(text)?.[1];
	};

	it("takes the first paragraph, trimmed, ending at any blank line", () => {
		expect(summary("\n\n  First one.\n\nSecond.")).toBe("First one.");
		expect(summary("A\n \nB")).toBe("A");
		expect(summary("A\r\n\r\nB")).toBe("A");
		expect(summary("A\n\tB\tC")).toBe("A B C");
	});

	it("keeps 300 characters whole and cuts a longer paragraph there, by code point", () => {
		expect(summary("x".repeat(300))).toBe("x".repeat(300));
		expect(summary("x".repeat(301))).toBe(`${"x".repeat(300)}…`);
		expect(summary("😀".repeat(400))).toBe(`${"😀".repeat(300)}…`);
	});
});

describe("ComparisonExport.renderJson", () => {
	it("writes C1, bidi, and separator characters as escapes and keeps the value intact", () => {
		const body = "x\u001b[2Jy\u009b2Jz\u202eevil\u2028end\u007f";
		const text = new ComparisonExport([entry({ externals: [report({ body })] })], "range").renderJson();
		expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
		expect(text).toContain("\\u009b2J");
		expect(text).toContain("\\u202e");
		expect(JSON.stringify(JSON.parse(text))).toContain(JSON.stringify(body).slice(1, -1));
	});
});
