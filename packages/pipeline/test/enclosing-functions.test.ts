import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadProgram } from "../src/compiler-graph.ts";
import {
	cutDiffNote,
	type EnclosingFunction,
	EnclosingFunctions,
	enclosingLimits,
} from "../src/enclosing-functions.ts";
import { ChangePrompt } from "../src/review.ts";
import { quoteUntrusted } from "../src/untrusted.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";

vi.mock("../src/untrusted.ts", async (importOriginal) => {
	const original = await importOriginal<{ quoteUntrusted: typeof quoteUntrusted }>();
	return { ...original, quoteUntrusted: vi.fn(original.quoteUntrusted) };
});

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.unstubAllEnvs();
	if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
});

async function around(base: Record<string, string>, head: Record<string, string>): Promise<EnclosingFunctions> {
	repo = baseAndHead(base, head);
	return EnclosingFunctions.read(await Changeset.resolve(repo, "main...feature"));
}

const summary = (found: EnclosingFunctions) =>
	found.functions.map(({ path, name, startLine, endLine }) => `${path} ${name} ${startLine}-${endLine}`);

const source = lines(
	"export function outer(a: number): number {",
	"\tconst inner = (b: number) => b + a;",
	"\t[1].map((item) => item + a);",
	"\treturn inner(a);",
	"}",
	"",
	"export class Box {",
	"\tconstructor(readonly size: number) {}",
	"\tgrow(by: number): number {",
	"\t\treturn this.size + by;",
	"\t}",
	"\tget double(): number {",
	"\t\treturn this.size * 2;",
	"\t}",
	"\tfield = () => 1;",
	"}",
	"",
	"export const top = 1;",
	"export const arrow = (x: number) => x;",
);

describe("EnclosingFunctions", () => {
	it("finds the innermost named function around an added line", async () => {
		const edited = source
			.replace("\treturn inner(a);", "\treturn inner(a) + 1;")
			.replace("\t\treturn this.size + by;", "\t\treturn this.size + by + 1;")
			.replace("\t\treturn this.size * 2;", "\t\treturn this.size * 3;")
			.replace("\tconstructor(readonly size: number) {}", "\tconstructor(readonly size: number, x = 1) {}")
			.replace("\tfield = () => 1;", "\tfield = () => 2;")
			.replace("export const arrow = (x: number) => x;", "export const arrow = (x: number) => x + 1;");
		const found = await around({ "src/a.ts": source }, { "src/a.ts": edited });

		expect(summary(found)).toEqual([
			"src/a.ts outer 1-5",
			"src/a.ts Box.constructor 8-8",
			"src/a.ts Box.grow 9-11",
			"src/a.ts Box.double 12-14",
			"src/a.ts Box.field 15-15",
			"src/a.ts arrow 19-19",
		]);
		expect(found.functions[0]!.lines).toEqual(edited.split("\n").slice(0, 5));
		expect(found.unavailable).toBeUndefined();
	});

	it("takes the innermost function when several start on one line", async () => {
		const multiline = lines(
			"export function outer() { const inner = () => {",
			"\treturn 2;",
			"};",
			"return inner(); }",
		);
		const signature = multiline.replace("outer()", "outer(x = 1)");
		expect(summary(await around({ "src/a.ts": multiline }, { "src/a.ts": signature }))).toEqual([
			"src/a.ts inner 1-3",
			"src/a.ts outer 1-4",
		]);
		const edited = multiline.replace("\treturn 2;", "\treturn 3;");
		expect(summary(await around({ "src/a.ts": multiline }, { "src/a.ts": edited }))).toEqual(["src/a.ts inner 1-3"]);
		const closing = multiline.replace("return inner(); }", "return inner() + 1; }");
		expect(summary(await around({ "src/a.ts": multiline }, { "src/a.ts": closing }))).toEqual(["src/a.ts outer 1-4"]);

		const oneLine = "export const outer = () => { const inner = () => 1; return inner(); };";
		const changed = oneLine.replace("=> 1;", "=> 2;");
		expect(summary(await around({ "src/b.ts": oneLine }, { "src/b.ts": changed }))).toEqual(["src/b.ts inner 1-1"]);
	});
	it("carries both callables on a shared closing line, and refuses one outside a deletion anchor", async () => {
		const closing = lines("function outer() {", " const inner = () => {", "  return 1;", " }; return inner(); }");
		const edited = closing.replace("return inner()", "return inner() + 1");
		expect(summary(await around({ "src/a.ts": closing }, { "src/a.ts": edited }))).toEqual([
			"src/a.ts outer 1-4",
			"src/a.ts inner 2-4",
		]);
		const atStart = lines("function outer() { const inner = () => 1;", " const a = 1;", " return inner();", "}");
		expect(
			summary(await around({ "src/a.ts": atStart }, { "src/a.ts": atStart.replace(" const a = 1;\n", "") })),
		).toEqual(["src/a.ts outer 1-3"]);
		const deleting = lines("function outer() {", " const a = 1;", " const inner = () => 2;", " return inner();", "}");
		expect(
			summary(await around({ "src/a.ts": deleting }, { "src/a.ts": deleting.replace(" const a = 1;\n", "") })),
		).toEqual(["src/a.ts outer 1-4"]);
	});

	it("takes the named function around an anonymous callback, and the innermost named one around a nested value", async () => {
		const edited = source.replace("\t[1].map((item) => item + a);", "\t[1].map((item) => item + a + 1);");
		expect(summary(await around({ "src/a.ts": source }, { "src/a.ts": edited }))).toEqual(["src/a.ts outer 1-5"]);

		const nested = source.replace(
			"\tconst inner = (b: number) => b + a;",
			"\tconst inner = (b: number) => b + a + 1;",
		);
		expect(summary(await around({ "src/a.ts": source }, { "src/a.ts": nested }))).toEqual(["src/a.ts inner 2-2"]);
	});

	it("carries a function once however many hunks touch it", async () => {
		const edited = source
			.replace("(a: number): number {", "(a: number, z = 0): number {")
			.replace("\treturn inner(a);", "\treturn inner(a) + z;");
		expect(summary(await around({ "src/a.ts": source }, { "src/a.ts": edited }))).toEqual(["src/a.ts outer 1-5"]);
	});

	it("carries nothing for a line outside every function", async () => {
		const edited = source.replace("export const top = 1;", "export const top = 2;");
		expect((await around({ "src/a.ts": source }, { "src/a.ts": edited })).functions).toEqual([]);
	});

	it("finds the function a deletion sits inside, and none for one between functions", async () => {
		const inside = source.replace("\t[1].map((item) => item + a);\n", "");
		expect(summary(await around({ "src/a.ts": source }, { "src/a.ts": inside }))).toEqual(["src/a.ts outer 1-4"]);

		const between = source.replace("\n\nexport class Box", "\nexport class Box");
		expect((await around({ "src/a.ts": source }, { "src/a.ts": between })).functions).toEqual([]);
	});

	it("leaves a file that is not TypeScript, a declaration file, and a deleted file to the lens", async () => {
		repo = baseAndHead(
			{ "a.py": "def f():\n    return 1\n", "a.d.ts": "export declare function f(): number;\n", "gone.ts": source },
			{ "a.py": "def f():\n    return 2\n", "a.d.ts": "export declare function f(): string;\n" },
		);
		gitIn(repo, "rm", "--quiet", "gone.ts");
		gitIn(repo, "commit", "--quiet", "-m", "remove");
		const found = await EnclosingFunctions.read(await Changeset.resolve(repo, "main...feature"));
		expect(found.functions).toEqual([]);
		expect(found.unavailable).toBeUndefined();
	});

	it("reads .tsx and .mts files as the language they are", async () => {
		const jsx = lines("export function View() {", "\treturn <div>a</div>;", "}");
		const found = await around(
			{ "src/v.tsx": jsx, "src/m.mts": "export function m() {\n\treturn 1;\n}\n" },
			{ "src/v.tsx": jsx.replace("a</div>", "b</div>"), "src/m.mts": "export function m() {\n\treturn 2;\n}\n" },
		);
		expect(summary(found)).toEqual(["src/m.mts m 1-3", "src/v.tsx View 1-3"]);
	});

	it("follows a renamed file by its head path", async () => {
		repo = baseAndHead({ "old.ts": source }, {});
		gitIn(repo, "mv", "old.ts", "new.ts");
		const renamed = source.replace("\treturn inner(a);", "\treturn inner(a) + 1;");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(`${repo}/new.ts`, renamed);
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "rename and edit");
		const found = await EnclosingFunctions.read(await Changeset.resolve(repo, "main...feature"));
		expect(summary(found)).toEqual(["new.ts outer 1-5"]);
	});

	it.each([
		["U+2028", String.fromCharCode(0x2028)],
		["a lone CR", "\r"],
		["U+2029", String.fromCharCode(0x2029)],
	])("numbers lines as git does in a file holding %s before the function", async (_, separator) => {
		const head = (tail: string) =>
			lines(
				`// before${separator}after`,
				"export function first() {",
				"\treturn 1;",
				"}",
				"",
				"export function target() {",
				`\treturn ${tail};`,
				"}",
			);
		const found = await around({ "src/a.ts": head("2") }, { "src/a.ts": head("3") });

		expect(summary(found)).toEqual(["src/a.ts target 6-8"]);
		expect(found.functions[0]!.lines).toEqual(head("3").split("\n").slice(5, 8));
	});

	describe("the name a function is carried under", () => {
		it.each([
			["a default-exported arrow", "export default () => {\n\treturn 1;\n};\n", "return 1", "default 1-3"],
			[
				"an unnamed default-exported function",
				"export default function () {\n\treturn 1;\n}\n",
				"return 1",
				"default 1-3",
			],
			[
				"a named default-exported function",
				"export default function run() {\n\treturn 1;\n}\n",
				"return 1",
				"run 1-3",
			],
			["an arrow held by an object property", "const o = { run: () => 1 };\n", "=> 1", "run 1-1"],
			[
				"an arrow held by an object property inside a class",
				"class K {\n\tm() {\n\t\treturn { run: () => 1 };\n\t}\n}\n",
				"=> 1",
				"run 3-3",
			],
			[
				"a function expression held by a variable",
				"const f = function () {\n\treturn 1;\n};\n",
				"return 1",
				"f 1-3",
			],
			[
				"a set accessor",
				"class K {\n\tset v(x: number) {\n\t\tthis.w = x;\n\t}\n\tw = 0;\n}\n",
				"this.w = x",
				"K.v 2-4",
			],
			["an object-literal method", "const o = {\n\tgo() {\n\t\treturn 1;\n\t},\n};\n", "return 1", "go 2-4"],
			[
				"a method with a computed name",
				'const o = {\n\t["a" + "b"]() {\n\t\treturn 1;\n\t},\n};\n',
				"return 1",
				'["a" + "b"] 2-4',
			],
			[
				"a method of an unnamed default-exported class",
				"export default class {\n\trun() {\n\t\treturn 1;\n\t}\n}\n",
				"return 1",
				"run 2-4",
			],
			[
				"a method of a named class expression",
				"const C = class Inner {\n\trun() {\n\t\treturn 1;\n\t}\n};\n",
				"return 1",
				"Inner.run 2-4",
			],
		])("%s", async (_, text, edit, expected) => {
			const found = await around({ "src/a.ts": text }, { "src/a.ts": text.replace(edit, `${edit} + 1`) });
			expect(summary(found)).toEqual([`src/a.ts ${expected}`]);
		});

		const named = (length: number, letter: string) => `f${letter.repeat(length - 1)}`;
		it.each([
			["x", enclosingLimits.nameBytes, enclosingLimits.nameBytes],
			["x", enclosingLimits.nameBytes + 1, enclosingLimits.nameBytes],
			["é", enclosingLimits.nameBytes / 2, enclosingLimits.nameBytes],
			["é", enclosingLimits.nameBytes / 2 + 1, enclosingLimits.nameBytes],
		])(
			"keeps at most its first nameBytes bytes of a name of %s x %i characters",
			async (letter, characters, kept) => {
				const name = named(characters, letter);
				const text = `export function ${name}() {\n\treturn 1;\n}\n`;
				const found = await around({ "src/a.ts": text }, { "src/a.ts": text.replace("1", "2") });
				const carried = found.functions[0]!.name;
				expect(Buffer.byteLength(carried)).toBeLessThanOrEqual(kept);
				expect(carried).toBe(name.slice(0, carried.length));
				expect(carried.length).toBe(Math.min(name.length, letter === "x" ? kept : kept / 2));
			},
		);
	});

	describe("a function's length", () => {
		const long = (count: number, tail: string) =>
			lines(
				"export function long() {",
				...Array.from({ length: count - 3 }, (_, index) => `\tvoid ${index};`),
				`\t${tail}`,
				"}",
			);

		it.each([
			[enclosingLimits.functionLines, true],
			[enclosingLimits.functionLines + 1, false],
		] as const)("with %i lines is %s carried whole", async (count, carried) => {
			const found = await around(
				{ "src/long.ts": long(count, "void 0;") },
				{ "src/long.ts": long(count, "void 1;") },
			);
			expect(found.functions).toHaveLength(1);
			expect(found.functions[0]!.lines !== undefined).toBe(carried);
			expect(found.functions[0]).toMatchObject({ startLine: 1, endLine: count });
		});
	});

	describe("a file's size", () => {
		const padded = (bytes: number, tail: string) => {
			const head = `export function f() {\n\treturn ${tail};\n}\n`;
			return `${head}// ${"x".repeat(bytes - Buffer.byteLength(head) - 4)}\n`;
		};

		it.each([
			[enclosingLimits.fileBytes, 1],
			[enclosingLimits.fileBytes + 1, 0],
		] as const)("of %i bytes carries %i functions", async (bytes, count) => {
			const found = await around({ "src/big.ts": padded(bytes, "1") }, { "src/big.ts": padded(bytes, "2") });
			expect(found.functions).toHaveLength(count);
		});
	});

	it("reads at most as many files as it is limited to", { timeout: 60_000 }, async () => {
		const many = (tail: string) =>
			Object.fromEntries(
				Array.from({ length: enclosingLimits.files + 1 }, (_, index) => [
					`src/f${String(index).padStart(3, "0")}.ts`,
					`export function f${index}() {\n\treturn ${tail};\n}\n`,
				]),
			);
		const found = await around(many("1"), many("2"));
		expect(found.functions).toHaveLength(enclosingLimits.files);
		expect(found.functions.at(-1)!.path).toBe(`src/f${String(enclosingLimits.files - 1).padStart(3, "0")}.ts`);
	});

	describe("work limits", { timeout: 120_000 }, () => {
		const oneLiners = (count: number, changed: number) =>
			lines(...Array.from({ length: count }, (_, index) => `function f${index}(){${index < changed ? "0" : ""}}`));
		const addedLines = (count: number, mark: string) =>
			lines(
				"export function big() {",
				...Array.from({ length: count }, (_, index) => `\tvoid ${index}${mark};`),
				"}",
			);
		const filesOf = (names: readonly string[], make: (changed: boolean) => string, extra?: string) => {
			const build = (changed: boolean) => ({
				...Object.fromEntries(names.map((name) => [name, make(changed)])),
				...(extra === undefined ? {} : { [extra]: changed ? "function z(){0}\n" : "function z(){}\n" }),
			});
			return [build(false), build(true)] as const;
		};
		const names = (count: number) => Array.from({ length: count }, (_, index) => `src/a${index}.ts`);
		const nonce = "b".repeat(24);

		it.each([
			[enclosingLimits.anchorsPerFile, []],
			[enclosingLimits.anchorsPerFile + 1, ["anchorsPerFile"]],
		] as const)("takes a file of %i added lines and holds back %j", async (count, capped) => {
			const found = await around({ "src/a.ts": addedLines(count, "") }, { "src/a.ts": addedLines(count, "+ 1") });
			expect(found.functions).toHaveLength(capped.length === 0 ? 1 : 0);
			expect(found.capped).toEqual(capped);
			expect(found.blocks(undefined, nonce).join("\n").includes("Some functions were not read, because")).toBe(
				capped.length > 0,
			);
		});

		const deletions = (count: number, deleted: boolean) =>
			lines(
				"export function big() {",
				...Array.from({ length: count }, (_, index) => (deleted ? "\tkeep;" : `\tkeep;\n\tvoid ${index};`)),
				"}",
			);
		it.each([
			[enclosingLimits.anchorsPerFile, []],
			[enclosingLimits.anchorsPerFile + 1, ["anchorsPerFile"]],
		] as const)("takes a file of %i deletion-only hunks and holds back %j", async (count, capped) => {
			const found = await around({ "src/a.ts": deletions(count, false) }, { "src/a.ts": deletions(count, true) });
			expect(found.capped).toEqual(capped);
			expect(found.functions).toHaveLength(capped.length === 0 ? 1 : 0);
		});

		it.each([
			[false, 4, []],
			[true, 4, ["anchors"]],
		] as const)(
			"takes files together, with an extra file past the total %j, from %i files of the per-file limit",
			async (past, count, capped) => {
				const [base, head] = filesOf(
					names(count),
					(changed) => addedLines(enclosingLimits.anchorsPerFile, changed ? "+ 1" : ""),
					past ? "src/z.ts" : undefined,
				);
				const found = await around(base, head);
				expect(found.capped).toEqual(capped);
				expect(found.functions.map((each) => each.path)).toEqual(names(count));
			},
		);

		it.each([
			[enclosingLimits.callablesPerFile, []],
			[enclosingLimits.callablesPerFile + 1, ["callablesPerFile"]],
		] as const)("takes a file of %i named functions and holds back %j", async (count, capped) => {
			const found = await around({ "src/a.ts": oneLiners(count, 0) }, { "src/a.ts": oneLiners(count, 1) });
			expect(found.functions).toHaveLength(capped.length === 0 ? 1 : 0);
			expect(found.capped).toEqual(capped);
		});

		it.each([
			[false, []],
			[true, ["callables"]],
		] as const)("takes the files together up to %j past the total of named functions", async (past, capped) => {
			const count = enclosingLimits.callables / enclosingLimits.callablesPerFile;
			const [base, head] = filesOf(
				names(count),
				(changed) => oneLiners(enclosingLimits.callablesPerFile, changed ? 1 : 0),
				past ? "src/z.ts" : undefined,
			);
			const found = await around(base, head);
			expect(found.capped).toEqual(capped);
			expect(found.functions.map((each) => each.path)).toEqual(names(count));
		});

		it.each([
			[enclosingLimits.found, []],
			[enclosingLimits.found + 1, ["found"]],
		] as const)("holds %i functions and holds back %j", async (count, capped) => {
			const found = await around({ "src/a.ts": oneLiners(count, 0) }, { "src/a.ts": oneLiners(count, count) });
			expect(found.functions).toHaveLength(enclosingLimits.found);
			expect(found.capped).toEqual(capped);
			expect(found.blocks(undefined, nonce).at(-1)?.startsWith("Some functions were not read, because")).toBe(
				capped.length > 0,
			);
		});

		it("stops asking the compiler once the found cap has refused a function", async () => {
			const source = vi.spyOn(HeadProgram.prototype, "source");
			try {
				const found = await around(
					{ "src/a.ts": oneLiners(2_001, 0), "src/b.ts": "function b() { return 0; }" },
					{ "src/a.ts": oneLiners(2_001, 2_001), "src/b.ts": "function b() { return 1; }" },
				);
				expect(found.capped).toEqual(["found"]);
				expect(source.mock.calls).toEqual([["src/a.ts"]]);
			} finally {
				source.mockRestore();
			}
		});

		it("keeps the limits it documents", () => {
			expect({ ...enclosingLimits }).toMatchObject({
				anchorsPerFile: 5_000,
				anchors: 20_000,
				callablesPerFile: 20_000,
				callables: 100_000,
				found: 2_000,
			});
		});

		it("renders no block once the byte budget has no room for it", async () => {
			const body = (mark: string) =>
				lines(
					...Array.from({ length: 100 }, (_, fn) => [
						`function g${fn}() {`,
						`\tvoid ${mark}0;`,
						...Array.from({ length: 98 }, (_, row) => `\tvoid ${"y".repeat(20)} + ${row};`),
						"}",
					]).flat(),
				);
			repo = baseAndHead({ "src/a.ts": body("") }, { "src/a.ts": body("1 + ") });
			const found = await EnclosingFunctions.read(await Changeset.resolve(repo, "main...feature"));
			expect(found.functions).toHaveLength(100);
			vi.mocked(quoteUntrusted).mockClear();
			const parts = found.blocks(undefined, nonce);
			const rendered = vi.mocked(quoteUntrusted).mock.calls.filter(([label]) => label === "function").length;
			const shown = parts.filter((part) => part.includes('label="function"')).length;
			expect(shown).toBeGreaterThan(5);
			expect(shown).toBeLessThan(40);
			expect(rendered).toBeLessThanOrEqual(shown + 2);
		});

		it("never filters a file's whole list of functions once per added line", async () => {
			repo = baseAndHead({ "src/a.ts": oneLiners(20_000, 0) }, { "src/a.ts": oneLiners(20_000, 2_000) });
			const changeset = await Changeset.resolve(repo, "main...feature");
			const filter = vi.spyOn(Array.prototype, "filter");
			try {
				await EnclosingFunctions.read(changeset);
				expect(filter.mock.contexts.filter((list) => (list as unknown[]).length >= 10_000)).toHaveLength(0);
			} finally {
				filter.mockRestore();
			}
		});

		// Counts the work the sweep hands to sort comparators and filter predicates, which a per-anchor filter and sort
		// multiplies by the number of anchors. No clock: counts are the same on every runner.
		it("does work that grows with n log n in the callables and anchors, not their product", async () => {
			const worked = async (functions: number, changed: number) => {
				const dir = baseAndHead(
					{ "src/a.ts": oneLiners(functions, 0) },
					{ "src/a.ts": oneLiners(functions, changed) },
				);
				const sort = Array.prototype.sort;
				const filter = Array.prototype.filter;
				let calls = 0;
				const sorted = vi.spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare) {
					return sort.call(
						this,
						compare === undefined
							? undefined
							: (a: unknown, b: unknown) => {
									calls++;
									return compare(a, b);
								},
					);
				});
				const filtered = vi.spyOn(Array.prototype, "filter").mockImplementation(function (
					this: unknown[],
					predicate: (...args: unknown[]) => unknown,
					thisArg?: unknown,
				) {
					return filter.call(
						this,
						(...args: unknown[]) => {
							calls++;
							return predicate(...args);
						},
						thisArg,
					);
				} as typeof Array.prototype.filter);
				try {
					await EnclosingFunctions.read(await Changeset.resolve(dir, "main...feature"));
					return calls;
				} finally {
					sorted.mockRestore();
					filtered.mockRestore();
					rmSync(dir, { recursive: true, force: true });
				}
			};
			for (const [functions, changed] of [
				[2_500, 625],
				[20_000, 5_000],
			] as const) {
				const size = functions + changed;
				expect(await worked(functions, changed)).toBeLessThan(size * Math.log2(size));
			}
		});
	});
});

describe("ChangePrompt with functions", () => {
	const nonce = "a".repeat(24);
	const edited = source
		.replace("\treturn inner(a);", "\treturn inner(a) + 1;")
		.replace("export const top = 1;", "export const top = 2;");

	async function prompted(only?: readonly string[], withFunctions = true) {
		repo = baseAndHead({ "src/a.ts": source, "src/b.ts": source }, { "src/a.ts": edited, "src/b.ts": edited });
		const changeset = await Changeset.resolve(repo, "main...feature");
		const functions = await EnclosingFunctions.read(changeset);
		return new ChangePrompt(changeset, nonce).render(only, withFunctions ? { functions } : {});
	}

	it("adds each function in a block of its own after the diffs, with numbered lines", async () => {
		const text = await prompted();
		expect(text).toContain("Enclosing functions:");
		expect(text).toContain(
			`<untrusted-${nonce} label="function">\nsrc/a.ts:1-5 outer\n1\texport function outer(a: number): number {`,
		);
		expect(text).toContain("4\t\treturn inner(a) + 1;");
		expect(text.indexOf('label="function"')).toBeGreaterThan(text.lastIndexOf('label="diff"'));
		expect(text.match(/label="function"/g)).toHaveLength(2);
	});

	it("limits the blocks to the files asked for", async () => {
		const text = await prompted(["src/b.ts"]);
		expect(text.match(/label="function"/g)).toHaveLength(1);
		expect(text).toContain("src/b.ts:1-5 outer");
		expect(text).not.toContain("src/a.ts:1-5 outer");
	});

	it("adds nothing when it is not given functions", async () => {
		const text = await prompted(undefined, false);
		expect(text).not.toContain("Enclosing functions");
		expect(text).not.toContain('label="function"');
	});

	it("escapes control characters in a path and a function name, in a block's label and in the listing", async () => {
		const path = `src/evil${String.fromCharCode(10)}9: forged.ts`;
		const method = (name: string, count: number, mark: string) => [
			`\t[${name}]() {`,
			...Array.from({ length: count }, (_, index) => `\t\tvoid ${index}${mark};`),
			"\t}",
		];
		const body = (mark: string) =>
			lines(
				"export class K {",
				...method('"short" +\n\t\t"name"', 3, mark),
				...method('"long" +\n\t\t"name"', enclosingLimits.functionLines, mark),
				"}",
			);
		repo = baseAndHead({ [path]: body("") }, { [path]: body("+ 1") });
		const changeset = await Changeset.resolve(repo, "main...feature");
		const functions = await EnclosingFunctions.read(changeset);
		const text = new ChangePrompt(changeset, nonce).render(undefined, { functions });

		const rows = text.split("\n");
		expect(rows.find((row) => row.includes('K.["short"'))).toMatch(
			/^src\/evil\\u000a9: forged\.ts:\d+-\d+ K\.\["short" \+\\u000a\\u0009\\u0009"name"\]$/,
		);
		expect(rows.find((row) => row.includes('K.["long"'))).toMatch(
			/^src\/evil\\u000a9: forged\.ts:\d+-\d+ K\.\["long" \+\\u000a\\u0009\\u0009"name"\]$/,
		);
		expect(text).toMatch(/label="function">\nsrc\/evil\\u000a9/);
		expect(text).toMatch(/label="listing">\nsrc\/evil\\u000a9/);
		expect(text.split("\n").filter((line) => line.startsWith("9: forged.ts"))).toEqual([]);
	});

	it("lists a function past the byte limit, and a long one, for read_file", async () => {
		const body = (count: number) =>
			lines(
				"export function big() {",
				...Array.from({ length: count }, (_, index) => `\tvoid ${"y".repeat(200)} + ${index};`),
				"}",
			);
		const rows = 200;
		const baseFiles = Object.fromEntries(["a", "b", "c"].map((name) => [`src/${name}.ts`, body(rows)]));
		const headFiles = Object.fromEntries(
			["a", "b", "c"].map((name) => [`src/${name}.ts`, body(rows).replace("void ", "void 1 + ")]),
		);
		repo = baseAndHead(baseFiles, headFiles);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const functions = await EnclosingFunctions.read(changeset);
		const text = new ChangePrompt(changeset, nonce).render(undefined, { functions });
		expect(text.match(/label="function"/g)?.length).toBeLessThan(3);
		expect(text).toContain(
			"Functions not shown, because they are long or the limit was reached; read each with read_file:",
		);
		expect(text).toMatch(/label="listing">\nsrc\/[bc]\.ts:1-\d+ big/);
	});

	// A single function whose block is exactly `bytes` long, found by measuring one trial and adjusting its padding.
	async function blockOf(bytes: number): Promise<{ text: string; size: number }> {
		const build = (pad: number, tail: string) =>
			lines("export function f() {", `\t// ${"x".repeat(pad)}`, `\treturn ${tail};`, "}");
		const render = async (pad: number) => {
			repo = baseAndHead({ "src/f.ts": build(pad, "1") }, { "src/f.ts": build(pad, "2") });
			const changeset = await Changeset.resolve(repo, "main...feature");
			const functions = await EnclosingFunctions.read(changeset);
			const text = new ChangePrompt(changeset, nonce).render(undefined, { functions });
			rmSync(repo, { recursive: true, force: true });
			const block = /<untrusted-a+ label="function">[\s\S]*?<\/untrusted-a+>/.exec(text)?.[0];
			return { text, size: block === undefined ? 0 : Buffer.byteLength(block) };
		};
		const trial = await render(1000);
		return render(1000 + bytes - trial.size);
	}

	it.each([
		[enclosingLimits.promptBytes, true],
		[enclosingLimits.promptBytes + 1, false],
	] as const)("with a block of %i bytes shows it is %s", async (bytes, shown) => {
		const { text, size } = await blockOf(bytes);
		expect(text.includes('label="function"')).toBe(shown);
		if (shown) expect(size).toBe(bytes);
		else expect(text).toMatch(/label="listing">\nsrc\/f\.ts:1-4 f\n/);
	});

	describe("the listing of functions not shown", () => {
		const listing = (functions: EnclosingFunction[]) =>
			Object.assign(EnclosingFunctions.none(), { functions }).blocks(undefined, nonce);
		const left = (index: number, name = "long"): EnclosingFunction => ({
			path: `src/l${String(index).padStart(3, "0")}.ts`,
			name,
			startLine: 1,
			endLine: 300,
		});
		const entries = (parts: string[]) =>
			/label="listing">\n([^<]*)<\/untrusted/.exec(parts.join("\n"))?.[1]?.split("\n").filter(Boolean) ?? [];
		const more = (parts: string[]) => /and (\d+) more not listed here/.exec(parts.join("\n"))?.[1];

		it.each([
			[enclosingLimits.listed, undefined],
			[enclosingLimits.listed + 1, "1"],
		] as const)("lists %i functions and says how many more it left out: %s", (count, omitted) => {
			const parts = listing(Array.from({ length: count }, (_, index) => left(index)));
			expect(entries(parts)).toHaveLength(Math.min(count, enclosingLimits.listed));
			expect(more(parts)).toBe(omitted);
		});

		// One function whose block is exactly `bytes` long, then a function to list that costs `label` bytes with its newline.
		const shown = (bytes: number): EnclosingFunction => {
			const make = (pad: number): EnclosingFunction => ({
				path: "src/a.ts",
				name: "a",
				startLine: 1,
				endLine: 1,
				lines: ["x".repeat(pad)],
			});
			const size = (each: EnclosingFunction) =>
				Buffer.byteLength(
					/<untrusted-a+ label="function">[\s\S]*?<\/untrusted-a+>/.exec(listing([each]).join("\n"))![0],
				);
			return make(1000 + bytes - size(make(1000)));
		};

		it.each([
			[0, true],
			[1, false],
		] as const)("counts the listing against the byte limit: %i bytes over lists it, %s", (over, listed) => {
			const toList = left(1);
			const label = `${toList.path}:1-300 long`;
			const parts = listing([shown(enclosingLimits.promptBytes - Buffer.byteLength(label) - 1 + over), toList]);
			expect(entries(parts)).toEqual(listed ? [label] : []);
			expect(more(parts)).toBe(listed ? undefined : "1");
			expect(parts.join("\n")).toContain('label="function"');
		});

		it.each([
			[0, true],
			[1, false],
		] as const)(
			"counts a listed name against the blocks after it: %i bytes over shows the block, %s",
			(over, kept) => {
				const toList = left(1);
				const label = `${toList.path}:1-300 long`;
				const parts = listing([toList, shown(enclosingLimits.promptBytes - Buffer.byteLength(label) - 1 + over)]);
				expect(parts.join("\n").includes('label="function"')).toBe(kept);
			},
		);
	});

	describe("what it leaves out, the prompt says", { timeout: 60_000 }, () => {
		const note = (found: EnclosingFunctions) => found.blocks(undefined, nonce).join("\n");
		const tiny = (changed: boolean) => `function f(){${changed ? "1" : ""}}\n`;
		// A file of exactly `size` bytes whose first line is the hunk.
		const sized = (size: number, changed: boolean) => {
			const first = tiny(changed);
			return `${first}${"/".repeat(size - Buffer.byteLength(first) - 1)}\n`;
		};

		it.each([
			[enclosingLimits.files, []],
			[enclosingLimits.files + 1, ["files"]],
		] as const)("takes %i TypeScript files and holds back %j", async (count, capped) => {
			const build = (changed: boolean) =>
				Object.fromEntries(Array.from({ length: count }, (_, index) => [`src/f${index}.ts`, tiny(changed)]));
			const found = await around(build(false), build(true));
			expect(found.capped).toEqual(capped);
			expect(note(found).includes(`more than ${enclosingLimits.files} TypeScript files changed`)).toBe(
				capped.length > 0,
			);
			expect(found.functions).toHaveLength(enclosingLimits.files);
		});

		it.each([
			[enclosingLimits.fileBytes, []],
			[enclosingLimits.fileBytes + 1, ["fileBytes"]],
		] as const)("takes a TypeScript file of %i bytes and holds back %j", async (size, capped) => {
			const found = await around({ "src/a.ts": sized(size, false) }, { "src/a.ts": sized(size, true) });
			expect(found.capped).toEqual(capped);
			expect(found.functions).toHaveLength(capped.length === 0 ? 1 : 0);
			expect(note(found).includes("a TypeScript file was larger than 512 KiB")).toBe(capped.length > 0);
		});

		it("says a TypeScript file it could not read at the head, and ignores a deleted one", async () => {
			repo = baseAndHead(
				{ "src/a.ts": tiny(false), "src/gone.ts": tiny(false) },
				{ "src/a.ts": tiny(true), "src/gone.ts": "" },
			);
			gitIn(repo, "rm", "--quiet", "src/gone.ts");
			gitIn(repo, "commit", "--quiet", "-m", "delete");
			const clean = await EnclosingFunctions.read(await Changeset.resolve(repo, "main...feature"));
			expect(clean.capped).toEqual([]);
			rmSync(join(repo, "src/a.ts"));
			symlinkSync("elsewhere.ts", join(repo, "src/linked.ts"));
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "link");
			const found = await EnclosingFunctions.read(await Changeset.resolve(repo, "main...feature"));
			expect(found.capped).toEqual(["unreadable"]);
			expect(note(found)).toContain("a TypeScript file could not be read at the head");
		});

		it("says the diff was cut when it carries no function", async () => {
			const big = Array.from({ length: 10_000 }, (_, index) => `line ${index} ${"x".repeat(30)}`).join("\n");
			repo = baseAndHead({ "src/a.ts": source, "big.txt": "" }, { "src/a.ts": edited, "big.txt": `${big}\n` });
			const changeset = await Changeset.resolve(repo, "main...feature");
			const functions = await EnclosingFunctions.read(changeset);
			const input = new ChangePrompt(changeset, nonce).renderInput(undefined, { functions });
			expect(input.cut).toBe(true);
			expect(input.text).toContain(cutDiffNote);
			const hunksOnly = new ChangePrompt(changeset, nonce).renderInput(undefined);
			expect(hunksOnly.text).not.toContain(cutDiffNote);
			const whole = new ChangePrompt(changeset, nonce).renderInput(["src/a.ts"], { functions });
			expect(whole.cut).toBe(false);
			expect(whole.text).not.toContain(cutDiffNote);
		});
	});

	it("adds none after a diff the prompt had to cut", async () => {
		const big = Array.from({ length: 10_000 }, (_, index) => `line ${index} ${"x".repeat(30)}`).join("\n");
		repo = baseAndHead({ "src/a.ts": source, "big.txt": "" }, { "src/a.ts": edited, "big.txt": `${big}\n` });
		const changeset = await Changeset.resolve(repo, "main...feature");
		const functions = await EnclosingFunctions.read(changeset);
		const input = new ChangePrompt(changeset, nonce).renderInput(undefined, { functions });
		expect(input.cut).toBe(true);
		expect(functions.functions).toHaveLength(1);
		expect(input.text).not.toContain("Enclosing functions");
	});
});
