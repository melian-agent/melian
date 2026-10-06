import { codexReviewSchema, comparisonSchema, externalFindingsFileSchema } from "@melian-agent/core";
import Value from "typebox/value";
import { describe, expect, it } from "vitest";

const external = "a".repeat(16);
const melian = "b".repeat(16);
const finding = {
	id: external,
	reviewer: { name: "human", version: "1", login: "octocat", kind: "user" },
	file: "src/run.ts",
	line: 1,
	endLine: 2,
	revision: "base",
	outdated: false,
	commit: "c".repeat(40),
	title: "Missing check",
	body: "The handler accepts invalid input.",
	severity: "P1",
	source: { kind: "thread", thread: "PRRT_1", url: "https://github.com/melian-agent/example/pull/7#discussion_r1" },
	postedAt: "2026-10-06T00:00:00Z",
	resolved: true,
};

describe("exported comparison schemas", () => {
	it.each(["site", "hand"])("accepts a %s match without optional author fields and a recorded unmatch", (kind) => {
		expect(
			Value.Check(comparisonSchema, {
				base: "d".repeat(40),
				head: "e".repeat(40),
				external: { [external]: finding },
				melian: [melian],
				matches: [{ external, melian, kind }],
				unmatches: [{ external, melian, by: "Melian Test", at: "2026-10-06T00:00:00Z" }],
				imports: { "github:octocat": { at: "2026-10-06T00:00:00Z", ids: [external], skippedBodies: 0 } },
			}),
		).toBe(true);
	});

	it.each([true, false])("accepts file posting metadata with resolved set to %s", (resolved) => {
		expect(
			Value.Check(externalFindingsFileSchema, {
				reviewer: { name: "human", version: "1" },
				findings: [
					{
						ref: "A1",
						file: finding.file,
						line: finding.line,
						endLine: finding.endLine,
						title: finding.title,
						body: finding.body,
						severity: finding.severity,
						postedAt: finding.postedAt,
						resolved,
					},
				],
			}),
		).toBe(true);
	});

	it.each(["critical", "high", "medium", "low"])("accepts Codex severity %s with a next step", (severity) => {
		expect(
			Value.Check(codexReviewSchema, {
				verdict: "needs-attention",
				summary: "A handler accepts invalid input.",
				findings: [
					{
						severity,
						title: finding.title,
						body: finding.body,
						file: finding.file,
						line_start: 1,
						line_end: 2,
						confidence: 0.9,
						recommendation: "Validate the input.",
					},
				],
				next_steps: ["Run the isolated test."],
			}),
		).toBe(true);
	});
});
