import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	listRevisionFiles,
	OutsideRepositoryError,
	RevisionError,
	readRevisionFile,
	repositoryPath,
	revisionTree,
	searchRevision,
	searchRevisionFiles,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	gitIn,
	isolatedGitEnv,
	lines,
	rejection,
	removeDirectory,
	temporaryDirectory,
	writeFiles,
} from "./fixtures/repo.ts";

let repo: string;
let head: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, {
		"src/total.ts": lines(
			"export function total(items: number[]) {",
			"\treturn items.reduce((a, b) => a + b, 0);",
			"}",
		),
		"src/sub/*.ts": lines("literal star"),
		"src/sub/b.ts": lines("export const b = total([1]);"),
		"docs/readme.md": lines("Total is documented here."),
		"image.bin": Buffer.from([0x89, 0x50, 0x00, 0x01]),
	});
	symlinkSync("../total.ts", join(repo, "src/sub/link.ts"));
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "--quiet", "-m", "base");
	head = gitIn(repo, "rev-parse", "HEAD");
	// The working tree moves on; reads at head must not see it.
	writeFiles(repo, { "src/total.ts": lines("uncommitted"), "src/untracked.ts": lines("untracked") });
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

describe("repositoryPath", () => {
	it("normalises a path inside the repository", () => {
		expect(repositoryPath("./src//sub/../total.ts")).toBe("src/total.ts");
		expect(repositoryPath("src/")).toBe("src");
		expect(repositoryPath("")).toBe("");
		expect(repositoryPath(".")).toBe("");
	});

	it("refuses absolute paths and paths that climb out", () => {
		for (const path of ["/etc/passwd", "../outside", "src/../../outside", "a\0b"]) {
			expect(() => repositoryPath(path)).toThrow(OutsideRepositoryError);
		}
	});
});

describe("readRevisionFile", () => {
	it("reads the committed content, not the working tree", async () => {
		const file = await readRevisionFile(repo, head, "src/total.ts");
		expect(file.content).toContain("items.reduce");
		expect(file).toMatchObject({ path: "src/total.ts", truncated: false });
	});

	it("reads a file whose name holds a glob character as itself", async () => {
		expect((await readRevisionFile(repo, head, "src/sub/*.ts")).content).toBe("literal star\n");
	});

	it("reads a file far past what one tool call shows, whole", async () => {
		gitIn(repo, "checkout", "--quiet", "--", ".");
		writeFiles(repo, { "big.ts": "const line = 0;\n".repeat(30_000) });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "big");
		const file = await readRevisionFile(repo, gitIn(repo, "rev-parse", "HEAD"), "big.ts");
		expect(file).toMatchObject({ size: 480_000, truncated: false });
		expect(file.content.split("\n")).toHaveLength(30_001);
	});

	it("cuts a file at the byte limit", async () => {
		const file = await readRevisionFile(repo, head, "src/total.ts", 10);
		expect(file).toMatchObject({ content: "export fun", truncated: true });
	});

	it("does not see untracked files", async () => {
		const error = await rejection(readRevisionFile(repo, head, "src/untracked.ts"), RevisionError);
		expect(error.code).toBe("notFound");
	});

	it("refuses symlinks, directories, binaries, and bad revisions", async () => {
		const code = async (revision: string, path: string) =>
			(await rejection(readRevisionFile(repo, revision, path), RevisionError)).code;
		expect(await code(head, "src/sub/link.ts")).toBe("symlink");
		expect(await code(head, "src")).toBe("notAFile");
		expect(await code(head, "image.bin")).toBe("binary");
		expect(await code("--output=x", "src/total.ts")).toBe("invalidRevision");
		expect(await code("0000000000000000000000000000000000000000", "src/total.ts")).toBe("invalidRevision");
	});

	it("refuses a path outside the repository", async () => {
		await rejection(readRevisionFile(repo, head, "../etc/passwd"), OutsideRepositoryError);
	});
});

describe("listRevisionFiles", () => {
	it("lists a directory's direct entries with their kinds", async () => {
		expect((await listRevisionFiles(repo, head, { path: "src" })).entries).toEqual([
			{ path: "src/sub", kind: "directory" },
			{ path: "src/total.ts", kind: "file", size: 85 },
		]);
	});

	it("lists the root by default and every file beneath with recursive", async () => {
		expect((await listRevisionFiles(repo, head)).entries.map((entry) => entry.path)).toEqual([
			"docs",
			"image.bin",
			"src",
		]);
		const all = await listRevisionFiles(repo, head, { recursive: true });
		expect(all.entries.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
			"file docs/readme.md",
			"file image.bin",
			"file src/sub/*.ts",
			"file src/sub/b.ts",
			"symlink src/sub/link.ts",
			"file src/total.ts",
		]);
	});

	it("bounds the number of entries", async () => {
		const listed = await listRevisionFiles(repo, head, { recursive: true, maxEntries: 2 });
		expect(listed.entries).toHaveLength(2);
		expect(listed.truncated).toBe(true);
	});

	it("lists a file alone", async () => {
		expect((await listRevisionFiles(repo, head, { path: "docs/readme.md" })).entries).toEqual([
			{ path: "docs/readme.md", kind: "file", size: 26 },
		]);
	});
});

describe("searchRevision", () => {
	it("finds fixed strings at the revision with line numbers", async () => {
		const found = await searchRevision(repo, head, { attributesFrom: head, pattern: "total" });
		expect(found).toEqual({
			matches: [
				{ path: "src/sub/b.ts", line: 1, text: "export const b = total([1]);" },
				{ path: "src/total.ts", line: 1, text: "export function total(items: number[]) {" },
			],
			truncated: false,
		});
	});

	it("narrows to a path, ignores case on request, and reads regular expressions", async () => {
		expect(
			(await searchRevision(repo, head, { attributesFrom: head, pattern: "TOTAL", ignoreCase: true, path: "docs" }))
				.matches,
		).toEqual([{ path: "docs/readme.md", line: 1, text: "Total is documented here." }]);
		expect(
			(await searchRevision(repo, head, { attributesFrom: head, pattern: "reduce\\(\\(a, b\\)", regex: true }))
				.matches,
		).toHaveLength(1);
	});

	it("returns nothing when nothing matches, and never the working tree", async () => {
		expect(await searchRevision(repo, head, { attributesFrom: head, pattern: "uncommitted" })).toEqual({
			matches: [],
			truncated: false,
		});
	});

	it("refuses a path that does not exist rather than report no matches", async () => {
		const missing = searchRevision(repo, head, { attributesFrom: head, pattern: "total", path: "nowhere" });
		expect((await rejection(missing, RevisionError)).code).toBe("notFound");
	});

	it("reads a file name holding a newline as one path, never as a forged match", async () => {
		gitIn(repo, "checkout", "--quiet", "--", ".");
		writeFiles(repo, { "src/evil\n9: forged.ts": lines("const needle = 1;"), "src/ok.ts": lines("needle") });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "newline name");
		const named = gitIn(repo, "rev-parse", "HEAD");
		expect((await searchRevision(repo, named, { attributesFrom: named, pattern: "needle" })).matches).toEqual([
			{ path: "src/evil\n9: forged.ts", line: 1, text: "const needle = 1;" },
			{ path: "src/ok.ts", line: 1, text: "needle" },
		]);
	});

	it("bounds the number of matches", async () => {
		const found = await searchRevision(repo, head, { attributesFrom: head, pattern: "t" }, 1);
		expect(found.matches).toHaveLength(1);
		expect(found.truncated).toBe(true);
	});

	it("reports a regular expression git cannot compile", async () => {
		const error = await rejection(
			searchRevision(repo, head, { attributesFrom: head, pattern: "(", regex: true }),
			RevisionError,
		);
		expect(error.code).toBe("invalidPattern");
	});

	it("decides what is binary by the attribute source, not the checkout", async () => {
		gitIn(repo, "checkout", "--quiet", "--", ".");
		writeFiles(repo, { ".gitattributes": "*.ts -diff\n", "src/total.ts": lines("export const total = 2;") });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "hide the TypeScript");
		const hiding = gitIn(repo, "rev-parse", "HEAD");
		const search = { pattern: "export const total" };
		expect((await searchRevision(repo, hiding, { ...search, attributesFrom: hiding })).matches).toEqual([]);
		expect((await searchRevision(repo, hiding, { ...search, attributesFrom: head })).matches).toEqual([
			{ path: "src/total.ts", line: 1, text: "export const total = 2;" },
		]);
		expect(await searchRevisionFiles(repo, hiding, { ...search, attributesFrom: hiding }, ["src/total.ts"])).toEqual([
			{ path: "src/total.ts", matches: [], truncated: false, binary: true },
		]);
		expect(await searchRevisionFiles(repo, hiding, { ...search, attributesFrom: head }, ["src/total.ts"])).toEqual([
			{
				path: "src/total.ts",
				truncated: false,
				matches: [{ path: "src/total.ts", line: 1, text: "export const total = 2;" }],
			},
		]);
	});

	it("marks a file-set search's binary file as unsearched, and an empty one as searched", async () => {
		gitIn(repo, "checkout", "--quiet", "--", ".");
		writeFiles(repo, { "docs/empty.md": "" });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "empty");
		const commit = gitIn(repo, "rev-parse", "HEAD");
		expect(
			await searchRevisionFiles(repo, commit, { attributesFrom: commit, pattern: "P" }, [
				"image.bin",
				"docs/empty.md",
				"docs/readme.md",
			]),
		).toEqual([
			{ path: "image.bin", matches: [], truncated: false, binary: true },
			{ path: "docs/empty.md", matches: [], truncated: false },
			{ path: "docs/readme.md", matches: [], truncated: false },
		]);
	});

	// A git on PATH that fails only the name-only binary probe, as a git that dies or warns would, and runs the rest.
	it.each([
		["dies", "128", "fatal: probe failed"],
		["exits 1 but warns", "1", "warning: probe warned"],
	])("refuses a file-set search whose binary probe %s, never calling the file binary", async (_, code, stderr) => {
		const bin = temporaryDirectory();
		const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh\ncase " $* " in *" grep -l "*) echo "${stderr}" >&2; exit ${code};; esac\nexec "${real}" "$@"\n`,
			{ mode: 0o755 },
		);
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
		try {
			await expect(
				searchRevisionFiles(repo, head, { attributesFrom: head, pattern: "absent" }, ["docs/readme.md"]),
			).rejects.toMatchObject({ code: "gitFailed", message: `git grep failed: ${stderr}` });
		} finally {
			removeDirectory(bin);
		}
	});

	it("treats a pattern that looks like an option as text", async () => {
		expect((await searchRevision(repo, head, { attributesFrom: head, pattern: "--output=x" })).matches).toEqual([]);
	});
});

describe("searchRevisionFiles", () => {
	// 64 design files, the most a design index links: the first holds 300 distractor matches, the rest one match each,
	// on a line that differs per file.
	function designFiles(): { paths: string[]; commit: string } {
		const paths = Array.from({ length: 64 }, (_, index) => `docs/design/f${String(index).padStart(2, "0")}.md`);
		writeFiles(
			repo,
			Object.fromEntries(
				paths.map((path, index) => [
					path,
					index === 0
						? lines(...Array.from({ length: 300 }, (_, line) => `needle distractor ${line}`))
						: lines(...Array.from({ length: index }, () => "filler"), `needle in ${path}`),
				]),
			),
		);
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "design");
		return { paths, commit: gitIn(repo, "rev-parse", "HEAD") };
	}

	it("gives every file of the most dispersed set its share, whatever one file's distractors", async () => {
		const { paths, commit } = designFiles();
		const files = await searchRevisionFiles(repo, commit, { attributesFrom: commit, pattern: "needle" }, paths);
		expect(files.map((file) => file.path)).toEqual(paths);
		expect(files[0]).toEqual({
			path: paths[0],
			truncated: true,
			matches: [0, 1, 2].map((line) => ({ path: paths[0], line: line + 1, text: `needle distractor ${line}` })),
		});
		for (const [index, file] of files.slice(1).entries())
			expect(file, file.path).toEqual({
				path: paths[index + 1],
				truncated: false,
				matches: [{ path: paths[index + 1], line: index + 2, text: `needle in ${paths[index + 1]}` }],
			});
		// A single path does not get far: its 200 matches end inside the first file.
		const one = await searchRevision(repo, commit, {
			attributesFrom: commit,
			pattern: "needle",
			path: "docs/design",
		});
		expect(one.truncated).toBe(true);
		expect(new Set(one.matches.map((match) => match.path))).toEqual(new Set([paths[0]]));
	});

	it("shares the matches out at the bound, and marks a file with one more", async () => {
		const { paths, commit } = designFiles();
		const search = { attributesFrom: commit, pattern: "needle" };
		const [alone] = await searchRevisionFiles(repo, commit, search, [paths[0]!], 300);
		expect(alone).toMatchObject({ truncated: false });
		expect(alone!.matches).toHaveLength(300);
		const [cut] = await searchRevisionFiles(repo, commit, search, [paths[0]!], 299);
		expect(cut).toMatchObject({ truncated: true });
		expect(cut!.matches).toHaveLength(299);
		const pair = await searchRevisionFiles(repo, commit, search, [paths[0]!, paths[1]!], 7);
		expect(pair.map((file) => [file.matches.length, file.truncated])).toEqual([
			[3, true],
			[1, false],
		]);
		const [fewest] = await searchRevisionFiles(repo, commit, search, [paths[0]!, paths[1]!], 1);
		expect(fewest!.matches).toHaveLength(1);
	});

	it("gives a later file its match when an earlier file's lines pass the byte bound", async () => {
		writeFiles(repo, {
			"docs/a.md": lines(...Array.from({ length: 300 }, () => `needle ${"x".repeat(50_000)}`)),
			"docs/b.md": lines("needle in b"),
		});
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "long first");
		const commit = gitIn(repo, "rev-parse", "HEAD");
		const [a, b] = await searchRevisionFiles(repo, commit, { attributesFrom: commit, pattern: "needle" }, [
			"docs/a.md",
			"docs/b.md",
		]);
		expect(a!.truncated).toBe(true);
		expect(b).toEqual({
			path: "docs/b.md",
			truncated: false,
			matches: [{ path: "docs/b.md", line: 1, text: "needle in b" }],
		});
	});

	// One match per file allows 2 * 1324 bytes: a record of `<commit>:docs/a.md\0` (51), `1\0` (2), its text and `\n`.
	it("keeps a file whose one matching line passes the byte bound text, not binary", async () => {
		const atBound = `needle ${"x".repeat(2594 - 7)}`;
		writeFiles(repo, { "docs/a.md": lines(atBound), "docs/b.md": lines(`${atBound}x`) });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "one long line");
		const commit = gitIn(repo, "rev-parse", "HEAD");
		const search = { attributesFrom: commit, pattern: "needle" };
		expect(await searchRevisionFiles(repo, commit, search, ["docs/a.md"], 1)).toEqual([
			{
				path: "docs/a.md",
				truncated: false,
				matches: [{ path: "docs/a.md", line: 1, text: atBound.slice(0, 300) }],
			},
		]);
		expect(await searchRevisionFiles(repo, commit, search, ["docs/b.md"], 1)).toEqual([
			{ path: "docs/b.md", truncated: true, matches: [] },
		]);
	});

	it("names a revision's tree, and refuses one that is no commit", async () => {
		expect(await revisionTree(repo, head)).toBe(gitIn(repo, "rev-parse", "HEAD^{tree}"));
		await expect(revisionTree(repo, "0".repeat(40))).rejects.toMatchObject({
			code: "invalidRevision",
			message: `${"0".repeat(40)} does not name a commit`,
		});
		await expect(revisionTree(repo, "--all")).rejects.toThrow('"--all" is not a revision');
	});

	it("marks every file as having more when the output passes its byte bound", async () => {
		writeFiles(repo, {
			"docs/long.md": lines(...Array.from({ length: 150 }, (_, line) => `needle ${line} ${"x".repeat(2000)}`)),
		});
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "long");
		const commit = gitIn(repo, "rev-parse", "HEAD");
		const [long] = await searchRevisionFiles(repo, commit, { attributesFrom: commit, pattern: "needle" }, [
			"docs/long.md",
		]);
		expect(long!.truncated).toBe(true);
		expect(long!.matches.length).toBeLessThan(150);
		const [short] = await searchRevisionFiles(repo, commit, { attributesFrom: commit, pattern: "needle 1 " }, [
			"docs/long.md",
		]);
		expect(short).toMatchObject({ truncated: false, matches: [{ line: 2 }] });
	});

	it("names each file once, marks one absent at the revision, and refuses more than 65", async () => {
		const { paths, commit } = designFiles();
		const search = { attributesFrom: commit, pattern: "needle" };
		expect(
			await searchRevisionFiles(repo, commit, search, [paths[1]!, `./${paths[1]}`, "docs/absent.md", "docs/design"]),
		).toEqual([
			{ path: paths[1], truncated: false, matches: [{ path: paths[1], line: 2, text: `needle in ${paths[1]}` }] },
			{ path: "docs/absent.md", matches: [], truncated: false, missing: true },
			{ path: "docs/design", matches: [], truncated: false, missing: true },
		]);
		expect(await searchRevisionFiles(repo, commit, search, ["src/sub/link.ts"])).toEqual([
			{ path: "src/sub/link.ts", matches: [], truncated: false, missing: true },
		]);
		const [kept] = await searchRevisionFiles(repo, commit, search, [paths[0]!, "docs/absent.md"], 4);
		expect(kept).toMatchObject({ truncated: true });
		expect(kept!.matches).toHaveLength(4);
		expect(await searchRevisionFiles(repo, commit, search, ["docs/absent.md"])).toEqual([
			{ path: "docs/absent.md", matches: [], truncated: false, missing: true },
		]);
		expect(await searchRevisionFiles(repo, commit, { ...search, pattern: "nowhere" }, [paths[1]!])).toEqual([
			{ path: paths[1], matches: [], truncated: false },
		]);
		expect((await searchRevisionFiles(repo, commit, search, [...paths, paths[0]!])).length).toBe(64);
		expect(await searchRevisionFiles(repo, commit, search, [...paths, "docs/readme.md"])).toHaveLength(65);
		await expect(
			searchRevisionFiles(repo, commit, search, [...paths, "docs/readme.md", "src/total.ts"]),
		).rejects.toMatchObject({ code: "tooManyFiles", message: "at most 65 files, not 66" });
		for (const [revision, attributesFrom] of [
			["--output=x", commit],
			[commit, "--output=x"],
		])
			await expect(
				searchRevisionFiles(repo, revision!, { ...search, attributesFrom: attributesFrom! }, [paths[1]!]),
			).rejects.toThrow('"--output=x" is not a revision');
		expect(
			await searchRevisionFiles(
				repo,
				commit,
				{ ...search, pattern: "needle in .*f0[12]\\.md$", regex: true },
				paths.slice(0, 4),
			),
		).toEqual([
			{ path: paths[0], matches: [], truncated: false },
			{ path: paths[1], truncated: false, matches: [{ path: paths[1], line: 2, text: `needle in ${paths[1]}` }] },
			{ path: paths[2], truncated: false, matches: [{ path: paths[2], line: 3, text: `needle in ${paths[2]}` }] },
			{ path: paths[3], matches: [], truncated: false },
		]);
		await expect(searchRevisionFiles(repo, commit, search, ["../outside.md"])).rejects.toBeInstanceOf(
			OutsideRepositoryError,
		);
		const invalid = searchRevisionFiles(repo, commit, { ...search, pattern: "(", regex: true }, [paths[1]!]);
		await expect(invalid).rejects.toMatchObject({ code: "invalidPattern" });
		await expect(invalid).rejects.toThrow(/^"\(" is not a valid regular expression: \S(.*\S)?$/s);
		expect(
			await searchRevisionFiles(repo, commit, { ...search, pattern: "NEEDLE IN", ignoreCase: true }, [paths[2]!]),
		).toEqual([
			{ path: paths[2], truncated: false, matches: [{ path: paths[2], line: 3, text: `needle in ${paths[2]}` }] },
		]);
	});
});
