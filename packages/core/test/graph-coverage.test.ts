import { type CallGroundTruth, GraphCoverage, type SymbolSite } from "@melian-agent/core";
import { expect, it } from "vitest";

it("renders measured ratios, empty denominators and escaped named gaps", () => {
	const caller: SymbolSite = { file: "a.ts", line: 1, column: 1, endLine: 2, name: "caller", kind: "function" };
	const truth: CallGroundTruth = {
		format_version: 1,
		compiler: "fixture",
		symbols: [caller],
		files: [
			{
				path: "a.ts",
				pairs: [
					{
						caller,
						callee: { ...caller, name: "callee" },
						line: 2,
						kind: "call",
						expression: "callee(\n)",
						throughThis: false,
					},
				],
				imports: [{ target: "b.ts", line: 1, specifier: "./b", kind: "import", typeOnly: false }],
				external: 2,
				unresolved: 1,
			},
			{ path: "b.ts", pairs: [], imports: [], external: 0, unresolved: 0 },
		],
	};
	const coverage = GraphCoverage.compute("a".repeat(40), "0.4.27", truth, {
		call: () => "missing call",
		import: () => undefined,
	});
	expect(coverage.render()).toBe(
		"| File | Call pairs | Import edges | External calls | Unresolved calls |\n|---|---:|---:|---:|---:|\n" +
			"| a.ts | 0/1 (0.0%) | 1/1 (100.0%) | 2 | 1 |\n| b.ts | 0/0 (n/a) | 0/0 (n/a) | 0 | 0 |\n\n## Named gaps\n\n" +
			"### a.ts\n\n- Line 2, call, missing call: caller@1:1 -> a.ts:1:1 callee (callee(\\n))\n",
	);
	expect(coverage.toJSON().totals).toEqual({
		calls: 1,
		matchedCalls: 0,
		imports: 1,
		matchedImports: 1,
		external: 2,
		unresolved: 1,
	});
});
