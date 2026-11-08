import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { LineMap } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

let repo: string;

const ten = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);

function commit(files: Record<string, string | Buffer>, message: string): string {
	writeFiles(repo, files);
	gitIn(repo, "add", "-A");
	gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", message);
	return gitIn(repo, "rev-parse", "HEAD").trim();
}

async function mapOf(from: string, to: string, path = "a.ts", attributesFrom = from): Promise<LineMap> {
	return LineMap.between(repo, { from, to, path, attributesFrom });
}

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

describe("LineMap", () => {
	it("maps an untouched span past an insertion above it", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "a.ts": lines("new 0", "new 0b", ...ten) }, "insert above");
		const map = await mapOf(before, after);
		expect(map.mapped).toBe(true);
		expect(map.map({ startLine: 5, endLine: 6 })).toEqual({ startLine: 7, endLine: 8 });
		expect(map.untouched({ startLine: 5, endLine: 6 }, { startLine: 7, endLine: 8 })).toBe(true);
	});

	it("maps a span past a deletion above it and keeps one below a change in place", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "a.ts": lines(...ten.slice(2, 8), "changed 9", "line 10") }, "delete above, change below");
		const map = await mapOf(before, after);
		expect(map.map({ startLine: 4, endLine: 6 })).toEqual({ startLine: 2, endLine: 4 });
	});

	it("maps a span unchanged when the commits hold the same file", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "b.ts": "other\n" }, "elsewhere");
		const map = await mapOf(before, after);
		expect(map.map({ startLine: 3, endLine: 3 })).toEqual({ startLine: 3, endLine: 3 });
		expect(map.untouched({ startLine: 3, endLine: 3 }, { startLine: 3, endLine: 3 })).toBe(true);
	});

	it("reads an insertion inside the old span as touching it", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "a.ts": lines(...ten.slice(0, 5), "inserted", ...ten.slice(5)) }, "insert inside");
		const map = await mapOf(before, after);
		expect(map.map({ startLine: 5, endLine: 6 })).toBeUndefined();
		expect(map.untouched({ startLine: 5, endLine: 6 }, { startLine: 1, endLine: 1 })).toBe(false);
	});

	it("reads an insertion just before or just after the old span as touching it", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "a.ts": lines(...ten.slice(0, 4), "inserted", ...ten.slice(4)) }, "insert after line 4");
		const map = await mapOf(before, after);
		// The gap after line 4 sits before a span starting at 5 and after one ending at 4.
		expect(map.map({ startLine: 5, endLine: 6 })).toBeUndefined();
		expect(map.map({ startLine: 3, endLine: 4 })).toBeUndefined();
		// One line further on either side is clear of it.
		expect(map.map({ startLine: 6, endLine: 7 })).toEqual({ startLine: 7, endLine: 8 });
		expect(map.map({ startLine: 2, endLine: 3 })).toEqual({ startLine: 2, endLine: 3 });
	});

	it("reads a changed line next to the old span as touching it, and one a line further as not", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "a.ts": lines(...ten.slice(0, 6), "changed 7", ...ten.slice(7)) }, "change line 7");
		const map = await mapOf(before, after);
		expect(map.map({ startLine: 5, endLine: 6 })).toBeUndefined();
		expect(map.map({ startLine: 8, endLine: 9 })).toBeUndefined();
		expect(map.map({ startLine: 4, endLine: 5 })).toEqual({ startLine: 4, endLine: 5 });
		expect(map.map({ startLine: 9, endLine: 10 })).toEqual({ startLine: 9, endLine: 10 });
	});

	it("reads a deletion inside or beside the new span as touching it", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "a.ts": lines(...ten.slice(0, 4), ...ten.slice(5)) }, "delete line 5");
		const map = await mapOf(before, after);
		// The deletion sits after new line 4, between new lines 4 and 5.
		expect(map.untouched({ startLine: 9, endLine: 9 }, { startLine: 5, endLine: 6 })).toBe(false);
		expect(map.untouched({ startLine: 9, endLine: 9 }, { startLine: 3, endLine: 4 })).toBe(false);
		expect(map.untouched({ startLine: 9, endLine: 9 }, { startLine: 6, endLine: 7 })).toBe(true);
		expect(map.untouched({ startLine: 9, endLine: 9 }, { startLine: 2, endLine: 3 })).toBe(true);
	});

	it("reads an added line inside or beside the new span as touching it", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "a.ts": lines(...ten.slice(0, 4), "inserted", ...ten.slice(4)) }, "insert at 5");
		const map = await mapOf(before, after);
		expect(map.untouched({ startLine: 9, endLine: 9 }, { startLine: 5, endLine: 5 })).toBe(false);
		expect(map.untouched({ startLine: 9, endLine: 9 }, { startLine: 6, endLine: 7 })).toBe(false);
		expect(map.untouched({ startLine: 9, endLine: 9 }, { startLine: 2, endLine: 4 })).toBe(false);
		expect(map.untouched({ startLine: 9, endLine: 9 }, { startLine: 7, endLine: 8 })).toBe(true);
		expect(map.untouched({ startLine: 9, endLine: 9 }, { startLine: 1, endLine: 3 })).toBe(true);
	});

	it("leaves a binary file unmapped", async () => {
		const before = commit({ "a.ts": Buffer.from([0x61, 0x00, 0x0a, 0x62, 0x0a]) }, "base");
		const after = commit({ "a.ts": Buffer.from([0x7a, 0x0a, 0x61, 0x00, 0x0a, 0x62, 0x0a]) }, "binary change");
		const map = await mapOf(before, after);
		expect(map.mapped).toBe(false);
		expect(map.map({ startLine: 3, endLine: 3 })).toBeUndefined();
		expect(map.untouched({ startLine: 3, endLine: 3 }, { startLine: 4, endLine: 4 })).toBe(false);
	});

	it("leaves a file the base's attributes mark -diff unmapped, even when its text is unchanged", async () => {
		const before = commit({ "a.ts": lines(...ten), ".gitattributes": "*.ts -diff\n" }, "base");
		const after = commit({ "a.ts": lines("new 0", ...ten) }, "insert above");
		const map = await mapOf(before, after);
		expect(map.mapped).toBe(false);
		expect(map.map({ startLine: 5, endLine: 5 })).toBeUndefined();
	});

	it("reads attributes from the commit it is given, never the head's", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "a.ts": lines("new 0", ...ten), ".gitattributes": "*.ts -diff\n" }, "head hides itself");
		const map = await mapOf(before, after, "a.ts", after);
		expect(map.mapped).toBe(false);
		const fromBase = await mapOf(before, after, "a.ts", before);
		expect(fromBase.map({ startLine: 5, endLine: 5 })).toEqual({ startLine: 6, endLine: 6 });
	});

	it("leaves a missing object unmapped rather than reading it as no hunks", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const map = await mapOf("0123456789abcdef0123456789abcdef01234567", before);
		expect(map.mapped).toBe(false);
		expect(map.untouched({ startLine: 1, endLine: 1 }, { startLine: 1, endLine: 1 })).toBe(false);
		expect(await mapOf(before, "0123456789abcdef0123456789abcdef01234567")).toMatchObject({ mapped: false });
	});

	it("leaves a path missing at either commit, or not a regular file, unmapped", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		const after = commit({ "b.ts": lines(...ten) }, "add b");
		expect((await mapOf(before, after, "b.ts")).mapped).toBe(false);
		expect((await mapOf(before, after, "missing.ts")).mapped).toBe(false);
		gitIn(repo, "rm", "--quiet", "a.ts");
		gitIn(repo, "commit", "--quiet", "-m", "remove a");
		const removed = gitIn(repo, "rev-parse", "HEAD").trim();
		expect((await mapOf(before, removed)).mapped).toBe(false);
	});

	it("leaves a file moved by a rename unmapped under its new path", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		gitIn(repo, "mv", "a.ts", "c.ts");
		gitIn(repo, "commit", "--quiet", "-m", "rename");
		const after = gitIn(repo, "rev-parse", "HEAD").trim();
		expect((await mapOf(before, after, "c.ts")).mapped).toBe(false);
	});

	it("refuses a ref that would read as an option", async () => {
		const before = commit({ "a.ts": lines(...ten) }, "base");
		expect((await mapOf(before, before, "a.ts", "--output=x")).mapped).toBe(false);
		expect((await mapOf("--help", before)).mapped).toBe(false);
	});

	it("leaves a symlink, a directory and a submodule unmapped, though git diffs each as text", async () => {
		const before = commit({ "dir/only.ts": lines(...ten), target: "x\n" }, "base");
		symlinkSync("target", join(repo, "link"));
		gitIn(repo, "add", "-A");
		gitIn(repo, "commit", "--quiet", "-m", "link");
		const linked = gitIn(repo, "rev-parse", "HEAD").trim();
		writeFiles(repo, { target: "y\n" });
		rmSync(join(repo, "link"));
		symlinkSync("elsewhere", join(repo, "link"));
		const after = commit({ "dir/only.ts": lines("new 0", ...ten) }, "retarget");
		expect((await mapOf(linked, after, "link")).mapped).toBe(false);
		expect((await mapOf(before, after, "dir")).mapped).toBe(false);
		gitIn(repo, "update-index", "--add", "--cacheinfo", `160000,${before},sub`);
		gitIn(repo, "commit", "--quiet", "-m", "submodule");
		const pointed = gitIn(repo, "rev-parse", "HEAD").trim();
		gitIn(repo, "update-index", "--cacheinfo", `160000,${after},sub`);
		gitIn(repo, "commit", "--quiet", "-m", "move submodule");
		expect((await mapOf(pointed, gitIn(repo, "rev-parse", "HEAD").trim(), "sub")).mapped).toBe(false);
		// The same file, regular at both commits, maps.
		expect((await mapOf(before, after, "dir/only.ts")).map({ startLine: 2, endLine: 2 })).toEqual({
			startLine: 3,
			endLine: 3,
		});
	});

	it("reads a path with glob characters as that one file, never as a pattern", async () => {
		const before = commit({ "s*.ts": lines(...ten), "sa.ts": lines(...ten), "a.ts": lines(...ten) }, "base");
		const after = commit(
			{ "s*.ts": lines("new 0", ...ten), "sa.ts": lines("other 0", "other 0b", ...ten) },
			"change both",
		);
		expect((await mapOf(before, after, "s*.ts")).map({ startLine: 5, endLine: 5 })).toEqual({
			startLine: 6,
			endLine: 6,
		});
		expect((await mapOf(before, after, "*.ts")).mapped).toBe(false);
	});
});
