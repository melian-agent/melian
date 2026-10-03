import { symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	listRevisionFiles,
	OutsideRepositoryError,
	RevisionError,
	readRevisionFile,
	repositoryPath,
	searchRevision,
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
	});

	it("treats a pattern that looks like an option as text", async () => {
		expect((await searchRevision(repo, head, { attributesFrom: head, pattern: "--output=x" })).matches).toEqual([]);
	});
});
