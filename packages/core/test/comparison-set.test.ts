import {
	Adjudication,
	Comparison,
	type ComparisonEntry,
	ComparisonSet,
	defaultConfig,
	ExternalFinding,
	type ExternalFindingInput,
	Finding,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const revision = { base: "a".repeat(40), head: "b".repeat(40) };
const at = "2026-10-05T01:00:00Z";
const by = { by: "Ada", at };
const own = (startLine = 12, snippet = `eval(line${startLine})`) =>
	Finding.create({ ...evalInput, snippet, startLine, endLine: startLine });
let sequence = 0;
const report = (input: Partial<ExternalFindingInput> = {}) =>
	ExternalFinding.create({
		reviewer: { name: "codex" },
		file: "src/run.ts",
		line: 12,
		title: "Null manager",
		body: "First paragraph.",
		source: { kind: "file", path: "codex.json", position: 0, ref: String(sequence++) },
		...input,
	});
const verdictOf = (...findings: Finding[]) =>
	new Adjudication({ findings, checks: [], manifest: [], config: defaultConfig }).adjudicate();

function round(
	options: { externals?: ExternalFinding[]; findings?: Finding[]; at?: string; target?: string } = {},
): Comparison {
	const { externals = [], findings = [] } = options;
	const comparison = Comparison.of(revision);
	comparison.import("file:codex.json", { findings: externals, skippedBodies: 0 }, options.at ?? at);
	comparison.compare(verdictOf(...findings));
	if (options.target !== undefined) comparison.record(options.at ?? at, options.target);
	return comparison;
}
const entry = (changeset: string, comparison: Comparison, findings: Finding[] = []): ComparisonEntry => ({
	changeset,
	comparison,
	verdict: verdictOf(...findings),
});
const owing = (
	changeset: string,
	finding: Finding,
	lens: string,
	options: { at?: string; target?: string } = {},
): ComparisonEntry => {
	const comparison = round({ findings: [finding], ...options });
	comparison.adjudicate(finding.id, { ...by, verdict: "valid", golden: lens });
	return entry(changeset, comparison, [finding]);
};

describe("ComparisonSet selection", () => {
	it("selects a changeset by the earliest of its rounds", () => {
		const late = round({ findings: [own(1)], at: "2026-03-05T00:00:00Z" });
		const early = round({ findings: [own(2)], at: "2026-01-05T00:00:00Z" });
		for (const order of [
			[late, early],
			[early, late],
		]) {
			const set = new ComparisonSet(order.map((comparison) => entry("a", comparison)));
			expect(set.select({ since: "2026-02-01" }).drain().comparisons).toBe(0);
			expect(set.select({ since: "2026-01-01" }).drain().comparisons).toBe(1);
		}
	});

	it("includes a changeset recorded at the --since instant", () => {
		const set = new ComparisonSet([entry("a", round({ at: "2026-02-01T00:00:00Z" }))]);
		expect(set.select({ since: "2026-02-01T00:00:00Z" }).drain().comparisons).toBe(1);
		expect(set.select({ since: "2026-02-01T00:00:01Z" }).drain().comparisons).toBe(0);
	});

	it("keeps unrecorded comparisons out of --since and ahead of recorded ones under --last", () => {
		const unrecorded = owing("unrecorded", own(1), "alpha");
		const stored = unrecorded.comparison.toJSON();
		delete stored.createdAt;
		stored.imports = {};
		const bare = { ...unrecorded, comparison: Comparison.from(stored) };
		expect(bare.comparison.recordedAt()).toBeUndefined();
		const recorded = owing("recorded", own(2), "alpha", { at: "2026-01-01T00:00:00Z" });
		const set = new ComparisonSet([recorded, bare]);
		expect(
			set
				.select({ since: "2000-01-01" })
				.backlog()
				.map((each) => each.changeset),
		).toEqual(["recorded"]);
		expect(
			set
				.select({ last: 1 })
				.backlog()
				.map((each) => each.changeset),
		).toEqual(["recorded"]);
	});

	it("orders changesets recorded together by name, and --last keeps the newest", () => {
		const set = new ComparisonSet(["b", "c", "a"].map((name, index) => owing(name, own(index + 1), "alpha")));
		const kept = set
			.select({ last: 2 })
			.backlog()
			.map((each) => each.changeset);
		expect(kept.sort()).toEqual(["b", "c"]);
		const dated = new ComparisonSet([
			owing("old", own(1), "alpha", { at: "2026-01-01T00:00:00Z" }),
			owing("new", own(2), "alpha", { at: "2026-02-01T00:00:00Z" }),
		]);
		expect(dated.select({ last: 1 }).backlog()[0]?.changeset).toBe("new");
		expect(dated.select({}).backlog()).toHaveLength(2);
	});
});

describe("ComparisonSet statistics", () => {
	const busy = (changeset: string) => {
		const matched = own(12);
		const validReport = report({ line: 12 });
		const duplicate = report({ line: 40, title: "Dup" });
		const pending = report({ line: 60, title: "Pending" });
		const noise = report({ line: 80, title: "Noise" });
		const comparison = round({ externals: [validReport, duplicate, pending, noise], findings: [matched] });
		comparison.adjudicate(validReport.id, { ...by, verdict: "valid" });
		comparison.adjudicate(matched.id, { ...by, verdict: "valid" });
		comparison.adjudicate(duplicate.id, { ...by, verdict: "duplicate", of: matched.id });
		comparison.adjudicate(noise.id, { ...by, verdict: "noise" });
		return entry(changeset, comparison, [matched]);
	};

	it("sums every count of a reviewer across changesets before dividing", () => {
		const stats = new ComparisonSet([busy("a"), busy("b")]).stats();
		const codex = stats.reviewers.find((each) => each.reviewer === "codex");
		expect(codex).toMatchObject({ found: 2, total: 2, valid: 2, noise: 2, duplicate: 2, pending: 2 });
		expect(codex?.precision).toBeCloseTo(1 / 3);
		expect(codex?.recall).toBe(1);
	});

	it("sums pending matches, reasonless misses and misses by reason", () => {
		const ambiguous = (changeset: string) => {
			const first = own(12);
			const second = own(14);
			const between = report({ line: 13 });
			return entry(changeset, round({ externals: [between], findings: [first, second] }), [first, second]);
		};
		expect(new ComparisonSet([ambiguous("a"), ambiguous("b")]).stats().pendingMatches).toBe(2);
		const reasonless = (changeset: string) => {
			const finding = own(12);
			const external = report({ line: 12 });
			const comparison = round({ externals: [external], findings: [finding] });
			comparison.adjudicate(external.id, { ...by, verdict: "valid" });
			comparison.unmatch(external.id, finding.id, by.by, at);
			return entry(changeset, comparison, [finding]);
		};
		expect(new ComparisonSet([reasonless("a"), reasonless("b")]).stats().reasonlessMisses).toBe(2);
		const missed = (changeset: string) => {
			const external = report({ line: 90 });
			const comparison = round({ externals: [external] });
			comparison.adjudicate(external.id, { ...by, verdict: "valid", reason: "needs-execution" });
			return entry(changeset, comparison);
		};
		expect(new ComparisonSet([missed("a"), missed("b")]).stats().misses["needs-execution"]).toBe(2);
	});

	it("sorts reviewers and scores a reviewer with nothing judged 1", () => {
		const clean = (changeset: string, name: "claude-code" | "codex") => {
			const comparison = Comparison.of(revision);
			comparison.import(`file:${name}.json`, { findings: [], skippedBodies: 0, reviewers: [{ name }] }, at);
			comparison.compare(verdictOf());
			return entry(changeset, comparison);
		};
		const stats = new ComparisonSet([clean("a", "codex"), clean("b", "claude-code")]).stats();
		expect(stats.reviewers.map((each) => each.reviewer)).toEqual(["claude-code", "codex", "melian"]);
		expect(stats.reviewers.every((each) => each.recall === 1 && each.precision === 1)).toBe(true);
	});

	it("narrows reviewer metrics to the selection and flags every filter", () => {
		const first = busy("a");
		const miss = report({ line: 90, title: "Late miss" });
		const second = round({ externals: [miss], at: "2026-12-01T00:00:00Z" });
		second.adjudicate(miss.id, { ...by, verdict: "valid", reason: "no-owner" });
		const set = new ComparisonSet([first, entry("b", second)]);
		const last = set.renderStats({ last: 1 });
		expect(last).toContain("Comparisons: 1.\n");
		expect(last).toContain("melian: recall 0/1 (0.000)");
		expect(set.renderStats()).toContain("melian: recall 1/2 (0.500)");
		expect(last).toContain("Clone-wide, not narrowed by the filter:");
		const since = set.renderStats({ since: "2000-01-01" });
		expect(since).toContain("Clone-wide, not narrowed by the filter:");
		expect(since).not.toContain("Comparisons: 2. Pending matches");
		expect(set.renderStats()).toContain("Comparisons: 2. Pending matches: 0.");
		expect(set.renderStats()).not.toContain("Clone-wide");
	});
});

describe("ComparisonSet backlog", () => {
	it("owes nothing for a finding no round of its changeset holds, even when another changeset holds it", () => {
		const finding = own(12);
		const withdrawn = owing("a", finding, "alpha");
		withdrawn.comparison.compare(verdictOf());
		const holder = entry("b", round({ findings: [finding] }), [finding]);
		expect(new ComparisonSet([withdrawn, holder]).backlog()).toEqual([]);
		expect(new ComparisonSet([withdrawn]).backlog()).toEqual([]);
	});

	it("orders owed goldens by lens, then target, then finding ID", () => {
		const [i0, i1, i2, i3] = [own(1), own(2), own(3), own(4)].sort((a, b) => a.id.localeCompare(b.id)) as [
			Finding,
			Finding,
			Finding,
			Finding,
		];
		const set = new ComparisonSet([
			owing("c1", i3, "zeta", { target: "t-a" }),
			owing("c2", i0, "alpha", { target: "t-b" }),
			owing("c3", i2, "alpha", { target: "t-a" }),
			owing("c4", i1, "alpha", { target: "t-a" }),
		]);
		expect(set.backlog().map((each) => `${each.lens}/${each.target}/${each.changeset}`)).toEqual([
			"alpha/t-a/c4",
			"alpha/t-a/c3",
			"alpha/t-b/c2",
			"zeta/t-a/c1",
		]);
	});

	it("titles an owed Melian finding by its ID when nothing names it", () => {
		const finding = own(1);
		const bare = owing("a", finding, "alpha");
		const set = new ComparisonSet([{ changeset: "a", comparison: bare.comparison }]);
		expect(set.backlog()).toMatchObject([{ title: finding.id }]);
	});

	it("prints an empty backlog in both forms", () => {
		const set = new ComparisonSet([]);
		expect(set.renderBacklog()).toBe("No goldens owed.\n");
		expect(set.renderBacklog(true)).toContain("No goldens owed.\n");
	});
});

describe("ComparisonSet terminal rendering", () => {
	const hostile = "Fix\u001b[2J\u001b]0;pwned\u0007\nforged";
	const escaped = "Fix\\u001b[2J\\u001b]0;pwned\\u0007\\u000aforged";
	const escapedTitle = "Fix\\u001b[2J\\u001b]0;pwned\\u0007";
	const noRawControls = (text: string) => expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);

	it("escapes control characters in the plain backlog's title and target", () => {
		const external = report({ title: hostile });
		const comparison = round({ externals: [external], target: hostile });
		comparison.adjudicate(external.id, { ...by, verdict: "valid", reason: "no-owner", golden: "correctness" });
		const text = new ComparisonSet([entry("c1", comparison)]).renderBacklog();
		noRawControls(text.replace(/\n$/, ""));
		expect(text).toBe(`correctness: ${escaped} ${external.id} ${escapedTitle} (valid).\n`);
	});

	it("escapes control characters in the candidate check lines of stats", () => {
		const judged = (changeset: string, external: ExternalFinding) => {
			const comparison = round({ externals: [external] });
			comparison.adjudicate(external.id, { ...by, verdict: "valid", reason: "no-owner", rule: hostile });
			return entry(changeset, comparison);
		};
		const set = new ComparisonSet([
			judged(hostile, report({ line: 90, title: "one" })),
			judged(`${hostile}2`, report({ line: 95, title: "two" })),
		]);
		const text = set.renderStats();
		noRawControls(text.replace(/\n/g, ""));
		expect(text).toContain(`Candidate check: rule:${escaped}, seen on 2 changesets (${escaped}, ${escaped}2).`);
	});
});

describe("ComparisonSet candidate checks", () => {
	const pool = [90, 91, 92, 93]
		.map((line) => report({ line, title: `pooled ${line}` }))
		.sort((a, b) => a.id.localeCompare(b.id));
	const judged = (changeset: string, rule: string, externals: ExternalFinding[]) => {
		const comparison = round({ externals });
		for (const external of externals)
			comparison.adjudicate(external.id, { ...by, verdict: "valid", reason: "no-owner", rule });
		return entry(changeset, comparison);
	};
	const tagged = (changeset: string, rule: string) =>
		judged(changeset, rule, [report({ line: 90, title: `${rule} one` }), report({ line: 95, title: `${rule} two` })]);

	it("lists clusters seen on two changesets with sorted keys, IDs and changesets", () => {
		const late = judged("c2", "zz", [pool[3]!, pool[2]!]);
		const early = judged("c1", "zz", [pool[1]!, pool[0]!]);
		const other = [tagged("c2", "aa"), tagged("c1", "aa")];
		const candidates = new ComparisonSet([late, other[0]!, early, other[1]!]).candidates();
		expect(candidates.map((each) => each.key)).toEqual(["rule:aa", "rule:zz"]);
		expect(candidates[1]).toMatchObject({ ids: pool.map((each) => each.id), changesets: ["c1", "c2"] });
	});

	it("needs two changesets, and does not count a miss still awaiting its reason", () => {
		expect(new ComparisonSet([tagged("c1", "zz")]).candidates()).toEqual([]);
		const matchedFinding = own(12);
		const external = report({ line: 12, title: "zz pending" });
		const comparison = round({ externals: [external], findings: [matchedFinding] });
		comparison.adjudicate(external.id, { ...by, verdict: "valid", rule: "zz" });
		comparison.unmatch(external.id, matchedFinding.id, by.by, at);
		expect(comparison.judgement(external.id)).toBeUndefined();
		const set = new ComparisonSet([tagged("c1", "zz"), entry("c2", comparison, [matchedFinding])]);
		expect(set.candidates()).toEqual([]);
	});

	it("keeps a finding's rule tag when a replacement judgement discharges its golden debt", () => {
		const first = report({ line: 90, title: "tagged one" });
		const comparison = round({ externals: [first] });
		comparison.adjudicate(first.id, {
			...by,
			verdict: "valid",
			reason: "no-owner",
			rule: "zz",
			golden: "correctness",
		});
		comparison.adjudicate(first.id, { ...by, verdict: "valid", reason: "no-owner", golden: "none" });
		expect(comparison.adjudication(first.id)?.current.rule).toBe("zz");
		const set = new ComparisonSet([entry("c1", comparison), tagged("c2", "zz")]);
		expect(set.candidates().map((each) => each.key)).toEqual(["rule:zz"]);
	});

	it("does not count a repeat that was matched to a Melian finding", () => {
		const matchedFinding = own(12);
		const external = report({ line: 12, title: "zz matched" });
		const comparison = round({ externals: [external], findings: [matchedFinding] });
		comparison.adjudicate(external.id, { ...by, verdict: "valid", rule: "zz" });
		const set = new ComparisonSet([tagged("c1", "zz"), entry("c2", comparison, [matchedFinding])]);
		expect(set.candidates()).toEqual([]);
	});
});

describe("ComparisonSet drain", () => {
	const owed = (count: number) => {
		const entries = Array.from({ length: count }, (_, index) => owing(`c${index}`, own(index + 1), "alpha"));
		return new ComparisonSet(entries);
	};

	it("falls due at three comparisons while goldens remain, shipping at most two", () => {
		expect(owed(2).drain()).toMatchObject({ due: false, next: 3 });
		expect(owed(3).drain()).toEqual({ comparisons: 3, due: true, goldens: 2, next: 6 });
		expect(owed(4).drain()).toMatchObject({ due: true, goldens: 2, next: 6 });
		const clean = new ComparisonSet(["a", "b", "c"].map((name) => entry(name, round())));
		expect(clean.drain()).toMatchObject({ due: false, goldens: 0 });
		const one = new ComparisonSet([owing("a", own(1), "alpha"), entry("b", round()), entry("c", round())]);
		expect(one.drain()).toMatchObject({ due: true, goldens: 1 });
	});

	it("words the notice for both outcomes and leaves it out on request", () => {
		expect(owed(3).renderStats()).toContain("Drain due: ship 2 owed goldens");
		expect(owed(2).renderStats()).toContain("Drain not due; next comparison threshold: 3.");
		expect(owed(3).renderStats({ drain: false })).not.toContain("Drain");
	});
});

describe("markdownText", () => {
	it("escapes what would render as markup, a mention or a reference, and shows control characters", () => {
		const finding = own(1);
		const set = new ComparisonSet([owing("a", finding, "alpha", { target: "<b>&*_[x](y)#!|~`\\ @bob #7\u0007" })]);
		const text = set.renderBacklog(true);
		expect(text).toContain("&lt;b&gt;&amp;\\*\\_\\[x\\]\\(y\\)\\#\\!\\|\\~\\`\\\\ @\u2060bob \\#\u20607");
		expect(text).not.toContain("\u0007");
	});

	it("breaks bare URLs, www hosts and GH references so a reviewer cannot plant a live link", () => {
		const hostile = "see https://evil.example/login or www.evil.example, _www.evil.example and GH-12 gh-3";
		const set = new ComparisonSet([owing("a", own(1), "alpha", { target: hostile })]);
		const text = set.renderBacklog(true);
		expect(text).toContain("https:\u2060//evil.example/login");
		expect(text).toContain("or www\u2060.evil.example");
		expect(text).toContain("GH-\u206012 gh-\u20603");
		expect(text).toContain("\\_www\u2060.evil.example");
		expect(text).not.toMatch(/https:\/\/|www\./i);
	});
});
