import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnolaFacts } from "@melian-agent/core";
import { API } from "typescript/unstable/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompilerGraph } from "../src/compiler-graph.ts";
import { EnolaCoverage } from "../src/enola-coverage.ts";

let root: string;
afterEach(() => {
	vi.restoreAllMocks();
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("compiler graph extraction", { timeout: 60_000 }, () => {
	it("counts CommonJS import-equals declarations and their uncovered edges", async () => {
		root = mkdtempSync(join(tmpdir(), "melian-import-equals-"));
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { module: "CommonJS" }, include: ["*.ts"] }),
		);
		writeFileSync(join(root, "a.ts"), "import b = require('./b');\nimport type B = require('./b');\n");
		writeFileSync(join(root, "b.ts"), "export = 1;\n");
		const compiler = CompilerGraph.open(root);
		try {
			const truth = compiler.read();
			const file = truth.files.find((file) => file.path === "a.ts")!;
			expect(file.imports).toEqual([
				{ target: "b.ts", line: 1, specifier: "./b", kind: "import", typeOnly: false },
				{ target: "b.ts", line: 2, specifier: "./b", kind: "import", typeOnly: true },
			]);
			const coverage = await EnolaCoverage.open(truth, EnolaFacts.parse(""), async () => undefined);
			const measured = coverage.measure("a".repeat(40), "fixture").toJSON();
			expect(measured.totals).toMatchObject({ imports: 2, matchedImports: 0 });
			expect(measured.files.find((file) => file.path === "a.ts")?.gaps).toMatchObject([
				{ kind: "import", line: 1, detail: "import ./b -> b.ts" },
				{ kind: "import", line: 2, detail: "import ./b -> b.ts" },
			]);
		} finally {
			compiler.close();
		}
	});
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
	it("extracts constructions and tagged templates into the coverage denominator", async () => {
		root = mkdtempSync(join(tmpdir(), "melian-new-tag-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["a.ts"] }));
		writeFileSync(
			join(root, "a.ts"),
			"class Box {}\nfunction tag(s: TemplateStringsArray) {}\nfunction run() { new Box(); tag`x`; }\n",
		);
		const compiler = CompilerGraph.open(root);
		try {
			const truth = compiler.read();
			expect(truth.files[0]?.pairs).toMatchObject([
				{
					caller: { name: "run", file: "a.ts", line: 3 },
					callee: { name: "Box", file: "a.ts", line: 1, kind: "class" },
					kind: "new",
				},
				{
					caller: { name: "run", file: "a.ts", line: 3 },
					callee: { name: "tag", file: "a.ts", line: 2, kind: "function" },
					kind: "tag",
				},
			]);
			const coverage = await EnolaCoverage.open(truth, EnolaFacts.parse(""), async () => undefined);
			const measured = coverage.measure("a".repeat(40), "0.4.27").toJSON();
			expect(measured.totals.calls).toBe(2);
			expect(measured.causes).toEqual({ "call:class construction": 1, "call:tagged template": 1 });
		} finally {
			compiler.close();
		}
	});
	it("preserves import kinds, enclosing declarations, and unresolved or external calls", () => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-forms-"));
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true, noEmit: true }, include: ["*.ts"] }),
		);
		writeFileSync(join(root, "b.ts"), "export function target() { return 1; }\nexport type Entry = { x: number };\n");
		writeFileSync(
			join(root, "barrel.ts"),
			"export { target as alias } from './b.ts';\nexport type { Entry } from './b.ts';\n",
		);
		writeFileSync(
			join(root, "a.ts"),
			[
				"import { alias } from './barrel.ts';",
				"import type { Entry } from './b.ts';",
				"export type { Entry } from './b.ts';",
				"const dynamic = import(`./b.ts`);",
				"alias(); alias();",
				"class Box {",
				" constructor() { alias(); }",
				" method() { this.method(); alias(); }",
				" get result() { return alias; }",
				" set value(value: number) { alias(); }",
				"}",
				"interface Contract { go(): void; }",
				"function run(contract: Contract, unknownCall: unknown) {",
				" contract.go();",
				" (unknownCall as (() => void))();",
				" (() => alias())();",
				" const bound: typeof Math.random = Math.random; bound();",
				" new Box().result(); console.log('external');",
				"}",
				"const AnonymousClass = class { run() { alias(); } };",
				"const assigned = function named() { alias(); }; assigned();",
				"",
			].join("\n"),
		);
		const compiler = CompilerGraph.open(root);
		try {
			const truth = compiler.read();
			const file = truth.files.find((file) => file.path === "a.ts")!;
			expect(file.imports.map(({ target, kind, typeOnly }) => ({ target, kind, typeOnly }))).toEqual([
				{ target: "barrel.ts", kind: "import", typeOnly: false },
				{ target: "b.ts", kind: "import", typeOnly: true },
				{ target: "b.ts", kind: "re-export", typeOnly: true },
				{ target: "b.ts", kind: "dynamic", typeOnly: false },
			]);
			expect(
				file.pairs.filter((pair) => pair.caller.kind === "module" && pair.callee.name === "target"),
			).toHaveLength(1);
			expect(file.pairs.find((pair) => pair.throughThis)).toMatchObject({
				caller: { name: "Box.method" },
				callee: { name: "Box.method", kind: "method" },
			});
			expect(truth.symbols).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "Box.constructor", kind: "method" }),
					expect.objectContaining({ name: "Box.value", kind: "method" }),
					expect.objectContaining({ name: "Contract.go", kind: "signature" }),
					expect.objectContaining({ name: expect.stringContaining("<anonymous@"), kind: "anonymous" }),
				]),
			);
			expect(file.pairs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						caller: expect.objectContaining({ name: "run" }),
						callee: expect.objectContaining({ name: "target" }),
					}),
					expect.objectContaining({
						caller: expect.objectContaining({ name: "assigned" }),
						callee: expect.objectContaining({ name: "target" }),
					}),
				]),
			);
			expect(file.external).toBe(2);
			expect(file.unresolved).toBe(1);
		} finally {
			compiler.close();
		}
	});
	it("closes the compiler process when opening a snapshot fails", () => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-open-"));
		const error = new Error("snapshot unavailable");
		vi.spyOn(API.prototype, "updateSnapshot").mockImplementation(() => {
			throw error;
		});
		const close = vi.spyOn(API.prototype, "close");
		expect(() => CompilerGraph.open(root)).toThrow(error);
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("writes ground truth through its standalone entry point and rejects missing arguments", () => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-cli-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["a.ts"] }));
		writeFileSync(join(root, "a.ts"), "function target() {}\ntarget();\n");
		const entry = fileURLToPath(new URL("../src/compiler-graph.ts", import.meta.url));
		const output = join(root, "truth.json");
		execFileSync(process.execPath, ["--conditions=@melian-agent/source", entry, root, output], { stdio: "pipe" });
		expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
			format_version: 1,
			files: [{ path: "a.ts", pairs: [{ caller: { kind: "module" }, callee: { name: "target" } }] }],
		});
		expect(() =>
			execFileSync(process.execPath, ["--conditions=@melian-agent/source", entry], { stdio: "pipe" }),
		).toThrow("Expected repository root and output path");
	});
});
