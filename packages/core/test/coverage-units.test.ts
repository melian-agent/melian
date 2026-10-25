import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	Changeset,
	countRanges,
	HeadMove,
	type Revision,
	rangesOf,
	subtractRanges,
	unionRanges,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

function commit(message: string): string {
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", message);
	return gitIn(repo, "rev-parse", "HEAD");
}

async function between(base: string, head: string): Promise<Revision> {
	return (await Changeset.resolve(repo, { base, head, mode: "twoDot" })).revision;
}

const numbered = (count: number, label = "line") =>
	lines(...Array.from({ length: count }, (_, index) => `${label} ${index + 1}`));

describe("line ranges", () => {
	it("gathers lines into sorted ranges, each line once", () => {
		expect(rangesOf([5, 1, 2, 3, 3, 9, 0, -1, 1.5])).toEqual([
			[1, 3],
			[5, 5],
			[9, 9],
		]);
		expect(rangesOf([])).toEqual([]);
	});

	it("joins ranges that overlap or touch, and keeps the rest apart", () => {
		expect(unionRanges([[1, 3]], [[4, 6]])).toEqual([[1, 6]]);
		expect(unionRanges([[1, 3]], [[5, 6]])).toEqual([
			[1, 3],
			[5, 6],
		]);
		expect(
			unionRanges(
				[
					[10, 12],
					[1, 2],
				],
				[[2, 11]],
			),
		).toEqual([[1, 12]]);
	});

	it("takes away what a second set holds, splitting a range around it", () => {
		expect(subtractRanges([[1, 10]], [[4, 6]])).toEqual([
			[1, 3],
			[7, 10],
		]);
		expect(subtractRanges([[1, 10]], [[1, 10]])).toEqual([]);
		expect(subtractRanges([[1, 10]], [[11, 12]])).toEqual([[1, 10]]);
		expect(subtractRanges([[5, 10]], [[1, 5]])).toEqual([[6, 10]]);
		expect(
			subtractRanges(
				[[1, 10]],
				[
					[2, 2],
					[9, 10],
				],
			),
		).toEqual([
			[1, 1],
			[3, 8],
		]);
	});

	it("counts the lines of a set", () => {
		expect(
			countRanges([
				[1, 3],
				[7, 7],
			]),
		).toBe(4);
		expect(countRanges([])).toBe(0);
	});
});

describe("Revision.changedLines", () => {
	it("keys added lines by head path and removed lines by base path, a rename's under its old path", async () => {
		writeFiles(repo, { "a.ts": numbered(6), "old.ts": numbered(8, "old"), "gone.ts": numbered(2, "gone") });
		const base = commit("base");
		writeFiles(repo, { "a.ts": lines("line 1", "LINE 2", "line 3", "line 4", "line 5", "line 6", "line 7") });
		gitIn(repo, "mv", "old.ts", "new.ts");
		writeFiles(repo, {
			"new.ts": lines("old 1", "old 2", "old 3", "old 4", "old 5", "old 6", "old 7", "OLD 8"),
			"added.ts": numbered(2, "new"),
		});
		rmSync(join(repo, "gone.ts"));
		const head = commit("head");
		const { head: added, base: removed } = (await between(base, head)).changedLines();
		expect(added).toEqual({
			"a.ts": [
				[2, 2],
				[7, 7],
			],
			"added.ts": [[1, 2]],
			"new.ts": [[8, 8]],
		});
		expect(removed).toEqual({ "a.ts": [[2, 2]], "gone.ts": [[1, 2]], "old.ts": [[8, 8]] });
	});

	it("gives a binary file no lines", async () => {
		writeFiles(repo, { "logo.png": Buffer.from([0x89, 0x50, 0x00, 0x01]) });
		const base = commit("base");
		writeFiles(repo, { "logo.png": Buffer.from([0x89, 0x50, 0x00, 0x02]) });
		const head = commit("head");
		expect((await between(base, head)).changedLines()).toEqual({ head: {}, base: {} });
	});
});

describe("Revision.fileUnits", () => {
	it("makes a unit of every change no line describes, with every field a lens must receive", async () => {
		writeFiles(repo, {
			"release.sh": lines("echo release"),
			"logo.png": Buffer.from([0x89, 0x50, 0x00, 0x01]),
			"moved.ts": numbered(3),
			"target.txt": lines("target"),
			run: lines("echo run"),
			"edited.sh": lines("echo one"),
		});
		const base = commit("base");
		chmodSync(join(repo, "release.sh"), 0o755);
		writeFiles(repo, { "logo.png": Buffer.from([0x89, 0x50, 0x00, 0x02]), "empty.json": "" });
		gitIn(repo, "mv", "moved.ts", "renamed.ts");
		rmSync(join(repo, "run"));
		symlinkSync("target.txt", join(repo, "run"));
		writeFiles(repo, { "edited.sh": lines("echo two") });
		chmodSync(join(repo, "edited.sh"), 0o755);
		const head = commit("head");
		const units = (await between(base, head)).fileUnits();
		expect(units).toEqual([
			{
				path: "edited.sh",
				kind: "mode",
				fields: ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary"],
			},
			{ path: "empty.json", kind: "empty", fields: ["status", "path", "newMode", "newKind", "binary", "empty"] },
			{
				path: "logo.png",
				kind: "binary",
				fields: ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary"],
			},
			{
				path: "release.sh",
				kind: "mode",
				fields: ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary"],
			},
			{
				path: "renamed.ts",
				oldPath: "moved.ts",
				kind: "rename",
				fields: ["status", "path", "oldPath", "oldMode", "newMode", "oldKind", "newKind", "binary"],
			},
			{
				path: "run",
				kind: "symlink",
				fields: ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary", "target"],
			},
		]);
	});

	it("makes a unit of an empty file deleted", async () => {
		writeFiles(repo, { "empty.json": "", "kept.ts": numbered(1) });
		const base = commit("base");
		rmSync(join(repo, "empty.json"));
		const head = commit("head");
		expect((await between(base, head)).fileUnits()).toEqual([
			{ path: "empty.json", kind: "empty", fields: ["status", "path", "oldMode", "oldKind", "binary", "empty"] },
		]);
	});

	it("leaves a file whose hunks describe it, with its mode unchanged, to its lines", async () => {
		writeFiles(repo, { "a.ts": numbered(2) });
		const base = commit("base");
		writeFiles(repo, { "a.ts": numbered(3), "b.ts": numbered(1) });
		const head = commit("head");
		expect((await between(base, head)).fileUnits()).toEqual([]);
	});

	it("names a renamed file whose mode changed a mode unit, not a rename", async () => {
		writeFiles(repo, { "tool.sh": lines("echo tool") });
		const base = commit("base");
		gitIn(repo, "mv", "tool.sh", "bin.sh");
		chmodSync(join(repo, "bin.sh"), 0o755);
		const head = commit("head");
		expect((await between(base, head)).fileUnits()).toMatchObject([{ path: "bin.sh", kind: "mode" }]);
	});

	it("names a submodule pointer a submodule unit", async () => {
		const pointed = commit("empty");
		gitIn(repo, "update-index", "--add", "--cacheinfo", `160000,${pointed},vendor/lib`);
		gitIn(repo, "commit", "--quiet", "-m", "point");
		const base = gitIn(repo, "rev-parse", "HEAD");
		gitIn(repo, "update-index", "--cacheinfo", `160000,${base},vendor/lib`);
		gitIn(repo, "commit", "--quiet", "-m", "move");
		const head = gitIn(repo, "rev-parse", "HEAD");
		const revision = await between(base, head);
		expect(revision.files[0]?.hunks.length).toBeGreaterThan(0);
		expect(revision.fileUnits()).toMatchObject([{ path: "vendor/lib", kind: "submodule" }]);
		expect(revision.changedLines()).toEqual({ head: {}, base: {} });
	});
});

describe("Revision.mapLine between two heads", () => {
	it("moves a line by the hunks before it and gives up a line a hunk changed", async () => {
		writeFiles(repo, { "a.ts": numbered(10) });
		const first = commit("first");
		writeFiles(repo, {
			"a.ts": lines(
				"inserted 0",
				"line 1",
				"line 2",
				"LINE 3",
				"line 4",
				"line 5",
				"line 7",
				"line 8",
				"inserted 8a",
				"inserted 8b",
				"line 9",
				"line 10",
			),
		});
		const second = commit("second");
		const map = await between(first, second);
		expect(map.mapLine("a.ts", 1)).toEqual({ path: "a.ts", line: 2 });
		expect(map.mapLine("a.ts", 3)).toBeUndefined();
		expect(map.mapLine("a.ts", 5)).toEqual({ path: "a.ts", line: 6 });
		expect(map.mapLine("a.ts", 6)).toBeUndefined();
		expect(map.mapLine("a.ts", 7)).toEqual({ path: "a.ts", line: 7 });
		expect(map.mapLine("a.ts", 8)).toEqual({ path: "a.ts", line: 8 });
		expect(map.mapLine("a.ts", 9)).toEqual({ path: "a.ts", line: 11 });
		expect(map.mapLine("a.ts", 10)).toEqual({ path: "a.ts", line: 12 });
		expect(map.mapLine("other.ts", 4)).toEqual({ path: "other.ts", line: 4 });
	});

	it("follows a rename and gives up a deleted file's lines", async () => {
		writeFiles(repo, { "old.ts": numbered(6), "gone.ts": numbered(3) });
		const first = commit("first");
		gitIn(repo, "mv", "old.ts", "new.ts");
		writeFiles(repo, { "new.ts": lines("top", "line 1", "line 2", "line 3", "line 4", "line 5", "line 6") });
		rmSync(join(repo, "gone.ts"));
		const second = commit("second");
		const map = await between(first, second);
		expect(map.mapLine("old.ts", 4)).toEqual({ path: "new.ts", line: 5 });
		expect(map.mapLine("gone.ts", 1)).toBeUndefined();
		expect(map.lists("old.ts")).toBe(true);
		expect(map.lists("new.ts")).toBe(true);
		expect(map.lists("gone.ts")).toBe(true);
		expect(map.lists("kept.ts")).toBe(false);
	});

	it("moves a line past a moved block as git reports the block's two hunks", async () => {
		writeFiles(repo, { "a.ts": lines("a", "b", "c", "d", "e", "f") });
		const first = commit("first");
		writeFiles(repo, { "a.ts": lines("c", "d", "a", "b", "e", "f") });
		const second = commit("second");
		const map = await between(first, second);
		const moved = ["a", "b", "c", "d", "e", "f"].map((_, index) => map.mapLine("a.ts", index + 1)?.line);
		expect(moved.slice(4)).toEqual([5, 6]);
		expect(moved.filter((line) => line !== undefined).length).toBeLessThan(6);
	});

	it("gives up every line of a deleted empty file, which has no hunk", async () => {
		writeFiles(repo, { "empty.json": "", "a.ts": numbered(2) });
		const first = commit("first");
		rmSync(join(repo, "empty.json"));
		const second = commit("second");
		expect((await between(first, second)).mapLine("empty.json", 1)).toBeUndefined();
	});

	it("gives up the lines of a changed binary file", async () => {
		writeFiles(repo, { "logo.png": Buffer.from([0x89, 0x50, 0x00, 0x01]) });
		const first = commit("first");
		writeFiles(repo, { "logo.png": Buffer.from([0x89, 0x50, 0x00, 0x02]) });
		const second = commit("second");
		expect((await between(first, second)).mapLine("logo.png", 1)).toBeUndefined();
	});
});

describe("HeadMove.read", () => {
	it("reads a head that moved along its history, a rewritten one, a merged one, and one git cannot resolve", async () => {
		writeFiles(repo, { "a.ts": numbered(2) });
		const first = commit("first");
		writeFiles(repo, { "a.ts": numbered(3) });
		const second = commit("second");
		const moved = await HeadMove.read(repo, first, second);
		expect(moved.kind).toBe("moved");
		expect(moved.revision?.files.map((file) => file.path)).toEqual(["a.ts"]);
		gitIn(repo, "checkout", "--quiet", "-b", "side", first);
		const side = commit("side");
		expect((await HeadMove.read(repo, side, second)).kind).toBe("rewritten");
		gitIn(repo, "checkout", "--quiet", "main");
		gitIn(repo, "merge", "--quiet", "--no-ff", "--no-edit", "side");
		const merged = gitIn(repo, "rev-parse", "HEAD");
		expect((await HeadMove.read(repo, second, merged)).kind).toBe("merged");
		expect((await HeadMove.read(repo, "f".repeat(40), second)).kind).toBe("unresolved");
		expect((await HeadMove.read(join(repo, "gone"), first, second)).kind).toBe("unresolved");
	});

	it("says why coverage did not carry for each move off the history", async () => {
		writeFiles(repo, { "a.ts": numbered(2) });
		const first = commit("first");
		expect((await HeadMove.read(repo, "f".repeat(40), first)).reason("r1")).toBe("r1's head cannot be resolved");
		writeFiles(repo, { "a.ts": numbered(3) });
		const second = commit("second");
		const moved = await HeadMove.read(repo, first, second);
		expect(moved.reason("r1")).toBe("the head moved along its history since r1");
		expect((await HeadMove.read(repo, "f".repeat(40), first)).revision).toBeUndefined();
	});
});

describe("line ranges at their edges", () => {
	it("keeps a range a second set only touches at either side, and splits one it lies inside", () => {
		expect(subtractRanges([[5, 9]], [[1, 4]])).toEqual([[5, 9]]);
		expect(subtractRanges([[5, 9]], [[10, 12]])).toEqual([[5, 9]]);
		expect(subtractRanges([[5, 9]], [[9, 12]])).toEqual([[5, 8]]);
		expect(subtractRanges([[5, 9]], [[5, 5]])).toEqual([[6, 9]]);
		expect(subtractRanges([[5, 5]], [[5, 5]])).toEqual([]);
		expect(subtractRanges([[5, 6]], [[6, 6]])).toEqual([[5, 5]]);
		expect(subtractRanges([[5, 9]], [[12, 14]])).toEqual([[5, 9]]);
		expect(subtractRanges([[5, 9]], [[5, 8]])).toEqual([[9, 9]]);
	});
});

describe("Revision.fileUnits and mapLine at their edges", () => {
	it("makes a unit of a submodule or a symlink on one side alone", async () => {
		writeFiles(repo, { link: lines("plain") });
		const base = commit("base");
		rmSync(join(repo, "link"));
		symlinkSync("elsewhere", join(repo, "link"));
		const pointed = commit("link");
		gitIn(repo, "rm", "--quiet", "link");
		gitIn(repo, "update-index", "--add", "--cacheinfo", `160000,${base},link`);
		gitIn(repo, "commit", "--quiet", "-m", "submodule");
		const sub = gitIn(repo, "rev-parse", "HEAD");
		expect((await between(base, pointed)).fileUnits()).toMatchObject([{ path: "link", kind: "symlink" }]);
		expect((await between(pointed, sub)).fileUnits()).toMatchObject([{ path: "link", kind: "submodule" }]);
		expect((await between(sub, pointed)).fileUnits()).toMatchObject([{ path: "link", kind: "submodule" }]);
		writeFiles(repo, {});
		gitIn(repo, "checkout", "--quiet", pointed);
		rmSync(join(repo, "link"));
		writeFiles(repo, { link: lines("plain again") });
		const plain = commit("back to a file");
		const back = (await between(pointed, plain)).fileUnits();
		expect(back).toMatchObject([{ path: "link", kind: "symlink" }]);
		expect(back[0]).not.toHaveProperty("oldPath");
	});

	it("maps a line past a hunk's last old line, and gives up one a file added at the map's base cannot hold", async () => {
		writeFiles(repo, { "a.ts": numbered(5) });
		const first = commit("first");
		writeFiles(repo, {
			"a.ts": lines("line 1", "LINE 2", "two b", "line 3", "line 4", "line 5"),
			"b.ts": numbered(2),
		});
		const second = commit("second");
		const map = await between(first, second);
		expect(map.mapLine("a.ts", 2)).toBeUndefined();
		expect(map.mapLine("a.ts", 3)).toEqual({ path: "a.ts", line: 4 });
		expect(map.mapLine("b.ts", 1)).toEqual({ path: "b.ts", line: 1 });
	});
});
