import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallGroundTruth, EnolaFacts, EnolaImpact } from "@melian-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerGraph } from "../src/compiler-graph.ts";
import { EnolaCoverage } from "../src/enola-coverage.ts";

let root: string;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});
describe("compiler call coverage", { timeout: 60_000 }, () => {
	it("follows a package alias and re-export, counts a test caller, and separates an unresolved dynamic call", async () => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-"));
		mkdirSync(join(root, "packages/a"), { recursive: true });
		mkdirSync(join(root, "packages/b"), { recursive: true });
		const files = {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					noEmit: true,
					allowImportingTsExtensions: true,
					module: "NodeNext",
					moduleResolution: "NodeNext",
					paths: { "@tiny/a": ["./packages/a/index.ts"] },
				},
				include: ["packages/**/*.ts"],
			}),
			"packages/a/Alpha.ts": "export function alpha() { return 1; }\n",
			"packages/a/index.ts": "export { alpha } from './Alpha.ts';\n",
			"packages/b/b.ts":
				"import { alpha } from '@tiny/a';\nexport function run() { alpha(); alpha(); }\ndeclare const dynamic: unknown;\n(dynamic as never as (() => unknown))();\n",
			"packages/b/b.test.ts": "import { alpha } from '../a/Alpha.ts';\nexport function testCaller() { alpha(); }\n",
		};
		for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
		const compiler = CompilerGraph.open(root);
		let truth: CallGroundTruth;
		try {
			truth = compiler.read();
		} finally {
			compiler.close();
		}
		const b = truth.files.find((file) => file.path === "packages/b/b.ts")!;
		expect(b.imports.map((edge) => edge.target)).toEqual(["packages/a/index.ts"]);
		expect(b.pairs).toHaveLength(1);
		expect(b.pairs[0]?.callee.name).toBe("alpha");
		expect(b.pairs[0]?.callee.file).toBe("packages/a/Alpha.ts");
		expect(b.unresolved).toBe(1);
		expect(truth.files.find((file) => file.path === "packages/a/index.ts")?.imports[0]?.kind).toBe("re-export");
		expect(truth.files.find((file) => file.path.endsWith("b.test.ts"))?.pairs).toHaveLength(1);
		const facts = EnolaFacts.parse(
			[
				{ id: "a", kind: "symbol", name: "packages/a.alpha", file: "packages/a/Alpha.ts", line: 1 },
				{ id: "b", kind: "symbol", name: "packages/b.run", file: "packages/b/b.ts", line: 2 },
			]
				.map((fact) => JSON.stringify(fact))
				.join("\n"),
		);
		const comparison = await EnolaCoverage.open(truth, facts, async () =>
			EnolaImpact.parse(
				JSON.stringify({
					target: "packages/a.alpha",
					by_depth: { "1": [{ name: "packages/b.run", kind: "symbol", file: "packages/b/b.ts", line: 2 }] },
					edges: [{ source: "packages/b.run", target: "packages/a.alpha", kind: "calls" }],
					stats: { truncated: false },
				}),
				0,
			),
		);
		const state = comparison.measure("a".repeat(40), "0.4.27").toJSON();
		expect(state.totals).toMatchObject({ calls: 2, matchedCalls: 1, imports: 3, unresolved: 1 });
		expect(state.files.find((file) => file.path === "packages/a/Alpha.ts")?.calls.ratio).toBeNull();
		expect(state.causes["call:test file excluded"]).toBe(1);
		expect(comparison.measure("a".repeat(40), "0.4.27", "facts").toJSON().totals.matchedCalls).toBe(0);
	});
	it("uses a function value's binding declaration rather than the next line's arrow", () => {
		root = mkdtempSync(join(tmpdir(), "melian-binding-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["a.ts"] }));
		writeFileSync(
			join(root, "a.ts"),
			"const value =\n () => 1;\nfunction run() { value(); }\nclass Box { get result() { return value(); } }\n",
		);
		const compiler = CompilerGraph.open(root);
		try {
			const pairs = compiler.read().files[0]!.pairs;
			expect(pairs[0]?.callee).toMatchObject({ name: "value", line: 1 });
			expect(pairs.map((pair) => pair.caller.name)).toEqual(["run", "Box.result"]);
		} finally {
			compiler.close();
		}
	});
	it("accepts upstream's null edges only for a successful empty report", () => {
		const text = JSON.stringify({
			target: "empty",
			by_depth: {},
			edges: null,
			total_dependents: 0,
			stats: { truncated: false },
		});
		expect(EnolaImpact.parse(text, 0).callers()).toEqual([]);
		expect(() => EnolaImpact.parse(text, 2)).toThrow("exited 2");
	});
	it("refuses an exit-2 impact document rather than treating it as no callers", () => {
		expect(() => EnolaImpact.parse('{"resolution":{"candidates":[]}}', 2)).toThrow("exited 2");
	});
});
