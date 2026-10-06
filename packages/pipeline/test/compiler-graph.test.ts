import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnolaFacts } from "@melian-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerGraph } from "../src/compiler-graph.ts";
import { EnolaCoverage } from "../src/enola-coverage.ts";

let root: string;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("compiler graph extraction", { timeout: 60_000 }, () => {
	it.each(["() =>", "function()", "function local()"])(
		"qualifies nested %s values by their enclosing bindings",
		async (value) => {
			root = mkdtempSync(join(tmpdir(), "melian-nested-binding-"));
			mkdirSync(join(root, "src"));
			writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/*.ts"] }));
			const facts = [];
			for (const [file, binding] of [
				["a.ts", "left"],
				["b.ts", "right"],
			] as const) {
				writeFileSync(
					join(root, "src", file!),
					`export const ${binding} = ${value} {\n const inner = () => 1;\n return inner();\n};\n`,
				);
				facts.push(
					{
						id: binding,
						kind: "symbol",
						name: `src.${binding}`,
						file: `src/${file}`,
						line: 1,
						relations: [{ kind: "calls", target: `src.${binding}.inner`, target_id: `${binding}-inner` }],
					},
					{ id: `${binding}-inner`, kind: "symbol", name: `src.${binding}.inner`, file: `src/${file}`, line: 2 },
				);
			}
			const compiler = CompilerGraph.open(root);
			try {
				const truth = compiler.read();
				expect(
					truth.files.flatMap((file) => file.pairs.map((pair) => [pair.caller.name, pair.callee.name])),
				).toEqual([
					["left", "left.inner"],
					["right", "right.inner"],
				]);
				const coverage = await EnolaCoverage.open(
					truth,
					EnolaFacts.parse(facts.map((fact) => JSON.stringify(fact)).join("\n")),
					async () => undefined,
				);
				expect(coverage.measure("a".repeat(40), "0.4.27", "facts").toJSON().totals).toMatchObject({
					calls: 2,
					matchedCalls: 2,
				});
			} finally {
				compiler.close();
			}
		},
	);
});
