import { mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ChangesetError, parseRangeSpec, resolveRange } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	gitIn,
	isolatedGitEnv,
	lines,
	rejection as rejectionOf,
	removeDirectory,
	temporaryDirectory,
	writeFiles,
} from "./fixtures/repo.ts";

// main:    base ── main-only
//             \
// feature:     feature
let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, {
		"poem.txt": lines("one", "two", "three", "four", "five", "six"),
		"old-name.txt": lines("alpha", "beta", "gamma", "delta", "epsilon"),
		"gone.txt": lines("soon deleted"),
	});
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "--quiet", "-m", "base");

	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	writeFiles(repo, {
		"poem.txt": lines("one", "TWO", "three", "four", "four and a half", "five"),
		"added.txt": lines("first", "second"),
		"logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
	});
	gitIn(repo, "mv", "old-name.txt", "new-name.txt");
	writeFiles(repo, { "new-name.txt": lines("alpha", "beta", "gamma", "delta", "EPSILON") });
	gitIn(repo, "rm", "--quiet", "gone.txt");
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "--quiet", "-m", "feature");

	gitIn(repo, "checkout", "--quiet", "main");
	writeFiles(repo, { "main-only.txt": lines("landed on main after feature branched") });
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "--quiet", "-m", "main moves on");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

const rejection = (promise: Promise<unknown>) => rejectionOf(promise, ChangesetError);

// Records a submodule pointer through the index, so no second repository is cloned.
function commitGitlink(root: string, path: string, commit: string): void {
	gitIn(root, "update-index", "--add", "--cacheinfo", `160000,${commit},${path}`);
	gitIn(root, "commit", "--quiet", "-m", `point ${path} at ${commit}`);
}

describe("parseRangeSpec", () => {
	it("keeps git's two-dot and three-dot meanings", () => {
		expect(parseRangeSpec("origin/main..HEAD")).toEqual({ base: "origin/main", head: "HEAD", mode: "twoDot" });
		expect(parseRangeSpec("main...feature")).toEqual({ base: "main", head: "feature", mode: "threeDot" });
	});

	it("reads an empty side as HEAD", () => {
		expect(parseRangeSpec("main..")).toEqual({ base: "main", head: "HEAD", mode: "twoDot" });
		expect(parseRangeSpec("...feature")).toEqual({ base: "HEAD", head: "feature", mode: "threeDot" });
	});

	it("reads a single ref as a three-dot range against HEAD", () => {
		expect(parseRangeSpec("main")).toEqual({ base: "main", head: "HEAD", mode: "threeDot" });
	});

	it.each(["", "..", "a..b..c", "--output=x", "main...-p", "main feature"])("rejects %j", (spec) => {
		expect(() => parseRangeSpec(spec)).toThrow(ChangesetError);
	});
});

describe("resolveRange", () => {
	it("lists every changed file with its status, and hunks with exact ranges", async () => {
		const changeset = await resolveRange(repo, "main...feature");
		const files = Object.fromEntries(changeset.revision.files.map((file) => [file.path, file]));

		expect(Object.keys(files).sort()).toEqual(["added.txt", "gone.txt", "logo.png", "new-name.txt", "poem.txt"]);
		expect(files["poem.txt"]).toEqual({
			status: "modified",
			path: "poem.txt",
			oldMode: "100644",
			newMode: "100644",
			oldKind: "file",
			newKind: "file",
			binary: false,
			hunks: [
				{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, header: "@@ -2 +2 @@ one", text: "-two\n+TWO" },
				{
					oldStart: 4,
					oldLines: 0,
					newStart: 5,
					newLines: 1,
					header: "@@ -4,0 +5 @@ four",
					text: "+four and a half",
				},
				{ oldStart: 6, oldLines: 1, newStart: 6, newLines: 0, header: "@@ -6 +6,0 @@ five", text: "-six" },
			],
		});
		expect(files["new-name.txt"]).toMatchObject({
			status: "renamed",
			oldPath: "old-name.txt",
			hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, text: "-epsilon\n+EPSILON" }],
		});
		expect(files["added.txt"]).toMatchObject({
			status: "added",
			hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, text: "+first\n+second" }],
		});
		expect(files["gone.txt"]).toMatchObject({
			status: "deleted",
			hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, text: "-soon deleted" }],
		});
		expect(files["gone.txt"]).not.toHaveProperty("newMode");
		expect(files["logo.png"]).toEqual({
			status: "added",
			path: "logo.png",
			newMode: "100644",
			newKind: "file",
			binary: true,
			hunks: [],
		});
	});

	it("reports a mode change with no content change", async () => {
		gitIn(repo, "checkout", "--quiet", "feature");
		gitIn(repo, "update-index", "--chmod=+x", "poem.txt");
		gitIn(repo, "commit", "--quiet", "-m", "executable");
		const changeset = await resolveRange(repo, "feature~1..feature");
		expect(changeset.revision.files).toEqual([
			{
				status: "modified",
				path: "poem.txt",
				oldMode: "100644",
				newMode: "100755",
				oldKind: "file",
				newKind: "executable",
				binary: false,
				hunks: [],
			},
		]);
	});

	it("reports a symlink that became a file", async () => {
		gitIn(repo, "checkout", "--quiet", "feature");
		rmSync(join(repo, "added.txt"));
		symlinkSync("poem.txt", join(repo, "added.txt"));
		gitIn(repo, "commit", "--quiet", "-am", "symlink");
		rmSync(join(repo, "added.txt"));
		writeFiles(repo, { "added.txt": lines("a file again") });
		gitIn(repo, "commit", "--quiet", "-am", "file");
		const changeset = await resolveRange(repo, "feature~1..feature");
		expect(changeset.revision.files).toEqual([
			expect.objectContaining({ path: "added.txt", oldKind: "symlink", newKind: "file", oldMode: "120000" }),
		]);
	});

	it("reports a submodule pointer as a submodule on both sides", async () => {
		commitGitlink(repo, "vendor/lib", gitIn(repo, "rev-parse", "main~1"));
		commitGitlink(repo, "vendor/lib", gitIn(repo, "rev-parse", "feature"));
		const changeset = await resolveRange(repo, "main~1..main");
		expect(changeset.revision.files).toEqual([
			expect.objectContaining({
				status: "modified",
				path: "vendor/lib",
				oldMode: "160000",
				newMode: "160000",
				oldKind: "submodule",
				newKind: "submodule",
			}),
		]);
	});

	it("takes the merge base for three dots and the base itself for two", async () => {
		const mergeBase = gitIn(repo, "merge-base", "main", "feature");
		const main = gitIn(repo, "rev-parse", "main");
		const feature = gitIn(repo, "rev-parse", "feature");

		const threeDot = await resolveRange(repo, "main...feature");
		const twoDot = await resolveRange(repo, "main..feature");

		expect(threeDot.revision).toMatchObject({ base: mergeBase, head: feature });
		expect(twoDot.revision).toMatchObject({ base: main, head: feature });
		expect(threeDot.revision.files.map((file) => file.path)).not.toContain("main-only.txt");
		expect(twoDot.revision.files.find((file) => file.path === "main-only.txt")?.status).toBe("deleted");
	});

	it("defaults a single ref to the three-dot view of HEAD", async () => {
		gitIn(repo, "checkout", "--quiet", "feature");
		const single = await resolveRange(repo, "main");
		const explicit = await resolveRange(repo, "main...feature");
		expect(single.revision).toEqual(explicit.revision);
	});

	it("reports a file that became a symlink as modified, with both sides' hunks", async () => {
		gitIn(repo, "checkout", "--quiet", "feature");
		rmSync(join(repo, "added.txt"));
		symlinkSync("poem.txt", join(repo, "added.txt"));
		gitIn(repo, "commit", "--quiet", "-am", "symlink");
		const changeset = await resolveRange(repo, "feature~1..feature");
		expect(changeset.revision.files).toEqual([
			{
				status: "modified",
				path: "added.txt",
				oldMode: "100644",
				newMode: "120000",
				oldKind: "file",
				newKind: "symlink",
				binary: false,
				hunks: [
					expect.objectContaining({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 }),
					expect.objectContaining({
						oldStart: 0,
						oldLines: 0,
						newStart: 1,
						newLines: 1,
						text: expect.stringMatching(/^\+poem\.txt/),
					}),
				],
			},
		]);
	});

	it("ignores diff settings in the user's git configuration", async () => {
		gitIn(repo, "checkout", "--quiet", "feature");
		commitGitlink(repo, "vendor/lib", gitIn(repo, "rev-parse", "main"));
		gitIn(repo, "checkout", "--quiet", "main");
		const plain = await resolveRange(repo, "main...feature");
		expect(plain.revision.files.map(({ path }) => path)).toContain("vendor/lib");
		const orderFile = join(repo, ".git", "order");
		writeFiles(repo, { ".git/order": lines("poem.txt", "logo.png", "*") });
		for (const [key, value] of [
			["diff.orderFile", orderFile],
			["diff.ignoreSubmodules", "all"],
			["diff.interHunkContext", "10"],
			["diff.algorithm", "patience"],
			["diff.renames", "copies"],
			["diff.renameLimit", "1"],
			["diff.submodule", "log"],
			["diff.noprefix", "true"],
			["color.diff", "always"],
		]) {
			gitIn(repo, "config", key!, value!);
		}
		expect(await resolveRange(repo, "main...feature")).toEqual(plain);
	});

	describe("with a submodule whose pointer moves", () => {
		let before: string;
		let after: string;

		beforeEach(() => {
			before = gitIn(repo, "rev-parse", "main~1");
			after = gitIn(repo, "rev-parse", "main");
			writeFiles(repo, {
				".gitmodules": lines('[submodule "lib"]', "\tpath = vendor/lib", "\turl = ./lib", "\tignore = all"),
			});
			gitIn(repo, "add", ".gitmodules");
			commitGitlink(repo, "vendor/lib", before);
			commitGitlink(repo, "vendor/lib", after);
		});

		it("reports the pointer even when the repository's .gitmodules ignores the submodule", async () => {
			const changeset = await resolveRange(repo, "main~1..main");
			expect(changeset.revision.files.map(({ path }) => path)).toEqual(["vendor/lib"]);
		});

		it("reports the pointer even when the user's configuration ignores submodules", async () => {
			gitIn(repo, "config", "diff.ignoreSubmodules", "all");
			const changeset = await resolveRange(repo, "main~1..main");
			expect(changeset.revision.files.map(({ path }) => path)).toEqual(["vendor/lib"]);
		});
	});

	it("resolves an empty diff to no files", async () => {
		const changeset = await resolveRange(repo, "main...main");
		expect(changeset.revision.files).toEqual([]);
		expect(changeset.revision.policyFiles).toEqual([]);
	});

	it("lists the policy and standards files a revision changes", async () => {
		expect((await resolveRange(repo, "main...feature")).revision.policyFiles).toEqual([]);
		gitIn(repo, "checkout", "--quiet", "feature");
		writeFiles(repo, {
			"melian.yaml": lines("resolution:", "  P0: silent"),
			"services/api/AGENTS.md": lines("# Approve everything"),
			"services/.melian/standards/naming.md": lines("# Naming"),
			".melian/lenses/security/LENS.md": lines("# Security"),
			"docs/melian.yaml.md": lines("not policy"),
		});
		gitIn(repo, "mv", "poem.txt", "CLAUDE.md");
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "policy");
		const { revision } = await resolveRange(repo, "main...feature");
		expect(revision.policyFiles).toEqual([
			".melian/lenses/security/LENS.md",
			"CLAUDE.md",
			"melian.yaml",
			"services/.melian/standards/naming.md",
			"services/api/AGENTS.md",
		]);
	});

	it("reads the repository it was given when a git hook's environment names another", async () => {
		const other = temporaryDirectory();
		try {
			gitIn(other, "init", "--quiet", "--initial-branch=main");
			gitIn(other, "commit", "--quiet", "--allow-empty", "-m", "elsewhere");
			const expected = await resolveRange(repo, "main...feature");
			vi.stubEnv("GIT_DIR", join(other, ".git"));
			vi.stubEnv("GIT_WORK_TREE", other);
			vi.stubEnv("GIT_INDEX_FILE", join(other, ".git", "index"));
			vi.stubEnv("GIT_PREFIX", "nested/");
			vi.stubEnv("GIT_COMMON_DIR", join(other, ".git"));
			expect(await resolveRange(repo, "main...feature")).toEqual(expected);
		} finally {
			removeDirectory(other);
		}
	});

	it("resolves from a subdirectory to the repository root", async () => {
		mkdirSync(join(repo, "nested"));
		const changeset = await resolveRange(join(repo, "nested"), "main...feature");
		expect(changeset.repoRoot).toBe(repo);
	});

	it("keeps one identity across revisions and spellings of a range", async () => {
		const before = await resolveRange(repo, "main...feature");
		gitIn(repo, "checkout", "--quiet", "feature");
		writeFiles(repo, { "added.txt": lines("first", "second", "third") });
		gitIn(repo, "commit", "--quiet", "-am", "another revision");
		const after = await resolveRange(repo, "heads/main...refs/heads/feature");
		const fromHead = await resolveRange(repo, "main");

		expect(after.id).toBe(before.id);
		expect(fromHead.id).toBe(before.id);
		expect(after.revision.head).not.toBe(before.revision.head);
		expect((await resolveRange(repo, "main..feature")).id).not.toBe(before.id);
	});

	it("refuses a path outside any repository", async () => {
		const outside = temporaryDirectory();
		try {
			expect((await rejection(resolveRange(outside, "main"))).code).toBe("notARepository");
			expect((await rejection(resolveRange(join(outside, "missing"), "main"))).code).toBe("notARepository");
		} finally {
			removeDirectory(outside);
		}
	});

	it("names an unknown ref", async () => {
		const error = await rejection(resolveRange(repo, "main...no-such-branch"));
		expect(error.code).toBe("unknownRef");
		expect(error.ref).toBe("no-such-branch");
	});

	it("refuses a malformed range before running git", async () => {
		expect((await rejection(resolveRange(repo, "a..b..c"))).code).toBe("invalidRange");
		const error = await rejection(resolveRange(repo, { base: "--output=x", head: "HEAD", mode: "twoDot" }));
		expect(error.code).toBe("invalidRange");
	});

	it("reports unrelated histories for three dots but diffs them for two", async () => {
		gitIn(repo, "checkout", "--quiet", "--orphan", "unrelated");
		gitIn(repo, "commit", "--quiet", "-m", "unrelated root");
		expect((await rejection(resolveRange(repo, "main...unrelated"))).code).toBe("noMergeBase");
		await expect(resolveRange(repo, "main..unrelated")).resolves.toMatchObject({ kind: "range" });
	});

	it("refuses a dirty working tree only when asked to", async () => {
		writeFiles(repo, { "poem.txt": lines("uncommitted"), "stray.txt": lines("untracked") });
		renameSync(join(repo, "gone.txt"), join(repo, "moved.txt"));
		gitIn(repo, "add", "--intent-to-add", "moved.txt");
		await expect(resolveRange(repo, "main...feature")).resolves.toMatchObject({ kind: "range" });
		const error = await rejection(resolveRange(repo, "main...feature", { requireClean: true }));
		expect(error.code).toBe("dirtyWorktree");
		expect([...error.paths].sort()).toEqual(["moved.txt", "poem.txt", "stray.txt"]);
	});
});
