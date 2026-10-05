import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	Adjudication,
	Comparison,
	ComparisonExport,
	ComparisonSet,
	defaultConfig,
	ExternalFinding,
	type ExternalFindingInput,
	Finding,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const by = { by: "Ada <ada@example.com>", at: "2026-10-05T01:00:00Z" };
const revision = { base: "a".repeat(40), head: "b".repeat(40) };
const own = (snippet = "eval(input)", startLine = 12) =>
	Finding.create({ ...evalInput, snippet, startLine, endLine: startLine });
const verdictOf = (...findings: Finding[]) =>
	new Adjudication({ findings, checks: [], manifest: [], config: defaultConfig }).adjudicate();
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
const compared = (reports: ExternalFinding[], ...findings: Finding[]) => {
	const comparison = Comparison.of(revision);
	comparison.import("file:codex.json", { findings: reports, skippedBodies: 0 }, by.at);
	comparison.compare(verdictOf(...findings));
	return comparison;
};
const row = (comparison: Comparison, reviewer: string) =>
	comparison.stats().reviewers.find((each) => each.reviewer === reviewer);

describe("comparison review fixes", () => {
	it("loads the adjudication module first in a fresh process, without a schema cycle", () => {
		const module = fileURLToPath(new URL("../src/comparison-adjudication.ts", import.meta.url));
		const child = spawnSync(
			process.execPath,
			["--conditions=@melian-agent/source", "-e", `import(${JSON.stringify(module)})`],
			{ encoding: "utf8" },
		);
		expect(child.stderr).toBe("");
		expect(child.status).toBe(0);
	});

	it("skips a pending Melian report in a valid matched group until judged", () => {
		const finding = own();
		const external = report();
		const comparison = compared([external], finding);
		comparison.adjudicate(external.id, { ...by, verdict: "valid" });
		expect(row(comparison, "melian")).toMatchObject({ found: 0, total: 0, valid: 0, pending: 1 });
		comparison.adjudicate(finding.id, { ...by, verdict: "valid" });
		expect(row(comparison, "melian")).toMatchObject({ found: 1, total: 1, valid: 1, pending: 0 });
	});

	it("skips a pending external reviewer in a group another reviewer judged valid", () => {
		const pending = report();
		const valid = report({ reviewer: { name: "claude-code" } });
		const comparison = compared([pending, valid]);
		comparison.adjudicate(valid.id, { ...by, verdict: "valid", reason: "no-owner" });
		expect(row(comparison, "codex")).toMatchObject({ found: 0, total: 0, valid: 0, pending: 1 });
		comparison.adjudicate(pending.id, { ...by, verdict: "noise" });
		expect(row(comparison, "codex")).toMatchObject({ found: 0, total: 1, noise: 1, pending: 0 });
	});

	it("skips ambiguous reports in recall beside valid Melian reports, retaining judged precision", () => {
		const first = own();
		const second = own("eval(other)", 14);
		const external = report({ line: 13 });
		const comparison = compared([external], first, second);
		for (const finding of [first, second]) comparison.adjudicate(finding.id, { ...by, verdict: "valid" });
		comparison.adjudicate(external.id, { ...by, verdict: "valid" });
		expect(row(comparison, "codex")).toMatchObject({ found: 0, total: 0, valid: 1, precision: 1 });
		comparison.unmatch(external.id, second.id, by.by, by.at);
		expect(row(comparison, "codex")).toMatchObject({ found: 1, total: 2 });
	});

	it.each(["match", "unmatch"] as const)(
		"keeps a mixed pairing pending until the remaining pair is %sed",
		(action) => {
			const first = own();
			const second = own("eval(other)", 14);
			const external = report({ line: 13 });
			const comparison = compared([external], first, second);
			for (const finding of [first, second]) comparison.adjudicate(finding.id, { ...by, verdict: "valid" });
			comparison.adjudicate(external.id, { ...by, verdict: "valid" });
			comparison.match(external.id, first.id, by.by, by.at);
			comparison.compare(verdictOf(first, second));
			expect(
				comparison
					.effectiveMatches()
					.map((match) => match.kind)
					.sort(),
			).toEqual(["hand", "site"]);
			expect(comparison.stats().pendingMatches).toBe(1);
			expect(row(comparison, "codex")).toMatchObject({ found: 0, total: 0, valid: 1, pending: 0, precision: 1 });
			comparison[action](external.id, second.id, by.by, by.at);
			comparison.compare(verdictOf(first, second));
			expect(comparison.stats().pendingMatches).toBe(0);
			expect(row(comparison, "codex")).toMatchObject({
				found: action === "match" ? 2 : 1,
				total: 2,
				valid: 1,
				pending: 0,
				precision: 1,
			});
		},
	);

	it("persists an empty import's participant and counts its recall denominator after a round trip", () => {
		const finding = report({ reviewer: { name: "claude-code" } });
		const comparison = compared([finding]);
		comparison.import(
			"file:empty.json",
			ExternalFinding.importFile({ reviewer: { name: "codex", version: "2" }, findings: [] }, "empty.json"),
			by.at,
		);
		comparison.adjudicate(finding.id, { ...by, verdict: "valid", reason: "no-owner" });
		expect(row(Comparison.from(comparison.toJSON()), "codex")).toMatchObject({
			found: 0,
			total: 1,
			precision: 1,
			recall: 0,
		});
	});

	it.each(["unmatch", "import", "review"])("makes a reasonless valid miss pending after %s", (change) => {
		const finding = own();
		const external = report();
		const comparison = compared([external], finding);
		comparison.adjudicate(external.id, { ...by, verdict: "valid" });
		if (change === "unmatch") comparison.unmatch(external.id, finding.id, by.by, by.at);
		else if (change === "import")
			comparison.import(
				"file:codex.json",
				{ findings: [ExternalFinding.create({ ...external.toJSON(), line: 90 })], skippedBodies: 0 },
				by.at,
			);
		comparison.compare(change === "review" ? verdictOf() : verdictOf(finding));
		expect(comparison.needsReason(external.id)).toBe(true);
		expect(comparison.stats()).toMatchObject({ reasonlessMisses: 1 });
		expect(row(comparison, "codex")).toMatchObject({ total: 0, valid: 0, pending: 1 });
		expect(row(comparison, "melian")?.total).toBe(0);
		comparison.adjudicate(external.id, { ...by, verdict: "valid", reason: "no-owner" });
		expect(comparison.stats()).toMatchObject({ reasonlessMisses: 0, misses: { "no-owner": 1 } });
	});

	it("counts an out-of-scope group while its other valid report awaits a miss reason", () => {
		const finding = own();
		const pending = report();
		const outside = report({ reviewer: { name: "claude-code" } });
		const comparison = compared([pending, outside], finding);
		comparison.adjudicate(pending.id, { ...by, verdict: "valid" });
		comparison.adjudicate(outside.id, { ...by, verdict: "valid", reason: "out-of-scope" });
		comparison.compare(verdictOf());
		expect(comparison.stats()).toMatchObject({ reasonlessMisses: 1, misses: { "out-of-scope": 1 } });
		expect(row(comparison, "melian")?.total).toBe(0);
		expect(row(comparison, "codex")).toMatchObject({ total: 0, valid: 0, pending: 1 });
	});

	it("keeps debt until an explicit golden change, with replacement history", () => {
		const finding = own();
		const comparison = compared([], finding);
		comparison.adjudicate(finding.id, { ...by, verdict: "noise", golden: "correctness" });
		comparison.adjudicate(finding.id, { ...by, verdict: "valid", note: "Still owed." });
		expect(comparison.backlog()).toMatchObject([{ lens: "correctness" }]);
		expect(comparison.adjudication(finding.id)?.history).toHaveLength(1);
		comparison.adjudicate(finding.id, { ...by, verdict: "valid", golden: "none" });
		expect(comparison.backlog()).toEqual([]);
	});

	it("requires a duplicate's target and charges the second reviewer recall and precision", () => {
		const valid = report();
		const duplicate = report({ reviewer: { name: "claude-code" } });
		const comparison = compared([valid, duplicate]);
		comparison.adjudicate(valid.id, { ...by, verdict: "valid", reason: "no-owner" });
		expect(() => comparison.adjudicate(duplicate.id, { ...by, verdict: "duplicate" })).toThrow(/--of/);
		expect(() => comparison.adjudicate(duplicate.id, { ...by, verdict: "duplicate", of: duplicate.id })).toThrow(
			/another finding/,
		);
		expect(() => comparison.adjudicate(duplicate.id, { ...by, verdict: "duplicate", of: "0".repeat(16) })).toThrow(
			/another finding/,
		);
		comparison.adjudicate(duplicate.id, { ...by, verdict: "duplicate", of: valid.id });
		expect(row(comparison, "claude-code")).toMatchObject({
			found: 0,
			total: 1,
			duplicate: 1,
			recall: 0,
			precision: 0,
		});
		expect(new ComparisonExport([{ changeset: "a", comparison }], "range").render()).toContain(
			`duplicate of ${valid.id}`,
		);
	});

	it("refuses a miss reason on noise and on a Melian finding", () => {
		const finding = own();
		const external = report();
		const comparison = compared([external], finding);
		for (const [id, verdict] of [
			[external.id, "noise"],
			[finding.id, "valid"],
		] as const)
			expect(() => comparison.adjudicate(id, { ...by, verdict, reason: "no-owner" })).toThrow(
				/only to a valid external/,
			);
	});

	it("filters withdrawn judgements from summaries while retaining their stored history", () => {
		const external = report();
		const comparison = compared([external]);
		comparison.adjudicate(external.id, { ...by, verdict: "valid", reason: "owned-missed", golden: "correctness" });
		comparison.import("file:codex.json", { findings: [], skippedBodies: 0 }, by.at);
		expect(comparison.adjudications()).toEqual({});
		const set = new ComparisonSet([{ changeset: "a", comparison }]);
		expect(set.backlog()).toEqual([]);
		expect(set.drain()).toMatchObject({ due: false, goldens: 0 });
		expect(comparison.toJSON().adjudications?.[external.id]?.current.golden).toBe("correctness");
	});

	it("lets the newest judgement win even from a round that dropped the finding", () => {
		const external = report();
		const round = (at: string, held = true) => {
			const comparison = Comparison.of({ ...revision, head: at.slice(8, 10).repeat(20) });
			comparison.import("file:codex.json", { findings: held ? [external] : [], skippedBodies: 0 }, at);
			comparison.record(at, "a");
			return comparison;
		};
		const one = round("2026-10-01T00:00:00Z");
		one.adjudicate(external.id, {
			by: by.by,
			at: "2026-10-01T00:00:00Z",
			verdict: "valid",
			reason: "no-owner",
			golden: "correctness",
		});
		const two = round("2026-10-02T00:00:00Z");
		two.adjudicate(external.id, {
			by: by.by,
			at: "2026-10-02T00:00:00Z",
			verdict: "valid",
			reason: "no-owner",
			golden: "none",
		});
		const three = round("2026-10-03T00:00:00Z", false);
		const stored = two.toJSON().adjudications!;
		expect(new ComparisonSet([{ changeset: "a", comparison: one }]).backlog()).toHaveLength(1);
		const later = Comparison.from({ ...three.toJSON(), adjudications: stored });
		expect(later.adjudications()).toEqual({});
		expect(
			new ComparisonSet([
				{ changeset: "a", comparison: one },
				{ changeset: "a", comparison: two },
				{ changeset: "a", comparison: later },
			]).backlog(),
		).toEqual([]);
		const newer = Comparison.from({
			...three.toJSON(),
			adjudications: {
				[external.id]: { current: { ...stored[external.id]!.current, at: "2026-10-04T00:00:00Z" }, history: [] },
			},
		});
		expect(
			new ComparisonSet([
				{ changeset: "a", comparison: one },
				{ changeset: "a", comparison: newer },
			]).backlog(),
		).toEqual([]);
	});

	it("keeps a debt while any round of the changeset still holds the finding", () => {
		const external = report();
		const one = Comparison.of({ ...revision, head: "11".repeat(20) });
		one.import("file:codex.json", { findings: [external], skippedBodies: 0 }, "2026-10-01T00:00:00Z");
		one.record("2026-10-01T00:00:00Z", "a");
		one.adjudicate(external.id, {
			by: by.by,
			at: "2026-10-01T00:00:00Z",
			verdict: "valid",
			reason: "no-owner",
			golden: "correctness",
		});
		const two = Comparison.of({ ...revision, head: "22".repeat(20) });
		two.import("file:codex.json", { findings: [], skippedBodies: 0 }, "2026-10-02T00:00:00Z");
		two.record("2026-10-02T00:00:00Z", "a");
		expect(
			new ComparisonSet([
				{ changeset: "a", comparison: one },
				{ changeset: "a", comparison: two },
			]).backlog(),
		).toMatchObject([{ id: external.id, lens: "correctness" }]);
	});

	it("groups reviewer names and case-folded logins independently of versions", () => {
		const reports = [
			report({ reviewer: { name: "coderabbit", login: "CodeRabbitAI[bot]", version: "1" }, line: 10 }),
			report({ reviewer: { name: "coderabbit", login: "coderabbitai[bot]", version: "2" }, line: 50 }),
			report({ reviewer: { name: "human", login: "coderabbitai[bot]" }, line: 90 }),
		];
		const comparison = compared(reports);
		for (const finding of reports) comparison.adjudicate(finding.id, { ...by, verdict: "valid", reason: "no-owner" });
		expect(row(comparison, "coderabbit:coderabbitai[bot]")).toMatchObject({ valid: 2, found: 2, total: 3 });
		expect(row(comparison, "human:coderabbitai[bot]")).toMatchObject({ valid: 1, found: 1, total: 3 });
		expect(comparison.stats().reviewers).toHaveLength(3);
	});

	it("selects newest changesets by their first time and preserves all their rounds", () => {
		const entries = [
			["old", "2026-10-01"],
			["middle", "2026-10-02"],
			["middle", "2026-10-09"],
			["new", "2026-10-03"],
		].map(([changeset, day], index) => {
			const external = report({ title: `${changeset}-${index}` });
			const comparison = Comparison.of({ ...revision, head: String(index).repeat(40) });
			comparison.import("source", { findings: [external], skippedBodies: 0 }, `${day}T00:00:00Z`);
			comparison.record(`${day}T00:00:00Z`, changeset);
			comparison.adjudicate(external.id, { ...by, verdict: "valid", reason: "no-owner", golden: "correctness" });
			return { changeset: changeset!, comparison };
		});
		const set = new ComparisonSet(entries);
		expect(
			set
				.select({ last: 1 })
				.backlog()
				.map((each) => each.title),
		).toEqual(["new-3"]);
		expect(
			set
				.select({ last: 2 })
				.backlog()
				.map((each) => each.title)
				.sort(),
		).toEqual(["middle-1", "middle-2", "new-3"]);
		expect(
			set
				.select({ since: "2026-10-02" })
				.backlog()
				.map((each) => each.title)
				.sort(),
		).toEqual(["middle-1", "middle-2", "new-3"]);
		expect(
			set
				.select({ since: "2026-10-03" })
				.backlog()
				.map((each) => each.title)
				.sort(),
		).toEqual(["new-3"]);
		expect(set.renderStats({ last: 1 })).toContain("Comparisons: 1.");
		expect(set.renderStats({ last: 1 })).toContain("Clone-wide, not narrowed by the filter:\nPending matches: 0.\n");
		expect(set.renderStats()).not.toContain("Clone-wide");
		expect(set.renderStats({ last: 1 })).toContain("Drain due: ship 2 owed goldens");
		expect(set.renderStats({ since: "2099-01-01" })).toContain("Drain due: ship 2 owed goldens");
		expect(set.renderStats({ since: "2099-01-01" })).toContain("no-owner: 4.");
	});

	it("titles a golden owed for a Melian finding from the stored verdict's explanation", () => {
		const finding = own();
		const comparison = compared([], finding);
		comparison.adjudicate(finding.id, { ...by, verdict: "valid", golden: "correctness" });
		const set = new ComparisonSet([{ changeset: "a", comparison, verdict: verdictOf(finding) }]);
		expect(set.backlog()).toMatchObject([{ id: finding.id, title: finding.properties.explanation.what }]);
		expect(set.renderBacklog()).toContain(`${finding.id} ${finding.properties.explanation.what} (valid).`);
		expect(new ComparisonSet([{ changeset: "a", comparison }]).backlog()).toMatchObject([{ title: finding.id }]);
	});

	it("retains Melian repeat keys but offers candidates only for valid missed findings", () => {
		const entries = [own("eval(first)"), own("eval(second)")].map((finding, index) => {
			const external = report();
			const comparison = compared([external], finding);
			comparison.adjudicate(finding.id, { ...by, verdict: "valid" });
			comparison.adjudicate(external.id, { ...by, verdict: "valid" });
			const verdict = verdictOf(finding);
			expect(comparison.repeats(verdict)).toContainEqual({
				key: `rule:${finding.ruleId}`,
				title: finding.properties.explanation.what,
				ids: [finding.id],
			});
			return { changeset: String(index), comparison, verdict };
		});
		expect(new ComparisonSet(entries).candidates()).toEqual([]);
	});

	it("exports matched IDs and dismissal labels beside adjudicated findings", () => {
		const finding = Finding.create({ ...evalInput, status: "dismissed" });
		const external = report();
		const comparison = compared([external], finding);
		comparison.adjudicate(external.id, { ...by, verdict: "valid" });
		comparison.adjudicate(finding.id, { ...by, verdict: "noise" });
		const output = new ComparisonExport(
			[{ changeset: "a", comparison, verdict: verdictOf(finding) }],
			"range",
		).render();
		expect(output).toContain(" \\(dismissed\\) | noise |");
		expect(output).toContain(
			`Matched:\n  ${finding.id}  \\(dismissed\\)\n    ${external.id}  codex  src/run.ts:12\n`,
		);
	});

	it("bounds escaped export cells to a first paragraph and publishes names without author emails", () => {
		const external = report({
			body: `Line one.\nLine two ${"界".repeat(500)}\n\nSecond paragraph must stay private.`,
		});
		const comparison = compared([external]);
		comparison.adjudicate(external.id, { ...by, verdict: "valid", reason: "no-owner", note: "Write a golden." });
		const output = new ComparisonExport([{ changeset: "a", comparison }], "range").render();
		expect(output).toContain("by Ada (");
		expect(output).not.toContain("ada@example.com");
		expect(output).not.toContain("Second paragraph");
		expect(output).toContain("Line one. Line two");
		expect(output).not.toContain("Fix commit");
		expect(output).not.toContain("Drain");
		const cells = output
			.split("\n")
			.find((line) => line.startsWith("| A1"))!
			.split("|");
		expect(cells).toHaveLength(8);
		expect([...cells[4]!].length).toBeLessThan(330);
	});
});
