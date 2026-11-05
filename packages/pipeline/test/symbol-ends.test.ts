import { afterEach, beforeEach, expect, it } from "vitest";
import { SymbolEnds } from "../src/enclosing-functions.ts";
import { commit, createRepository, removeRepository } from "./fixtures/repo.ts";

let repo: string;
beforeEach(() => {
	repo = createRepository();
});
afterEach(() => {
	removeRepository(repo);
});

it("ends a symbol where the compiler ends its outermost node, and knows nothing of a file it did not parse", async () => {
	const head = commit(repo, {
		"src/a.ts": "/** Doc. */\nexport function alpha() {\n\treturn [\n\t\t1,\n\t];\n}\nexport const beta = 1;\n",
		"docs/a.md": "# Alpha\n\ntext\n",
	});
	const ends = await SymbolEnds.read(repo, head, ["src/a.ts", "docs/a.md", "src/missing.ts"]);
	expect(ends.endLine("src/a.ts", 2)).toBe(6);
	expect(ends.endLine("src/a.ts", 7)).toBe(7);
	expect(ends.endLine("src/a.ts", 4)).toBe(4);
	expect(ends.endLine("docs/a.md", 1)).toBeUndefined();
	expect(ends.endLine("src/missing.ts", 1)).toBeUndefined();
});
