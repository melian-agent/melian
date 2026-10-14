import { join } from "node:path";
import { loadGoldens, loadResolutionGoldens, type ResolutionGolden, runResolutionGolden } from "@melian-agent/evals";
import { describe, expect, it } from "vitest";

const goldens = loadResolutionGoldens();

describe("the resolution goldens", { timeout: 60_000 }, () => {
	it("holds the twenty the decision lists, apart from the lens corpus", () => {
		expect(goldens.map((golden) => golden.name)).toEqual([
			"ceiling-caps-and-never-raises",
			"ceiling-only-file",
			"check-beats-table",
			"deterministic-rule-through-keys",
			"findings-name-the-file-and-entry",
			"head-edits-keys",
			"injection-under-cleanup-ceiling",
			"lens-default-applies",
			"lens-resolution-change",
			"lowered-finding",
			"merged-defect-opposite-policies",
			"merged-lens-capped-static-not",
			"nearer-file-drops-farther-ceiling",
			"nearest-table-beats-root-rule",
			"nested-resolution-change",
			"pre-existing-cap",
			"rule-beats-check",
			"rule-entry-maps-one-severity",
			"table-overrides-lens-ceiling",
			"whole-guardrail-entry-nearer",
		]);
		expect(loadGoldens().map((golden) => golden.name)).not.toContain("resolution");
	});

	it.each(goldens.map((golden): [string, ResolutionGolden] => [golden.name, golden]))("%s", async (_, golden) => {
		const run = await runResolutionGolden(golden);
		const all = run.verdict.all();
		for (const expected of golden.scenario.expect) {
			const found = all.filter(
				(finding) =>
					finding.properties.path === expected.file &&
					(expected.rule === undefined || finding.ruleId === expected.rule) &&
					(expected.line === undefined || finding.lines()[0] === expected.line),
			);
			const name = [expected.file, expected.rule, expected.line].filter((part) => part !== undefined).join(" ");
			expect(
				found.map((finding) => finding.properties.resolution),
				name,
			).toEqual([expected.resolution]);
			if (expected.decidedBy !== undefined) {
				expect(found[0]!.properties.decidedBy?.file ?? "", name).toBe(expected.decidedBy);
			}
		}
		// Every finding the run holds is one the golden expects, so none resolves unseen.
		expect(all).toHaveLength(golden.scenario.expect.length);
		expect(run.doctor).toEqual(golden.scenario.doctor);
		await expect(run.rendered).toMatchFileSnapshot(join(golden.directory, "expected.txt"));
	});
});
