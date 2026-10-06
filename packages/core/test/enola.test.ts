import { EnolaPolicy, normaliseEnolaSarif, staticSeverity } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { isPolicyFile } from "../src/paths.ts";

describe("Enola policy and reports", () => {
	it("recognises every policy path and leaves a committed baseline out", () => {
		for (const path of [
			"enola.yaml",
			"mcp-arch.yaml",
			"enola-intent.yaml",
			"enola/constraints/core.yaml",
			".enola/suppressions.yaml",
		])
			expect(isPolicyFile(path)).toBe(true);
		expect(isPolicyFile(".enola/baseline/facts.jsonl")).toBe(false);
	});
	it("disables executable providers and names only declared constraints as gate policy", () => {
		const policy = EnolaPolicy.from([
			{
				path: "enola.yaml",
				text: "providers:\n  - command: [evil]\noutput: {dir: outside}\nhistory: {enabled: true}\nrepos: [outside]\n",
			},
			{ path: "enola/constraints/core.yaml", text: "rules: []\n" },
		]);
		expect(policy.toJSON().config).toContain("providers: []");
		expect(policy.toJSON().config).toContain("dir: .enola");
		expect(policy.toJSON().config).toContain("enabled: false");
		expect(policy.toJSON().config).not.toContain("repos:");
		expect(policy.toJSON().failOn).toEqual(["constraints"]);
		expect(EnolaPolicy.from([]).toJSON().failOn).toEqual([]);
	});
	it("reads located and unlocated results, excluding resolved and suppressed findings", () => {
		const result = { ruleId: "constraints/core-layer", level: "error", message: { text: "Layer crossed" } };
		const log = normaliseEnolaSarif(
			JSON.stringify({
				version: "2.1.0",
				runs: [
					{
						results: [
							result,
							{ ...result, properties: { bucket: "resolved" } },
							{ ...result, suppressions: [{ kind: "external" }] },
							{
								...result,
								locations: [
									{
										physicalLocation: {
											artifactLocation: { uri: "packages/core/src/a.ts" },
											region: { startLine: 4 },
										},
									},
								],
							},
						],
					},
				],
			}),
			{ root: "/repo", version: "0.4.27" },
		);
		expect(log.runs[0].tool.driver).toEqual({ name: "enola", version: "0.4.27" });
		expect(log.runs[0].results.map((r) => r.locations[0]?.physicalLocation.artifactLocation.uri)).toEqual([
			"enola-intent.yaml",
			"packages/core/src/a.ts",
		]);
		expect(staticSeverity("enola", "enola/layer", "error", {})).toBe("P2");
		expect(staticSeverity("enola", "enola/layer", "warning", {})).toBe("P3");
		expect(staticSeverity("enola", "enola/layer", "note", {})).toBe("nit");
		expect(staticSeverity("enola", "enola/layer", "warning", { "enola/layer": "P1" })).toBe("P1");
	});
	it.each(["", "{}", '{"version":"2.1.0","runs":[{"results":[{}]}]}'])("fails unreadable SARIF closed", (text) => {
		expect(() => normaliseEnolaSarif(text, { root: "/repo", version: "0.4.27" })).toThrow();
	});
});
