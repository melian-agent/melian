import { rmSync } from "node:fs";
import { Changeset } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnclosingFunctions, enclosingLimits } from "../src/enclosing-functions.ts";
import { ChangePrompt } from "../src/review.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";

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
