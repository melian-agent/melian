import * as childProcess from "node:child_process";
import { type ChildProcess, execFileSync } from "node:child_process";
import { chmodSync, rmSync, symlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSource, SourceError } from "../src/source.ts";
import {
	gitIn,
	isolatedGitEnv,
	rejection,
	removeDirectory,
	sourceFor,
	sourceKinds,
	temporaryDirectory,
	writeFiles,
} from "./fixtures/repo.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof childProcess>()) }));

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, { "rules.md": "RULE", "docs/rules.md": "NESTED_RULE" });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

describe.each(sourceKinds)("source reader from %s", (kind) => {
	it("reports failed ignore checks instead of admitting the path", async () => {
		const reader = await openSource(repo, sourceFor(repo, kind));
		vi.spyOn(reader, "readText").mockResolvedValue(undefined);
		writeFiles(repo, { ".git/config": "[core\ninvalid" });
		const error = await rejection(reader.isIgnored("docs/rules.md"), SourceError);
		expect(error).toMatchObject({ code: "unreadable", path: reader.label("docs/rules.md") });
		expect(error.message).toContain("bad config");
	});

	it("reports failed path listings instead of returning an empty inventory", async () => {
		const reader = await openSource(repo, sourceFor(repo, kind));
		writeFiles(repo, { ".git/config": "[core\ninvalid" });
		const error = await rejection(reader.findPaths(/./), SourceError);
		expect(error.code).toBe("unreadable");
		expect(error.message).toContain("bad config");
	});

	it("refuses to list a symlink or treat a file as a directory", async () => {
		symlinkSync("docs", join(repo, "linked"));
		const reader = await openSource(repo, sourceFor(repo, kind));
		expect(await rejection(reader.list("linked"), SourceError)).toMatchObject({
			code: "symlink",
			path: reader.label("linked"),
		});
		expect(await reader.list("rules.md")).toBeUndefined();
		expect(await reader.list("missing")).toBeUndefined();
		expect(await reader.exists("")).toBe("directory");
		expect(await reader.list("")).toContainEqual({ name: "rules.md", kind: "file" });
	});
});

describe("revision source reader", () => {
	it("skips a symlinked ignore file without reading its target", async () => {
		writeFiles(repo, { "ignore-rules": "rules.md\n" });
		symlinkSync("ignore-rules", join(repo, ".gitignore"));
		const reader = await openSource(repo, sourceFor(repo, "revision"));
		const read = vi.spyOn(reader, "readText");
		expect(await reader.isIgnored("rules.md")).toBe(false);
		expect(read.mock.calls.some(([path]) => path === "ignore-rules")).toBe(false);
	});

	it("propagates an oversized ignore file instead of admitting the import", async () => {
		writeFiles(repo, { "docs/.gitignore": "x".repeat(256 * 1024 + 1) });
		const reader = await openSource(repo, sourceFor(repo, "revision"));
		expect(await rejection(reader.isIgnored("docs/rules.md"), SourceError)).toMatchObject({
			code: "tooLarge",
			path: reader.label("docs/.gitignore"),
			size: 256 * 1024 + 1,
		});
	});

	it("propagates a non-source error while reading ignore rules", async () => {
		const reader = await openSource(repo, sourceFor(repo, "revision"));
		const error = new Error("ignore read failed");
		vi.spyOn(reader, "readText").mockRejectedValueOnce(error);
		await expect(reader.isIgnored("rules.md")).rejects.toBe(error);
	});

	it("refuses revision syntax starting with a caret", async () => {
		sourceFor(repo, "revision");
		expect(await rejection(openSource(repo, { kind: "revision", commit: "^HEAD" }), SourceError)).toMatchObject({
			code: "unknownCommit",
			path: "^HEAD",
		});
	});

	it("reports a corrupt commit ref as unreadable", async () => {
		sourceFor(repo, "revision");
		writeFiles(repo, { ".git/refs/heads/main": "invalid\n" });
		expect(await rejection(openSource(repo, { kind: "revision", commit: "main" }), SourceError)).toMatchObject({
			code: "unreadable",
			path: "main",
		});
	});

	it("keeps gitlinks distinct from readable files", async () => {
		sourceFor(repo, "revision");
		gitIn(repo, "update-index", "--add", "--cacheinfo", `160000,${gitIn(repo, "rev-parse", "HEAD")},module`);
		gitIn(repo, "commit", "--quiet", "-m", "gitlink");
		const reader = await openSource(repo, { commit: "HEAD", kind: "revision" });
		expect(await reader.exists("module")).toBe("other");
		expect(await rejection(reader.readText("module", 64), SourceError)).toMatchObject({
			code: "unreadable",
			path: reader.label("module"),
		});
	});
});

describe("worktree source reader", () => {
	it("refuses a regular file as the repository root", async () => {
		const root = join(repo, "rules.md");
		expect(await rejection(openSource(root, { kind: "worktree" }), SourceError)).toMatchObject({
			code: "missingRoot",
			path: root,
		});
	});

	it("keeps special files distinct from readable files", async () => {
		execFileSync("mkfifo", [join(repo, "pipe")]);
		const reader = await openSource(repo, { kind: "worktree" });
		expect(await reader.exists("pipe")).toBe("other");
		expect(await rejection(reader.readText("pipe", 64), SourceError)).toMatchObject({
			code: "unreadable",
			path: "pipe",
		});
	});

	it.each(["missing", "symlink"])("handles a file replaced by %s between lookup and open", async (replacement) => {
		const reader = await openSource(repo, { kind: "worktree" });
		const file = join(repo, "rules.md");
		const stats = await fs.lstat(file);
		vi.spyOn(fs, "lstat").mockImplementationOnce(async () => {
			rmSync(file);
			if (replacement === "symlink") symlinkSync("docs/rules.md", file);
			return stats;
		});
		const reading = reader.readText("rules.md", 64);
		if (replacement === "missing") expect(await reading).toBeUndefined();
		else expect(await rejection(reading, SourceError)).toMatchObject({ code: "symlink", path: "rules.md" });
	});

	it("treats a directory replaced by a file during lookup as absent", async () => {
		const reader = await openSource(repo, { kind: "worktree" });
		const directory = join(repo, "docs");
		const stats = await fs.lstat(directory);
		vi.spyOn(fs, "lstat").mockImplementationOnce(async () => {
			rmSync(directory, { recursive: true });
			writeFiles(repo, { docs: "FILE" });
			return stats;
		});
		expect(await reader.exists("docs/rules.md")).toBeUndefined();
	});

	it("closes the file and names a failure during its read", async () => {
		const reader = await openSource(repo, { kind: "worktree" });
		const handle = await fs.open(join(repo, "rules.md"), "r");
		const failure = Object.assign(new Error("read failed"), { code: "EIO" });
		vi.spyOn(handle, "readFile").mockRejectedValueOnce(failure);
		const close = vi.spyOn(handle, "close");
		vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
		expect(await rejection(reader.readText("rules.md", 64), SourceError)).toMatchObject({
			code: "unreadable",
			path: "rules.md",
			cause: failure,
		});
		expect(close).toHaveBeenCalledOnce();
	});

	it.skipIf(process.getuid?.() === 0)("names a directory it cannot inspect", async () => {
		chmodSync(join(repo, "docs"), 0o000);
		try {
			const reader = await openSource(repo, { kind: "worktree" });
			expect(await rejection(reader.exists("docs/rules.md"), SourceError)).toMatchObject({
				code: "unreadable",
				path: "docs/rules.md",
			});
		} finally {
			chmodSync(join(repo, "docs"), 0o700);
		}
	});

	it.skipIf(process.getuid?.() === 0)("names a directory it cannot list", async () => {
		chmodSync(join(repo, "docs"), 0o000);
		try {
			const reader = await openSource(repo, { kind: "worktree" });
			expect(await rejection(reader.list("docs"), SourceError)).toMatchObject({
				code: "unreadable",
				path: "docs",
			});
		} finally {
			chmodSync(join(repo, "docs"), 0o700);
		}
	});
});

describe.each(sourceKinds)("source reader bounds from %s", (kind) => {
	it("accepts the exact byte bound and refuses the next byte", async () => {
		writeFiles(repo, { "utf8.md": "éé", "empty.md": "" });
		const reader = await openSource(repo, sourceFor(repo, kind));
		expect(await reader.readText("utf8.md", 4)).toBe("éé");
		expect(await rejection(reader.readText("utf8.md", 3), SourceError)).toMatchObject({
			code: "tooLarge",
			path: reader.label("utf8.md"),
			size: 4,
		});
		expect(await reader.readText("empty.md", 0)).toBe("");
	});

	it("reports an ignore command stopped by a signal", async () => {
		const reader = await openSource(repo, sourceFor(repo, kind));
		const spawn = childProcess.spawn;
		let child: ChildProcess | undefined;
		vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
			if (command !== "git" || !args.includes("check-ignore")) return spawn(command, args, options);
			// Open stdin keeps git alive until the signal, even when the parent is descheduled after spawn.
			child = spawn(command, [...args.slice(0, args.indexOf("--")), "--stdin"], options);
			child.once("spawn", () => expect(child!.kill("SIGTERM")).toBe(true));
			return child;
		});
		expect(await rejection(reader.isIgnored("docs/rules.md"), SourceError)).toMatchObject({
			code: "unreadable",
			path: reader.label("docs/rules.md"),
		});
		expect(child?.pid).toBeDefined();
		expect(child?.signalCode).toBe("SIGTERM");
	});
});
