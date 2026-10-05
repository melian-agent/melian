import {
	Adjudication,
	Comparison,
	ComparisonError,
	defaultConfig,
	ExternalFinding,
	type ExternalFindingInput,
	Finding,
	type FindingInput,
	maxExternalTitleLength,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const revision = { base: "a".repeat(40), head: "b".repeat(40) };

// A Melian finding at `src/run.ts:12`, or wherever `input` puts it.
const melian = (input: Partial<FindingInput> = {}) =>
	Finding.create({ ...evalInput, trigger: undefined, resolution: undefined, ...input });

let position = 0;
// An external finding from a file, at the position this call gives it unless `input` names a source.
function external(input: Partial<ExternalFindingInput> = {}): ExternalFinding {
	return ExternalFinding.create({
		reviewer: { name: "codex" },
		file: "src/run.ts",
		line: 12,
		title: "eval runs request input",
		body: "The handler passes the body to eval.",
		source: { kind: "file", path: "codex.json", position: position++ },
		...input,
	});
}

// Melian's verdict over `findings`, as adjudication decides it under the default resolutions.
const verdictOf = (findings: readonly Finding[]) =>
	new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate();

function compared(externals: readonly ExternalFinding[], findings: readonly Finding[]): Comparison {
	const comparison = Comparison.of(revision);
	comparison.import("file:codex.json", { findings: externals, skippedBodies: 0 }, "2026-10-05T00:00:00.000Z");
	comparison.compare(verdictOf(findings));
	return comparison;
}

const ids = (groups: ReturnType<Comparison["groups"]>) =>
	groups.map((group) => ({ external: group.external.map((each) => each.id), melian: [...group.melian] }));

describe("ExternalFinding", () => {
	it("hashes the source reference into its ID, so importing again gives the same ID", () => {
		const source = {
			kind: "thread",
			thread: "PRRT_1",
			url: "https://github.com/o/r/pull/1#r11",
		} as const;
		const first = external({ reviewer: { name: "coderabbit", login: "coderabbitai[bot]" }, source } as const);
		const again = external({
			reviewer: { name: "coderabbit", login: "coderabbitai[bot]" },
			source,
			title: "edited since",
			line: 40,
		} as const);
		expect(again.id).toBe(first.id);
		expect(first.id).toMatch(/^[0-9a-f]{16}$/);
		// The reviewer stays out of the ID, so naming reviewers differently later never orphans a hand record.
		expect(external({ reviewer: { name: "human", login: "octocat" }, source } as const).id).toBe(first.id);
		// Without a ref, a file's finding is known by its file, line, and title, never its position.
		const file = { kind: "file", path: "codex.json", position: 0 } as const;
		expect(external({ source: file }).id).toBe(external({ source: { ...file, position: 7 } }).id);
		expect(external({ source: file }).id).not.toBe(external({ source: file, line: 99 }).id);
		expect(external({ source: file }).id).not.toBe(external({ source: file, title: "another" }).id);
		const ref = { ...file, ref: "A1" } as const;
		expect(external({ source: ref }).id).toBe(external({ source: ref, line: 99, title: "edited" }).id);
		expect(external({ source: ref }).id).not.toBe(external({ source: file }).id);
	});

	it("keeps a title to its first line and a bounded length, and its file in canonical form", () => {
		const finding = external({ title: `\n  **${"long ".repeat(100)}**\nsecond line`, file: "./src//run.ts" });
		expect(finding.title.split("\n")).toHaveLength(1);
		expect([...finding.title]).toHaveLength(maxExternalTitleLength);
		expect(finding.title.endsWith("…")).toBe(true);
		expect(finding.file).toBe("src/run.ts");
	});

	it("refuses a path outside the repository and lines that end before they start", () => {
		expect(() => external({ file: "../etc/passwd" })).toThrow(ComparisonError);
		expect(() => external({ line: 12, endLine: 10 })).toThrow(/endLine comes before its line/);
		expect(() => external({ line: undefined, endLine: 10 })).toThrow(ComparisonError);
	});

	it("round-trips through its stored JSON", () => {
		const finding = external({ endLine: 14, severity: "high", resolved: true, postedAt: "2026-10-05T01:00:00Z" });
		expect(ExternalFinding.from(JSON.parse(JSON.stringify(finding))).toJSON()).toEqual(finding.toJSON());
	});

	it("reads the external-finding file shape, keeping each finding's ref as its source", () => {
		const findings = ExternalFinding.fromFile(
			{
				reviewer: { name: "claude-code", version: "2.1" },
				findings: [
					{ ref: "A1", file: "src/a.ts", line: 3, endLine: 5, title: "One", body: "Body", severity: "P1" },
					{ title: "General", body: "No file at all" },
				],
			},
			"reviews/claude.json",
		);
		expect(findings.map((each) => each.toJSON())).toEqual([
			expect.objectContaining({
				reviewer: { name: "claude-code", version: "2.1" },
				file: "src/a.ts",
				line: 3,
				endLine: 5,
				severity: "P1",
				source: { kind: "file", path: "reviews/claude.json", position: 0, ref: "A1" },
			}),
			expect.objectContaining({
				title: "General",
				source: { kind: "file", path: "reviews/claude.json", position: 1 },
			}),
		]);
		expect(findings[1]!.site()).toBeUndefined();
	});

	it("reads Codex's adversarial review output under its own schema", () => {
		const [finding] = ExternalFinding.fromFile(
			{
				verdict: "needs-attention",
				summary: "One problem.",
				findings: [
					{
						severity: "high",
						title: "Key leaks",
						body: "The diagnostic quotes the line.",
						file: "packages/core/src/config.ts",
						line_start: 40,
						line_end: 42,
						confidence: 0.8,
						recommendation: "Drop the source line.",
					},
				],
				next_steps: [],
			},
			"codex.json",
		);
		expect(finding!.toJSON()).toMatchObject({
			reviewer: { name: "codex" },
			file: "packages/core/src/config.ts",
			line: 40,
			endLine: 42,
			severity: "high",
			body: "The diagnostic quotes the line.\n\nRecommendation: Drop the source line.",
			source: { kind: "file", path: "codex.json", position: 0 },
		});
	});

	it("cuts a file's long title as it cuts a thread's", () => {
		const [finding] = ExternalFinding.fromFile(
			{ reviewer: { name: "human" }, findings: [{ title: "x".repeat(500), body: "" }] },
			"x.json",
		);
		expect([...finding!.title]).toHaveLength(maxExternalTitleLength);
	});

	it.each([
		["a severity", { severity: "x".repeat(101) }],
		["a ref", { ref: "x".repeat(101) }],
		["a file", { file: `src/${"x".repeat(4093)}` }],
		["a posting time", { postedAt: "x".repeat(101) }],
	])("refuses %s longer than its bound", (_, field) => {
		expect(() =>
			ExternalFinding.fromFile(
				{ reviewer: { name: "codex" }, findings: [{ title: "t", body: "", ...field }] },
				"x.json",
			),
		).toThrow(expect.objectContaining({ code: "invalidFile" }));
	});

	it("refuses a reviewer's version or login longer than its bound", () => {
		expect(() =>
			ExternalFinding.fromFile({ reviewer: { name: "codex", version: "x".repeat(101) }, findings: [] }, "x.json"),
		).toThrow(expect.objectContaining({ code: "invalidFile" }));
		expect(() => external({ reviewer: { name: "human", login: "x".repeat(101) } })).toThrow(ComparisonError);
	});

	it("keeps two findings at one site under one title apart when their bodies differ, in both file shapes", () => {
		const own = (body: string) => ({ file: "src/a.ts", line: 3, title: "Possible bug", body });
		const shaped = ExternalFinding.fromFile(
			{ reviewer: { name: "claude-code" }, findings: [own("Null manager."), own("Off by one.")] },
			"claude.json",
		);
		const codex = (body: string) => ({
			severity: "high",
			title: "Possible bug",
			body,
			file: "src/a.ts",
			line_start: 3,
			line_end: 3,
			confidence: 0.5,
			recommendation: "",
		});
		const codexFindings = ExternalFinding.fromFile(
			{
				verdict: "needs-attention",
				summary: "s",
				findings: [codex("Null manager."), codex("Off by one.")],
				next_steps: [],
			},
			"codex.json",
		);
		for (const findings of [shaped, codexFindings]) {
			expect(findings).toHaveLength(2);
			const comparison = compared([], [melian()]);
			comparison.import("file:x", { findings, skippedBodies: 0 }, "t");
			expect(comparison.externalFindings()).toHaveLength(2);
		}
		// An unchanged finding keeps its ID when a rerun moves it in the file.
		const rerun = ExternalFinding.fromFile(
			{ reviewer: { name: "claude-code" }, findings: [own("Off by one."), own("Null manager.")] },
			"claude.json",
		);
		expect(rerun.map((each) => each.id).sort()).toEqual(shaped.map((each) => each.id).sort());
	});

	it("refuses a file that repeats a ref, and keeps one of two findings alike", () => {
		expect(() =>
			ExternalFinding.fromFile(
				{
					reviewer: { name: "codex" },
					findings: [
						{ ref: "A1", title: "one", body: "" },
						{ ref: "A1", title: "two", body: "" },
					],
				},
				"x.json",
			),
		).toThrow(
			expect.objectContaining({
				code: "invalidFile",
				message: "x.json: finding 1 repeats an earlier finding's ref",
			}),
		);
		const twice = { file: "src/a.ts", line: 3, title: "same", body: "" };
		expect(
			ExternalFinding.fromFile({ reviewer: { name: "codex" }, findings: [twice, twice] }, "x.json"),
		).toHaveLength(1);
	});

	it("refuses a file in neither shape, naming the file and what is wrong", () => {
		expect(() => ExternalFinding.fromFile({ findings: [] }, "x.json")).toThrow(
			/x\.json is not an external-finding file: it .*reviewer/,
		);
		expect(() =>
			ExternalFinding.fromFile(
				{ reviewer: { name: "codex" }, findings: [{ title: "t", body: "", extra: 1 }] },
				"x.json",
			),
		).toThrow(/unknown key in \/findings\/0$/);
		expect(() =>
			ExternalFinding.fromFile(
				{ reviewer: { name: "codex" }, findings: [{ title: "t", body: "", file: "/abs.ts", line: 1 }] },
				"x.json",
			),
		).toThrow(/x\.json: finding 0: /);
		expect(() =>
			ExternalFinding.fromFile({ verdict: "approve", summary: "", findings: [{}], next_steps: [] }, "c.json"),
		).toThrow(/c\.json is not Codex's review output/);
	});
});

describe("Comparison matching", () => {
	it("lists a uniquely matched external finding beside its Melian finding, with its reviewer and site", () => {
		const finding = melian();
		const outside = external({ line: 11, endLine: 13 });
		const comparison = compared([outside], [finding]);
		expect(comparison.ambiguous()).toEqual([]);
		expect(comparison.render(verdictOf([finding]))).toContain(
			`Matched:\n  ${finding.id}\n    ${outside.id}  codex  src/run.ts:11-13\n`,
		);
	});

	it("matches by site: the same file, with lines that overlap", () => {
		const finding = melian();
		const outside = external({ line: 11, endLine: 13 });
		const comparison = compared([outside], [finding]);
		expect(comparison.effectiveMatches()).toEqual([{ external: outside.id, melian: finding.id, kind: "site" }]);
		expect(ids(comparison.matched())).toEqual([{ external: [outside.id], melian: [finding.id] }]);
		expect(comparison.externalOnly()).toEqual([]);
		expect(comparison.melianOnly()).toEqual([]);
	});

	it("matches lines within three of each other, and not four", () => {
		const finding = melian();
		const three = external({ line: 15 });
		const four = external({ line: 16 });
		const before = external({ line: 6, endLine: 9 });
		const comparison = compared([three, four, before], [finding]);
		expect(comparison.effectiveMatches().map((match) => match.external)).toEqual([three.id, before.id].sort());
		expect(ids(comparison.externalOnly())).toEqual([{ external: [four.id], melian: [] }]);
	});

	it("leaves a silent finding out of the comparison, since the author never saw it", () => {
		const nit = melian({ severity: "nit" });
		const near = external({ line: 12 });
		const comparison = compared([near], [nit]);
		expect(comparison.melianFindings()).toEqual([]);
		expect(comparison.effectiveMatches()).toEqual([]);
		expect(ids(comparison.externalOnly())).toEqual([{ external: [near.id], melian: [] }]);
		expect(comparison.melianOnly()).toEqual([]);
	});

	it.each([true, false])("includes and labels a dismissed Melian finding (matched: %s)", (matched) => {
		const finding = melian({ status: "dismissed" });
		const verdict = verdictOf([finding]);
		expect(verdict.attention()).toEqual([]);
		expect(verdict.dismissed.map((each) => each.id)).toEqual([finding.id]);
		const outside = external();
		const comparison = compared(matched ? [outside] : [], [finding]);
		expect(comparison.melianFindings()).toEqual([finding.id]);
		if (matched) {
			expect(comparison.effectiveMatches()).toEqual([{ external: outside.id, melian: finding.id, kind: "site" }]);
			expect(comparison.render(verdict)).toContain(`Matched:\n  ${finding.id}  (dismissed)\n`);
		} else {
			expect(comparison.melianOnly()).toEqual([finding.id]);
			expect(comparison.render(verdict)).toContain(
				`Melian only:\n  ${finding.id}  P1 no-eval  src/run.ts:12  (dismissed)\n`,
			);
		}
	});

	it("site-matches a thread only when its reviewer read the compared head, and says why another waits", () => {
		const finding = melian();
		const thread = (id: string, commit: string) =>
			external({
				reviewer: { name: "coderabbit", login: "coderabbitai[bot]", kind: "bot" },
				source: { kind: "thread", thread: id, url: `https://github.com/o/r/pull/1#${id}` },
				commit,
			});
		const current = thread("PRRT_now", revision.head);
		const earlier = thread("PRRT_then", "c".repeat(40));
		const comparison = compared([current, earlier], [finding]);
		expect(comparison.effectiveMatches()).toEqual([{ external: current.id, melian: finding.id, kind: "site" }]);
		expect(ids(comparison.externalOnly())).toEqual([{ external: [earlier.id], melian: [] }]);
		expect(comparison.render(undefined)).toContain(`(read at ${"c".repeat(12)}; match it by hand)`);
		comparison.match(earlier.id, finding.id, "M", "t");
		expect(comparison.externalOnly()).toEqual([]);
	});

	it("never matches another file", () => {
		const comparison = compared([external({ file: "src/other.ts" })], [melian()]);
		expect(comparison.effectiveMatches()).toEqual([]);
		expect(comparison.melianOnly()).toEqual([melian().id]);
	});

	it("matches a Melian finding's cause location at head, but not one at the base or its context", () => {
		const finding = melian({
			cause: "affected",
			evidence: [
				{ file: "src/api.ts", startLine: 3, role: "cause", revision: "head", snippet: "x" },
				{ file: "src/old.ts", startLine: 3, role: "cause", revision: "base", snippet: "x" },
				{ file: "src/context.ts", startLine: 3, role: "context", revision: "head", snippet: "x" },
			],
		});
		const atCause = external({ file: "src/api.ts", line: 4 });
		const atBase = external({ file: "src/old.ts", line: 3 });
		const atContext = external({ file: "src/context.ts", line: 3 });
		const comparison = compared([atCause, atBase, atContext], [finding]);
		expect(comparison.effectiveMatches().map((match) => match.external)).toEqual([atCause.id]);
	});

	it("matches a finding with no line, an outdated one, or one on the base side only by hand", () => {
		const finding = melian();
		const noLine = external({ line: undefined });
		const outdated = external({ outdated: true });
		const base = external({ revision: "base" });
		const comparison = compared([noLine, outdated, base], [finding]);
		expect(comparison.effectiveMatches()).toEqual([]);
		comparison.match(noLine.id, finding.id, "Maintainer <m@example.com>", "2026-10-05T02:00:00Z");
		expect(comparison.effectiveMatches()).toEqual([
			{
				external: noLine.id,
				melian: finding.id,
				kind: "hand",
				by: "Maintainer <m@example.com>",
				at: "2026-10-05T02:00:00Z",
			},
		]);
	});

	it("counts a defect once when several reviewers report it at one Melian finding", () => {
		const finding = melian();
		const codex = external({ line: 12 });
		const rabbit = external({
			reviewer: { name: "coderabbit", login: "coderabbitai[bot]" },
			line: 13,
			source: { kind: "thread", thread: "PRRT_9", url: "https://github.com/o/r/pull/1#r9" },
		});
		const comparison = compared([codex, rabbit], [finding]);
		expect(comparison.matched()).toHaveLength(1);
		expect(ids(comparison.matched())[0]!.external.sort()).toEqual([codex.id, rabbit.id].sort());
	});

	it("groups external-only findings from different reviewers at one site, and keeps one reviewer's two apart", () => {
		const codex = external({ file: "src/b.ts", line: 30 });
		const codexAgain = external({ file: "src/b.ts", line: 31 });
		const claude = external({ reviewer: { name: "claude-code" }, file: "src/b.ts", line: 33 });
		const comparison = compared([codex, codexAgain, claude], [melian()]);
		// In site order: Codex at 30 starts a group, Codex at 31 cannot join it, and Claude Code at 33 joins the first.
		expect(ids(comparison.externalOnly())).toEqual([
			{ external: [codex.id, claude.id], melian: [] },
			{ external: [codexAgain.id], melian: [] },
		]);
		const apart = compared([codex, codexAgain], [melian()]);
		expect(apart.externalOnly()).toHaveLength(2);
	});

	it("knows a reviewer by its name and login, ignoring the login's case", () => {
		const human = (login: string, line: number) =>
			external({ reviewer: { name: "human", login }, file: "src/b.ts", line });
		const octocat = human("octocat", 10);
		expect(octocat.sameReviewer(human("OctoCat", 11))).toBe(true);
		expect(octocat.sameReviewer(human("hubot", 11))).toBe(false);
		expect(octocat.sameReviewer(external({ reviewer: { name: "codex" }, file: "src/b.ts", line: 11 }))).toBe(false);
		expect(compared([octocat, human("hubot", 11)], [melian()]).externalOnly()).toHaveLength(1);
		expect(compared([octocat, human("OctoCat", 11)], [melian()]).externalOnly()).toHaveLength(2);
	});

	it("does not group a finding read at an earlier commit with another reviewer's finding at the same site", () => {
		const thread = (line: number) =>
			external({
				reviewer: { name: "coderabbit", login: "coderabbitai[bot]", kind: "bot" },
				source: { kind: "thread", thread: `PRRT_${line}`, url: `https://github.com/o/r/pull/1#PRRT_${line}` },
				line,
				commit: "c".repeat(40),
			});
		const peer = external({ reviewer: { name: "claude-code" }, line: 12 });
		// Findings group in site order, so the earlier thread comes before the peer and after it.
		for (const line of [11, 13]) {
			const earlier = thread(line);
			expect(earlier.meets(peer)).toBe(true);
			const comparison = compared([earlier, peer], []);
			expect(ids(comparison.externalOnly())).toEqual(
				[earlier, peer].sort((a, b) => a.compareSite(b)).map((each) => ({ external: [each.id], melian: [] })),
			);
		}
	});

	it("keeps a reviewer's finding unmatched by hand out of the group another reviewer's match makes", () => {
		const finding = melian();
		const codex = external({ line: 12 });
		const claude = external({ reviewer: { name: "claude-code" }, line: 13 });
		const comparison = compared([codex, claude], [finding]);
		comparison.unmatch(claude.id, finding.id, "M", "t");
		expect(ids(comparison.matched())).toEqual([{ external: [codex.id], melian: [finding.id] }]);
		expect(ids(comparison.externalOnly())).toEqual([{ external: [claude.id], melian: [] }]);
	});

	it("matches an external finding with each of two Melian findings near it, and never merges them", () => {
		const first = melian();
		const second = melian({ snippet: "eval(other)", startLine: 15, endLine: 15 });
		const between = external({ line: 13, endLine: 14 });
		const comparison = compared([between], [first, second]);
		expect(ids(comparison.matched())).toEqual([
			{ external: [between.id], melian: [first.id] },
			{ external: [between.id], melian: [second.id] },
		]);
		expect(comparison.melianOnly()).toEqual([]);
		expect(comparison.externalOnly()).toEqual([]);
		// Counted once, and marked for the maintainer, since proximity cannot say which defect the reviewer meant.
		const shown = comparison.render(undefined);
		expect(shown).toMatch(
			/^Matched: 1 external finding, covering 2 Melian findings\. External only: 0\. Melian only: 0\.\n/,
		);
		expect(comparison.ambiguous().map((each) => each.external.id)).toEqual([between.id]);
		expect(shown).toContain(
			`Ambiguous, near several Melian findings; match or unmatch by hand:\n  ${between.id}  codex`,
		);
		comparison.unmatch(between.id, second.id, "M", "t");
		expect(comparison.ambiguous()).toEqual([]);
		expect(comparison.render(undefined)).toMatch(
			/^Matched: 1 external finding, covering 1 Melian finding\. External only: 0\. Melian only: 1\./,
		);
	});

	it("keeps a mechanical pairing ambiguous after a hand match settles only the other pair", () => {
		const first = melian();
		const second = melian({ snippet: "eval(other)", startLine: 15, endLine: 15 });
		const between = external({ line: 13, endLine: 14 });
		const comparison = compared([between], [first, second]);
		comparison.match(between.id, first.id, "M", "t");
		comparison.compare(verdictOf([first, second]));
		expect(
			comparison
				.effectiveMatches()
				.map((match) => match.kind)
				.sort(),
		).toEqual(["hand", "site"]);
		expect(comparison.ambiguous()).toEqual([{ external: between, melian: [first.id, second.id].sort() }]);
		expect(comparison.render(undefined)).toContain(
			`  ${between.id}  codex  src/run.ts:13-14  near ${[first.id, second.id].sort().join(", ")}\n`,
		);
		comparison.unmatch(between.id, second.id, "M", "t2");
		expect(comparison.ambiguous()).toEqual([]);
	});

	it("does not call a finding ambiguous that a maintainer matched by hand to two Melian findings", () => {
		const first = melian();
		const second = melian({ snippet: "eval(other)", startLine: 40, endLine: 40 });
		const far = external({ line: 90 });
		const comparison = compared([far], [first, second]);
		comparison.match(far.id, first.id, "M", "t1");
		comparison.match(far.id, second.id, "M", "t2");
		expect(comparison.effectiveMatches().filter((match) => match.kind === "hand")).toHaveLength(2);
		expect(comparison.ambiguous()).toEqual([]);
		expect(comparison.render(undefined)).not.toContain("Ambiguous");
	});

	it("lists each Melian-only finding with its ID, severity, rule, and place, or its ID alone without the verdict", () => {
		const finding = melian();
		const comparison = compared([external({ file: "src/far.ts", line: 90 })], [finding]);
		expect(comparison.render(verdictOf([finding]))).toContain(
			`Melian only:\n  ${finding.id}  P1 no-eval  src/run.ts:12\n`,
		);
		expect(comparison.render(undefined)).toContain(`Melian only:\n  ${finding.id}\n`);
		const spanning = melian({ startLine: 20, endLine: 24 });
		expect(compared([], [spanning]).render(verdictOf([spanning]))).toContain(
			`  ${spanning.id}  P1 no-eval  src/run.ts:20-24\n`,
		);
	});

	it("lets an unmatch override a site match, and keeps both kinds of hand record across a re-import", () => {
		const finding = melian();
		const other = melian({ snippet: "eval(other)", startLine: 40, endLine: 40 });
		const near = external({ line: 12 });
		const far = external({ line: 40, file: "src/far.ts" });
		const comparison = compared([near, far], [finding, other]);
		comparison.unmatch(near.id, finding.id, "M", "t1");
		comparison.match(far.id, other.id, "M", "t2");
		const again = Comparison.from(comparison.toJSON());
		again.import("file:codex.json", { findings: [near, far], skippedBodies: 0 }, "t3");
		again.compare(verdictOf([finding, other]));
		expect(again.effectiveMatches()).toEqual([
			{ external: far.id, melian: other.id, kind: "hand", by: "M", at: "t2" },
		]);
		expect(again.melianOnly()).toEqual([finding.id]);
		expect(ids(again.externalOnly())).toEqual([{ external: [near.id], melian: [] }]);
		again.match(near.id, finding.id, "M", "t4");
		expect(again.toJSON().unmatches).toEqual([]);
		again.unmatch(far.id, other.id, "M", "t5");
		expect(again.effectiveMatches().map((match) => match.external)).toEqual([near.id]);
	});

	it("keeps a field a newer Melian stored, through an import and a comparison", () => {
		const finding = melian();
		const stored = { ...compared([], [finding]).toJSON(), adjudications: { later: { verdict: "valid" } } };
		const comparison = Comparison.from(stored);
		comparison.import("file:codex.json", { findings: [external()], skippedBodies: 0 }, "t");
		comparison.compare(verdictOf([finding]));
		expect(comparison.toJSON()).toMatchObject({ adjudications: { later: { verdict: "valid" } } });
	});

	it("refuses a hand match naming a finding it does not hold", () => {
		const finding = melian();
		const near = external();
		const comparison = compared([near], [finding]);
		expect(() => comparison.match("0".repeat(16), finding.id, "M", "t")).toThrow(
			expect.objectContaining({ code: "unknownExternal" }),
		);
		expect(() => comparison.unmatch(near.id, "f".repeat(16), "M", "t")).toThrow(
			expect.objectContaining({ code: "unknownMelian" }),
		);
	});

	it("updates a re-imported finding in place rather than adding another, and records each source's import", () => {
		const finding = melian();
		const source = { kind: "file", path: "codex.json", position: 0, ref: "A1" } as const;
		const comparison = compared([external({ source })], [finding]);
		const moved = external({ source, line: 60 });
		comparison.import("file:codex.json", { findings: [moved], skippedBodies: 2 }, "later");
		comparison.compare(verdictOf([finding]));
		expect(comparison.externalFindings()).toHaveLength(1);
		expect(comparison.externalFindings()[0]!.line).toBe(60);
		expect(comparison.effectiveMatches()).toEqual([]);
		expect(comparison.importsBySource()).toEqual({
			"file:codex.json": { at: "later", ids: [moved.id], skippedBodies: 2 },
		});
	});

	it("replaces what a source last imported, dropping a withdrawn finding and its hand records", () => {
		const finding = melian();
		const other = melian({ snippet: "eval(other)", startLine: 40, endLine: 40 });
		const file = (line: number, title: string) => ({ file: "src/run.ts", line, title, body: "b" });
		const first = ExternalFinding.fromFile(
			{ reviewer: { name: "codex" }, findings: [file(12, "kept"), file(40, "withdrawn"), file(90, "also gone")] },
			"codex.json",
		);
		const comparison = compared([], [finding, other]);
		comparison.import("file:codex.json", { findings: first, skippedBodies: 0 }, "t1");
		comparison.compare(verdictOf([finding, other]));
		comparison.match(first[1]!.id, other.id, "M", "t2");
		comparison.unmatch(first[2]!.id, finding.id, "M", "t2");
		const second = ExternalFinding.fromFile(
			{ reviewer: { name: "codex" }, findings: [file(12, "kept")] },
			"codex.json",
		);

		comparison.import("file:codex.json", { findings: second, skippedBodies: 0 }, "t3");
		comparison.compare(verdictOf([finding, other]));

		expect(second[0]!.id).toBe(first[0]!.id);
		expect(comparison.externalFindings().map((each) => each.id)).toEqual([first[0]!.id]);
		expect(comparison.toJSON().matches).toEqual([{ external: first[0]!.id, melian: finding.id, kind: "site" }]);
		expect(comparison.toJSON().unmatches).toEqual([]);
		expect(comparison.importsBySource()["file:codex.json"]!.ids).toEqual([first[0]!.id]);
	});

	it("keeps a finding another source still holds when one source withdraws it", () => {
		const shared = external({
			source: { kind: "thread", thread: "PRRT_1", url: "https://github.com/o/r/pull/1#r1" },
		});
		const comparison = compared([], [melian()]);
		comparison.import("github:coderabbitai[bot]", { findings: [shared], skippedBodies: 0 }, "t1");
		comparison.import("github:coderabbitai", { findings: [shared], skippedBodies: 0 }, "t2");
		comparison.import("github:coderabbitai[bot]", { findings: [], skippedBodies: 0 }, "t3");
		expect(comparison.externalFindings().map((each) => each.id)).toEqual([shared.id]);
	});
});
