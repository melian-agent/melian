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
const verdictOf = ({ findings }: { findings: readonly Finding[] }) =>
	new Adjudication({ findings, checks: [], manifest: [], config: defaultConfig }).adjudicate();

function round(
	options: { externals?: ExternalFinding[]; findings?: Finding[]; at?: string; target?: string } = {},
): Comparison {
	const { externals = [], findings = [] } = options;
	const comparison = Comparison.of(revision);
	comparison.import("file:codex.json", { findings: externals, skippedBodies: 0 }, options.at ?? at);
	comparison.compare(verdictOf({ findings }));
	if (options.target !== undefined) comparison.record(options.at ?? at, options.target);
	return comparison;
}
const entry = (changeset: string, comparison: Comparison, findings: Finding[] = []): ComparisonEntry => ({
	changeset,
	comparison,
	verdict: verdictOf({ findings }),
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

it("keeps unattributed golden debt apart from round metrics", () => {
	const finding = own();
	const record = owing("a", finding, "correctness");
	const set = new ComparisonSet([
		{ ...record, verdict: undefined, unattributed: `${revision.base}..${revision.head}` },
	]);
	expect(set.backlog()).toMatchObject([{ id: finding.id, lens: "correctness" }]);
	expect(set.stats().reviewers).toEqual([]);
	expect(set.drain().comparisons).toBe(0);
	expect(set.renderStats()).toContain("Unattributed comparisons: 1.");
});

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
			comparison.compare(verdictOf({ findings: [] }));
			return entry(changeset, comparison);
		};
		const stats = new ComparisonSet([clean("a", "codex"), clean("b", "claude-code")]).stats();
		expect(stats.reviewers.map((each) => each.reviewer)).toEqual(["claude-code", "codex", "melian"]);
		expect(stats.reviewers.every((each) => each.recall === 1 && each.precision === 1)).toBe(true);
	});

	it("counts pending matches and reasonless misses clone-wide under a filter", () => {
		const [first, second, third] = [own(12), own(14), own(50)] as [Finding, Finding, Finding];
		const unexplained = report({ line: 50, title: "Unexplained" });
		const old = round({
			externals: [report({ line: 13 }), unexplained],
			findings: [first, second, third],
			at: "2026-01-01T00:00:00Z",
			target: "old",
		});
		old.adjudicate(unexplained.id, { ...by, verdict: "valid" });
		old.unmatch(unexplained.id, third.id, by.by, at);
		const set = new ComparisonSet([
			entry("old", old, [first, second, third]),
			entry("new", round({ at: "2026-12-01T00:00:00Z", target: "new" })),
		]);
		expect(set.select({ since: "2026-06-01" }).stats()).toMatchObject({ pendingMatches: 0, reasonlessMisses: 0 });
		const out = set.renderStats({ since: "2026-06-01" });
		expect(out).toContain("Clone-wide, not narrowed by the filter:\nPending matches: 1.\n");
		expect(out).toContain("Valid misses without a reason: 1.\n");
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
		withdrawn.comparison.compare(verdictOf({ findings: [] }));
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

	it("titles an owed external finding from a round that holds it when the judged round has dropped it", () => {
		const external = report({ title: "Null manager" });
		const earlier = round({ externals: [external], at: "2026-10-05T00:00:00Z" });
		const judged = round({ externals: [external], at: "2026-10-05T00:00:00Z" });
		judged.adjudicate(external.id, { by: "Ada", at, verdict: "valid", reason: "no-owner", golden: "correctness" });
		judged.import("file:codex.json", { findings: [], skippedBodies: 0 }, "2026-10-05T02:00:00Z");
		const set = new ComparisonSet([
			{ changeset: "a", comparison: earlier },
			{ changeset: "a", comparison: judged },
		]);
		expect(set.backlog()).toMatchObject([{ id: external.id, title: "Null manager" }]);
		expect(set.renderBacklog()).toContain("Null manager");
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

	it("retains candidate evidence from an unattributed comparison", () => {
		const unknown = { ...tagged("c1", "zz"), verdict: undefined, unattributed: `${revision.base}..${revision.head}` };
		expect(new ComparisonSet([unknown, tagged("c2", "zz")]).candidates()).toMatchObject([
			{ key: "rule:zz", changesets: ["c1", "c2"] },
		]);
	});

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

describe("one lens against one reviewer", () => {
	const design = (line: number) =>
		Finding.create({
			...evalInput,
			snippet: `eval(design${line})`,
			startLine: line,
			endLine: line,
			source: { check: "lens.design", version: "1" },
		});
	const merged = (line: number) => {
		const finding = own(line);
		return Finding.from({
			...finding.toJSON(),
			properties: {
				...finding.toJSON().properties,
				alsoReportedAs: [{ id: "f".repeat(16), ruleId: "x", check: "lens.design" }],
			},
		});
	};

	// Line 12: Codex and the design lens. 20: Codex and another lens. 30: Codex alone. 40: the design lens alone. 50:
	// Codex's noise. 60: Codex, unjudged. 70: Claude Code and the design lens. 80: Codex and a merged report of the lens.
	function scenario() {
		const externals = [12, 20, 30, 50, 60, 80].map((line) => report({ line, title: `Codex ${line}` }));
		const claude = report({ line: 70, title: "Claude 70", reviewer: { name: "claude-code" } });
		const findings = [design(12), own(20), design(40), design(70), merged(80)];
		const comparison = round({ externals: [...externals, claude], findings });
		const judge = (id: string, extra: object = {}) =>
			comparison.adjudicate(id, { ...by, verdict: "valid", ...extra });
		for (const finding of findings) judge(finding.id);
		for (const external of externals.filter((each) => ![30, 50, 60].includes(each.toJSON().line!)))
			judge(external.id);
		judge(claude.id);
		judge(externals[2]!.id, { reason: "owned-missed" });
		comparison.adjudicate(externals[3]!.id, { ...by, verdict: "noise" });
		return { comparison, findings };
	}

	it("counts the reviewer's valid defects the lens found, those only other checks found, and the reverse", () => {
		const { comparison, findings } = scenario();
		const set = new ComparisonSet([
			entry("one", comparison, findings),
			{ changeset: "no-review", comparison: round({ externals: [report({ line: 99 })] }) },
			{ ...entry("unattributed", round({ externals: [report({ line: 98 })] })), unattributed: "pr-1" },
		]);
		expect(set.againstReviewer("lens.design", "codex")).toEqual({
			check: "lens.design",
			reviewer: "codex",
			comparisons: 1,
			reviewerValid: 4,
			checkFound: 2,
			othersFound: 1,
			checkValid: 4,
			reviewerFound: 2,
			pending: 1,
		});
		expect(set.againstReviewer("lens.design", "claude-code")).toMatchObject({
			reviewerValid: 1,
			checkFound: 1,
			othersFound: 0,
			checkValid: 4,
			reviewerFound: 1,
		});
		expect(set.renderAgainst("lens.design", "codex")).toBe(
			[
				"lens.design against codex, over 1 comparisons with a stored review.",
				"codex's valid defects: 4. lens.design found 2 (0.500); only Melian's other checks found 1; no check found 1.",
				"lens.design's valid defects: 4. codex found 2 (0.500).",
				"Findings left out while a report waits for a judgement or a hand match: 1.",
				"",
			].join("\n"),
		);
	});

	it("leaves out a defect while any report in it waits, its own or the reviewer's, or matches ambiguously", () => {
		// 12: the lens alone, unjudged. 20: Codex judged, the lens unjudged. 30: Codex judged, matching two of the
		// lens's findings by site, so the pairing waits for a hand match.
		const lone = design(12);
		const mixed = design(20);
		const first = design(30);
		const second = Finding.create({
			...evalInput,
			snippet: "eval(other30)",
			startLine: 30,
			endLine: 30,
			source: { check: "lens.design", version: "1" },
		});
		const codex20 = report({ line: 20, title: "Codex 20" });
		const codex30 = report({ line: 30, title: "Codex 30" });
		const findings = [lone, mixed, first, second];
		const comparison = round({ externals: [codex20, codex30], findings });
		for (const id of [codex20.id, codex30.id, first.id, second.id])
			comparison.adjudicate(id, { ...by, verdict: "valid" });
		expect(comparison.ambiguous().map((each) => each.external.id)).toEqual([codex30.id]);
		const stats = new ComparisonSet([entry("one", comparison, findings)]).againstReviewer("lens.design", "codex");
		expect(stats).toEqual({
			check: "lens.design",
			reviewer: "codex",
			comparisons: 1,
			reviewerValid: 0,
			checkFound: 0,
			othersFound: 0,
			checkValid: 0,
			reviewerFound: 0,
			pending: 6,
		});
	});

	it("counts each reviewer finding once, leaves out-of-scope misses and absent reviewers out, and reads every reporter", () => {
		// 12 and 14: two design findings Codex's one finding at 12 matches by hand. 30: a Codex miss judged out of scope.
		// 50: a correctness finding the design lens also sighted, which Codex matches.
		const first = design(12);
		const second = Finding.create({
			...evalInput,
			snippet: "eval(second)",
			startLine: 14,
			endLine: 14,
			source: { check: "lens.design", version: "1" },
		});
		const shared = (() => {
			const finding = own(50);
			const json = finding.toJSON();
			return Finding.from({
				...json,
				properties: {
					...json.properties,
					reportedBy: [json.properties.source, { check: "lens.design", version: "1" }],
				},
			});
		})();
		const codex12 = report({ line: 12, title: "Codex 12" });
		const codex30 = report({ line: 30, title: "Codex 30" });
		const codex50 = report({ line: 50, title: "Codex 50" });
		const findings = [first, second, shared];
		const comparison = round({ externals: [codex12, codex30, codex50], findings });
		comparison.match(codex12.id, first.id, "Ada", at);
		comparison.match(codex12.id, second.id, "Ada", at);
		for (const id of [codex12.id, codex50.id, first.id, second.id, shared.id])
			comparison.adjudicate(id, { ...by, verdict: "valid" });
		comparison.adjudicate(codex30.id, { ...by, verdict: "valid", reason: "out-of-scope" });
		const claude = report({ line: 12, title: "Claude", reviewer: { name: "claude-code" } });
		const claudeOnly = round({ externals: [claude], findings: [first] });
		claudeOnly.adjudicate(first.id, { ...by, verdict: "valid" });
		claudeOnly.adjudicate(claude.id, { ...by, verdict: "valid" });
		const set = new ComparisonSet([entry("one", comparison, findings), entry("claude", claudeOnly, [first])]);
		expect(set.againstReviewer("lens.design", "codex")).toEqual({
			check: "lens.design",
			reviewer: "codex",
			comparisons: 1,
			reviewerValid: 2,
			checkFound: 2,
			othersFound: 0,
			checkValid: 3,
			reviewerFound: 3,
			pending: 0,
		});
		expect(set.againstReviewer("lens.design", "claude-code")).toMatchObject({ comparisons: 1, reviewerValid: 1 });
	});

	it("credits a matched finding whatever miss reason it carries, and leaves the lens's noise out", () => {
		const found = design(12);
		const noise = design(40);
		const codex12 = report({ line: 12, title: "Codex 12" });
		const comparison = round({ externals: [codex12], findings: [found, noise] });
		comparison.adjudicate(codex12.id, { ...by, verdict: "valid", reason: "out-of-scope" });
		comparison.adjudicate(found.id, { ...by, verdict: "valid" });
		comparison.adjudicate(noise.id, { ...by, verdict: "noise" });
		expect(
			new ComparisonSet([entry("one", comparison, [found, noise])]).againstReviewer("lens.design", "codex"),
		).toEqual({
			check: "lens.design",
			reviewer: "codex",
			comparisons: 1,
			reviewerValid: 1,
			checkFound: 1,
			othersFound: 0,
			checkValid: 1,
			reviewerFound: 1,
			pending: 0,
		});
	});

	it("sums every round the reviewer took part in, a stored one without participant records included", () => {
		const round1 = (() => {
			const found = design(12);
			const codex = report({ line: 12, title: "Codex 12" });
			const comparison = round({ externals: [codex], findings: [found] });
			comparison.adjudicate(codex.id, { ...by, verdict: "valid" });
			comparison.adjudicate(found.id, { ...by, verdict: "valid" });
			return entry("one", comparison, [found]);
		})();
		const round2 = (() => {
			const codex = report({ line: 30, title: "Codex 30" });
			const comparison = round({ externals: [codex] });
			comparison.adjudicate(codex.id, { ...by, verdict: "valid", reason: "owned-missed" });
			// A comparison an older Melian stored records no participants on its import.
			const stored = comparison.toJSON();
			const legacy = Comparison.from({
				...stored,
				imports: Object.fromEntries(
					Object.entries(stored.imports).map(([source, { reviewers: _, ...each }]) => [source, each]),
				),
			});
			return entry("one", legacy, []);
		})();
		expect(new ComparisonSet([round1, round2]).againstReviewer("lens.design", "codex")).toEqual({
			check: "lens.design",
			reviewer: "codex",
			comparisons: 2,
			reviewerValid: 2,
			checkFound: 1,
			othersFound: 0,
			checkValid: 1,
			reviewerFound: 1,
			pending: 0,
		});
		expect(new ComparisonSet([round1, round2]).renderAgainst("lens.design", "codex")).toContain(
			"codex's valid defects: 2. lens.design found 1 (0.500); only Melian's other checks found 0; no check found 1.",
		);
	});

	it("credits no dismissed co-report, and counts a round whose reviewer imported nothing", () => {
		const shared = (() => {
			const finding = own(12);
			const json = finding.toJSON();
			return Finding.from({
				...json,
				properties: {
					...json.properties,
					alsoReportedAs: [{ id: "f".repeat(16), ruleId: "x", check: "lens.design", dismissed: true }],
				},
			});
		})();
		const codex12 = report({ line: 12, title: "Codex 12" });
		const matched = round({ externals: [codex12], findings: [shared] });
		matched.adjudicate(codex12.id, { ...by, verdict: "valid" });
		matched.adjudicate(shared.id, { ...by, verdict: "valid" });
		const lone = design(40);
		const empty = Comparison.of(revision);
		empty.import("file:codex.json", { findings: [], skippedBodies: 0, reviewers: [{ name: "codex" }] }, at);
		empty.compare(verdictOf({ findings: [lone] }));
		empty.adjudicate(lone.id, { ...by, verdict: "valid" });
		expect(
			new ComparisonSet([entry("one", matched, [shared]), entry("two", empty, [lone])]).againstReviewer(
				"lens.design",
				"codex",
			),
		).toEqual({
			check: "lens.design",
			reviewer: "codex",
			comparisons: 2,
			reviewerValid: 1,
			checkFound: 0,
			othersFound: 1,
			checkValid: 1,
			reviewerFound: 0,
			pending: 0,
		});
	});

	it("prints no share for an empty side, and selects changesets as the other statistics do", () => {
		const { comparison, findings } = scenario();
		const set = new ComparisonSet([entry("one", comparison, findings)]);
		expect(set.renderAgainst("lens.contracts", "copilot")).toBe(
			[
				"lens.contracts against copilot, over 0 comparisons with a stored review.",
				"copilot's valid defects: 0. lens.contracts found 0; only Melian's other checks found 0; no check found 0.",
				"lens.contracts's valid defects: 0. copilot found 0.",
				"Findings left out while a report waits for a judgement or a hand match: 0.",
				"",
			].join("\n"),
		);
		expect(set.renderAgainst("lens.design", "codex", { since: "2027-01-01" })).toContain("over 0 comparisons");
	});
});
