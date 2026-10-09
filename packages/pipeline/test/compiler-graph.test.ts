import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnolaFacts } from "@melian-agent/core";
import { API, Program } from "typescript/unstable/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompilerGraph, HeadProgram } from "../src/compiler-graph.ts";
import { EnolaCoverage } from "../src/enola-coverage.ts";
import { MutationTests } from "../src/mutation-tests.ts";

let root: string;
afterEach(() => {
	vi.restoreAllMocks();
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("compiler graph extraction", { timeout: 60_000 }, () => {
	it("falls back to the whole suite when the compiler cannot read a listed setup source", () => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-missing-source-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
		writeFileSync(join(root, "a.ts"), "export const a = 1;");
		writeFileSync(join(root, "a.test.ts"), 'import { a } from "./a.ts";');
		writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { setupFiles: "setup.ts" } };');
		const compiler = CompilerGraph.open(root);
		try {
			const graph = compiler.read({ importsOnly: true });
			const get = vi.spyOn(Program.prototype, "getSourceFile").mockImplementation((name) => {
				expect(name).toBe(join(root, "vitest.config.ts"));
				return undefined;
			});
			expect(
				MutationTests.select({ read: () => graph, setupFiles: () => compiler.setupFiles() }, ["a.ts"]).toJSON(),
			).toEqual({ note: expect.stringContaining("whole suite") });
			expect(get).toHaveBeenCalledOnce();
		} finally {
			compiler.close();
		}
	});

	it("bounds import-only extraction without losing the full call graph", () => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-import-bound-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
		writeFileSync(join(root, "a.ts"), 'import { b } from "./b.ts"; export function a() { b(); }');
		writeFileSync(join(root, "b.ts"), "export function b() {} class Empty {}");
		const compiler = CompilerGraph.open(root);
		try {
			const imports = compiler.read({ importsOnly: true, maxFiles: 2, deadline: Date.now() + 60_000 });
			expect(imports.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
			expect(imports.files[0]!.imports).toMatchObject([{ target: "b.ts" }]);
			expect(imports.files[0]!.pairs).toEqual([]);
			expect(imports.symbols).toEqual([]);
			expect(() => compiler.read({ importsOnly: true, maxFiles: 1 })).toThrow("bound");
			const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
			try {
				expect(compiler.read({ importsOnly: true, deadline: 1001 }).files).toHaveLength(2);
				expect(() => compiler.read({ importsOnly: true, deadline: 1000 })).toThrow("bound");
				expect(() => compiler.read({ importsOnly: true, deadline: 999 })).toThrow("bound");
			} finally {
				clock.mockRestore();
			}
			expect(compiler.read().files[0]!.pairs).toHaveLength(1);
		} finally {
			compiler.close();
		}
	});

	it.each(['"setup.ts"', '["setup.ts", "more.ts"]', "[]"])(
		"reads literal setupFiles %s from the configuration closure and ignores test data",
		(value) => {
			root = mkdtempSync(join(tmpdir(), "melian-compiler-setup-"));
			writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
			writeFileSync(join(root, "vitest.config.ts"), 'export { default } from "./settings.ts";');
			writeFileSync(join(root, "settings.ts"), `export default { test: { "setupFiles": ${value} } };`);
			writeFileSync(join(root, "data.test.ts"), "const setupFiles = () => []; const data = { setupFiles };");
			const compiler = CompilerGraph.open(root);
			try {
				compiler.read({ importsOnly: true });
				expect(compiler.setupFiles()).toEqual(
					value === "[]" ? [] : value.startsWith("[") ? ["more.ts", "setup.ts"] : ["setup.ts"],
				);
			} finally {
				compiler.close();
			}
		},
	);

	it.each([
		"{ setupFiles: getFiles() }",
		'{ setupFiles: ["setup.ts", ...more] }',
		"{ setupFiles }",
		'{ setupFiles: "../outside.ts" }',
	])("refuses setup paths the compiler cannot safely supply: %s", (object) => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-setup-computed-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
		writeFileSync(join(root, "vitest.config.ts"), `export default { test: ${object} };`);
		const compiler = CompilerGraph.open(root);
		try {
			compiler.read({ importsOnly: true });
			expect(() => compiler.setupFiles()).toThrow(/computed|outside/);
		} finally {
			compiler.close();
		}
	});

	it("retains unused declarations and selects the implementation of an overload", () => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-declarations-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
		writeFileSync(
			join(root, "a.ts"),
			"function overloaded(x: string): string;\nfunction overloaded(x: number): number;\nfunction overloaded(x: unknown) { return x; }\nfunction run() { overloaded(1); }\nfunction unused() {}\nclass Unused {}\n",
		);
		const compiler = CompilerGraph.open(root);
		try {
			const truth = compiler.read();
			expect(truth.files[0]?.pairs[0]?.callee).toMatchObject({ name: "overloaded", line: 3 });
			expect(truth.symbols).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "unused", line: 5, kind: "function" }),
					expect.objectContaining({ name: "Unused", line: 6, kind: "class" }),
				]),
			);
		} finally {
			compiler.close();
		}
	});
	it("uses physical paths for mixed-case symlink imports", () => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-case-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["a.ts"] }));
		writeFileSync(join(root, "a.ts"), "import { target } from './Link';\nfunction run() { target(); }\n");
		writeFileSync(join(root, "target.ts"), "export function target() {}\n");
		symlinkSync(join(root, "target.ts"), join(root, "Link.ts"));
		const compiler = CompilerGraph.open(root);
		try {
			const truth = compiler.read();
			expect(truth.files.map((file) => file.path)).toEqual(["a.ts", "target.ts"]);
			expect(truth.files[0]?.pairs[0]?.callee.file).toBe("target.ts");
		} finally {
			compiler.close();
		}
	});
	it("closes the compiler API before its worker exits", () => {
		root = mkdtempSync(join(tmpdir(), "melian-compiler-close-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["a.ts"] }));
		writeFileSync(join(root, "a.ts"), "function unused() {}\n");
		const marker = join(root, "closed");
		const preload = join(root, "observe-close.mjs");
		writeFileSync(
			preload,
			`import { API } from ${JSON.stringify(import.meta.resolve("typescript/unstable/sync"))};\nimport { writeFileSync } from 'node:fs';\nAPI.prototype.close = new Proxy(API.prototype.close, { apply(method, receiver, args) { writeFileSync(${JSON.stringify(marker)}, 'closed'); return Reflect.apply(method, receiver, args); } });\n`,
		);
		execFileSync(process.execPath, [
			"--conditions=@melian-agent/source",
			"--import",
			preload,
			fileURLToPath(new URL("../src/compiler-graph.ts", import.meta.url)),
			root,
			join(root, "truth.json"),
		]);
		expect(readFileSync(marker, "utf8")).toBe("closed");
	});
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

describe("head program", { timeout: 60_000 }, () => {
	it("parses each text as the language its extension names, under names of its own", () => {
		const program = HeadProgram.open(
			new Map([
				["src/view.tsx", "export const view = <div />;\n"],
				["src/plain", "const a: number = 1;\n"],
			]),
		);
		try {
			expect(program.source("src/view.tsx")?.statements).toHaveLength(1);
			expect(program.source("src/view.tsx")?.fileName).toBe("/melian-head/f0.tsx");
			expect(program.source("src/plain")?.fileName).toBe("/melian-head/f1.ts");
			expect(program.source("src/plain")?.statements).toHaveLength(1);
			expect(program.source("src/absent.ts")).toBeUndefined();
		} finally {
			program.close();
		}
	});
});

it("reads the named custom Vitest configuration even when its name does not match the default", () => {
	root = mkdtempSync(join(tmpdir(), "melian-custom-vitest-"));
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
	writeFileSync(join(root, "custom.ts"), "export default { test: { setupFiles: `setup.ts` } };");
	const compiler = CompilerGraph.open(root);
	try {
		compiler.read({ importsOnly: true });
		expect(compiler.setupFiles("custom.ts")).toEqual(["setup.ts"]);
		expect(compiler.setupFiles()).toEqual([]);
	} finally {
		compiler.close();
	}
});

describe("mutation setup discovery", () => {
	it.each([
		"vite.config.ts",
		"vitest.config.js",
		"vitest.config.mjs",
		"vite.config.cts",
		"nested/vitest-alt.config.ts",
		"nested/vite.custom.config.mts",
		"nested/vite.config.cjs",
	])("discovers %s beyond the named entry configuration", (path) => {
		root = mkdtempSync(join(tmpdir(), "melian-setup-discovery-"));
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*"] }),
		);
		writeFileSync(join(root, "runner.ts"), "export default {};");
		writeFileSync(join(root, path), 'export default { test: { setupFiles: ["setup.ts"] } };');
		const compiler = CompilerGraph.open(root);
		try {
			compiler.read({ importsOnly: true });
			expect(compiler.setupFiles("runner.ts")).toEqual(["setup.ts"]);
		} finally {
			compiler.close();
		}
	});

	it.each([
		"almostvitest.config.ts",
		"nested/xvite.config.ts",
		"vitestXconfig.ts",
		"vitest.configXts",
		"vitest.customXconfig.ts",
	])("ignores the misleading configuration name %s", (path) => {
		root = mkdtempSync(join(tmpdir(), "melian-setup-nonconfig-"));
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["**/*.ts"] }));
		writeFileSync(join(root, "runner.ts"), "export default {};");
		writeFileSync(join(root, path), "export default { test: { setupFiles: getFiles() } };");
		const compiler = CompilerGraph.open(root);
		try {
			compiler.read({ importsOnly: true });
			expect(compiler.setupFiles("runner.ts")).toEqual([]);
		} finally {
			compiler.close();
		}
	});

	it("does not strip quotes inside another property name", () => {
		root = mkdtempSync(join(tmpdir(), "melian-setup-property-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
		writeFileSync(
			join(root, "vitest.config.ts"),
			`export default { test: { "set'upFiles": getFiles(), "setupFiles'": getFiles() } };`,
		);
		const compiler = CompilerGraph.open(root);
		try {
			compiler.read({ importsOnly: true });
			expect(compiler.setupFiles()).toEqual([]);
		} finally {
			compiler.close();
		}
	});
});

it.each(['["checks/**/*.check.ts"]', "[]", "getIncludes()", "includes"])(
	"reads the head include expression %s without executing it",
	(value) => {
		root = mkdtempSync(join(tmpdir(), "melian-vitest-includes-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
		writeFileSync(
			join(root, "vitest.config.ts"),
			value === "includes"
				? "export default { test: { include } };"
				: `export default { test: { include: ${value} } };`,
		);
		const compiler = CompilerGraph.open(root);
		try {
			compiler.read({ importsOnly: true });
			if (value === "getIncludes()" || value === "includes")
				expect(() => compiler.testIncludes()).toThrow("computed");
			else expect(compiler.testIncludes()).toEqual(value === "[]" ? [] : ["checks/**/*.check.ts"]);
		} finally {
			compiler.close();
		}
	},
);
