import { type ChangedFile, type Hunk, Revision, snippetHash } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const hunk = (
	file: string,
	index: number,
	[oldStart, oldLines]: [number, number],
	[newStart, newLines]: [number, number],
	text = "",
): Hunk => ({ file, index, oldStart, oldLines, newStart, newLines, header: "", text });

const changed = (path: string, hunks: Hunk[], extra: Partial<ChangedFile> = {}): ChangedFile => ({
	status: "modified",
	path,
	binary: false,
	hunks,
	...extra,
});

const move = (...files: ChangedFile[]) => Revision.from({ base: "a".repeat(40), head: "b".repeat(40), files });

describe("Revision.moveLines", () => {
	// a.ts: two lines inserted after line 2, line 6 replaced by two lines, line 10 deleted.
	const a = changed("a.ts", [
		hunk("a.ts", 0, [2, 0], [3, 2]),
		hunk("a.ts", 1, [6, 1], [8, 2]),
		hunk("a.ts", 2, [10, 1], [11, 0]),
	]);

	it("leaves lines in a file the move does not list, or one it added, where they were", () => {
		const added = changed("new.ts", [hunk("new.ts", 0, [0, 0], [1, 3])], { status: "added" });
		expect(move(a, added).moveLines("other.ts", 4, 5)).toEqual({
			path: "other.ts",
			first: 4,
			last: 5,
			changed: false,
		});
		expect(move(a, added).moveLines("new.ts", 1, 2)).toEqual({ path: "new.ts", first: 1, last: 2, changed: false });
	});

	it("gives up lines in a file the move deleted or made binary", () => {
		expect(move(changed("a.ts", [], { status: "deleted" })).moveLines("a.ts", 1, 1)).toBeUndefined();
		expect(move(changed("a.ts", [], { binary: true })).moveLines("a.ts", 1, 1)).toBeUndefined();
	});

	it("moves lines no hunk touched by the hunks before them, under a renamed file's new path", () => {
		expect(move(a).moveLines("a.ts", 3, 5)).toEqual({ path: "a.ts", first: 5, last: 7, changed: false });
		expect(move(a).moveLines("a.ts", 1, 2)).toEqual({ path: "a.ts", first: 1, last: 2, changed: false });
		expect(move(a).moveLines("a.ts", 7, 9)).toEqual({ path: "a.ts", first: 10, last: 12, changed: false });
		const renamed = changed("b.ts", [hunk("b.ts", 0, [1, 1], [1, 1])], { status: "renamed", oldPath: "a.ts" });
		expect(move(renamed).moveLines("a.ts", 3, 4)).toEqual({ path: "b.ts", first: 3, last: 4, changed: false });
	});

	it("puts lines a hunk changed at the first new line after it, and marks them changed", () => {
		expect(move(a).moveLines("a.ts", 6, 6)).toEqual({ path: "a.ts", first: 10, last: 10, changed: true });
		expect(move(a).moveLines("a.ts", 5, 6)).toEqual({ path: "a.ts", first: 10, last: 10, changed: true });
		expect(move(a).moveLines("a.ts", 6, 7)).toEqual({ path: "a.ts", first: 10, last: 10, changed: true });
		expect(move(a).moveLines("a.ts", 10, 10)).toEqual({ path: "a.ts", first: 12, last: 12, changed: true });
	});

	it("counts an insertion inside a range as a change, and one after its last line as none", () => {
		expect(move(a).moveLines("a.ts", 2, 3)).toEqual({ path: "a.ts", first: 5, last: 5, changed: true });
		expect(move(a).moveLines("a.ts", 1, 2)).toEqual({ path: "a.ts", first: 1, last: 2, changed: false });
		const appended = changed("c.ts", [hunk("c.ts", 0, [4, 0], [5, 1])]);
		expect(move(appended).moveLines("c.ts", 4, 4)).toEqual({ path: "c.ts", first: 4, last: 4, changed: false });
	});
});

describe("Revision.triggerOf", () => {
	const text = (...rows: string[]) => rows.join("\n");
	const a = changed("a.ts", [
		hunk("a.ts", 0, [3, 1], [3, 2], text("-old 3", "+new 3", "+new 4")),
		hunk("a.ts", 1, [9, 1], [10, 0], text("-gone 9")),
	]);
	const b = changed("b.ts", [
		hunk("b.ts", 0, [1, 1], [1, 1], text("-b 1", "+B 1")),
		hunk("b.ts", 1, [7, 0], [8, 1], text("+B 8")),
	]);
	const revision = move(a, b);

	it("names the hunk an introduced finding sits in, with its added lines hashed whole", () => {
		const expected = { file: "a.ts", index: 0, snippet: "new 3\nnew 4", hash: snippetHash("new 3\nnew 4") };
		expect(revision.triggerOf({ file: "a.ts", startLine: 4 }, [], "introduced")).toEqual(expected);
		expect(revision.triggerOf({ file: "a.ts", startLine: 1, endLine: 3 }, [], "introduced")).toEqual(expected);
		expect(revision.triggerOf({ file: "a.ts", startLine: 2 }, [], "introduced")).toBeUndefined();
		expect(revision.triggerOf({ file: "a.ts", startLine: 5 }, [], "introduced")).toBeUndefined();
		expect(revision.triggerOf({ file: "a.ts", startLine: 10 }, [], "introduced")).toBeUndefined();
		expect(revision.triggerOf({ file: "b.ts", startLine: 8 }, [], "introduced")).toMatchObject({
			file: "b.ts",
			index: 1,
		});
		expect(revision.triggerOf({ file: "c.ts", startLine: 3 }, [], "introduced")).toBeUndefined();
	});

	it("names every proving hunk once, by file then index, for an affected finding, the first as its trigger", () => {
		const cause = (file: string, startLine: number, proves = true) => ({
			file,
			startLine,
			role: "cause" as const,
			revision: "head" as const,
			...(proves ? { proves: true as const } : {}),
		});
		const evidence = [
			cause("b.ts", 8),
			cause("a.ts", 4),
			cause("b.ts", 1),
			cause("a.ts", 3),
			cause("b.ts", 1, false),
		];
		expect(revision.triggerOf({ file: "c.ts", startLine: 5 }, evidence, "affected")).toEqual({
			file: "a.ts",
			index: 0,
			snippet: "new 3\nnew 4",
			proof: [
				{ file: "a.ts", hash: snippetHash(text("-old 3", "+new 3", "+new 4")) },
				{ file: "b.ts", hash: snippetHash(text("-b 1", "+B 1")) },
				{ file: "b.ts", hash: snippetHash("+B 8") },
			],
		});
		expect(revision.triggerOf({ file: "c.ts", startLine: 5 }, [cause("b.ts", 8, false)], "affected")).toBeUndefined();
		expect(revision.triggerOf({ file: "c.ts", startLine: 5 }, [cause("a.ts", 20)], "affected")).toBeUndefined();
		expect(revision.triggerOf({ file: "a.ts", startLine: 4 }, evidence, "pre-existing")).toBeUndefined();
	});
});
