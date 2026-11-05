import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HeadProgram } from "../src/compiler-graph.ts";
import { enclosingLimits, SymbolEnds } from "../src/enclosing-functions.ts";
import { commit, createRepository, removeRepository } from "./fixtures/repo.ts";

let repo: string;
beforeEach(() => {
	repo = createRepository();
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

it("ends a symbol where the compiler ends its outermost node, and knows nothing of a file it did not parse", async () => {
	const head = commit(repo, {
		"src/a.ts": "/** Doc. */\nexport function alpha() {\n\treturn [\n\t\t1,\n\t];\n}\nexport const beta = 1;\n",
		// Reads as TypeScript, so only the file's name keeps the compiler from it.
		"docs/a.md": "export const x = [\n\t1,\n];\n",
	});
	const ends = await SymbolEnds.read(repo, head, ["src/a.ts", "docs/a.md", "src/missing.ts"]);
	expect(ends.endLine("src/a.ts", 2)).toBe(6);
	expect(ends.endLine("src/a.ts", 7)).toBe(7);
	// An array element declares nothing.
	expect(ends.endLine("src/a.ts", 4)).toBeUndefined();
	expect(ends.endLine("docs/a.md", 1)).toBeUndefined();
	expect(ends.endLine("src/missing.ts", 1)).toBeUndefined();
});

it("ends a declaration Enola names by its keyword or name line where the whole declaration ends", async () => {
	const head = commit(repo, {
		"src/default.ts": "export default\nclass Service {\n\trun() {\n\t\treturn 2;\n\t}\n}\n",
		"src/decorated.ts": "@sealed\nexport class Store {\n\tget() {\n\t\treturn 1;\n\t}\n}\n",
		"src/shared.ts": "export class A { m() { return 1; }\n\tn() {}\n}\n",
	});
	const ends = await SymbolEnds.read(repo, head, ["src/default.ts", "src/decorated.ts", "src/shared.ts"]);
	expect([ends.endLine("src/default.ts", 1), ends.endLine("src/default.ts", 2)]).toEqual([6, 6]);
	expect([ends.endLine("src/decorated.ts", 1), ends.endLine("src/decorated.ts", 2)]).toEqual([6, 6]);
	// The class and its first method both open on line 1, so which one Enola means there is unclear.
	expect(ends.endLine("src/shared.ts", 1)).toBeUndefined();
	expect(ends.endLine("src/shared.ts", 2)).toBe(2);
});

it("gives no span for a file past the read limit, whose symbol may run past the cut", { timeout: 60_000 }, async () => {
	const filler = "\tconst x = 1;\n".repeat(Math.ceil(enclosingLimits.fileBytes / 14) + 10);
	const head = commit(repo, { "src/big.ts": `export function big() {\n${filler}}\n` });
	const ends = await SymbolEnds.read(repo, head, ["src/big.ts"]);
	expect(ends.endLine("src/big.ts", 1)).toBeUndefined();
});

// Each file costs two git reads, about 400 processes here; past Vitest's 5 seconds the read would still be running, and
// would close its compiler inside the next test.
it("reads the first files up to the limit, and none past it", { timeout: 60_000 }, async () => {
	const count = enclosingLimits.files + 1;
	const files = Object.fromEntries(
		Array.from({ length: count }, (_, index) => [`src/f${index}.ts`, "export function f() {\n\treturn 1;\n}\n"]),
	);
	const head = commit(repo, files);
	const ends = await SymbolEnds.read(repo, head, Object.keys(files));
	expect(ends.endLine(`src/f${count - 2}.ts`, 1)).toBe(3);
	expect(ends.endLine(`src/f${count - 1}.ts`, 1)).toBeUndefined();
});

it("closes the compiler, and gives no span for a file it holds no tree of", async () => {
	const head = commit(repo, { "src/a.ts": "export function f() {\n\treturn 1;\n}\n" });
	vi.spyOn(HeadProgram.prototype, "source").mockReturnValue(undefined);
	const close = vi.spyOn(HeadProgram.prototype, "close");
	const ends = await SymbolEnds.read(repo, head, ["src/a.ts"]);
	expect(ends.endLine("src/a.ts", 1)).toBeUndefined();
	expect(close).toHaveBeenCalledTimes(1);
});

it("gives no span, and does not throw, when the compiler will not start", async () => {
	const head = commit(repo, { "src/a.ts": "export function f() {\n\treturn 1;\n}\n" });
	vi.spyOn(HeadProgram, "open").mockImplementation(() => {
		throw new Error("the compiler would not start");
	});
	const ends = await SymbolEnds.read(repo, head, ["src/a.ts"]);
	expect(ends.endLine("src/a.ts", 1)).toBeUndefined();
});
