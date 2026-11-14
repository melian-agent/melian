import { spawnSync } from "node:child_process";
import * as files from "node:fs/promises";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolManifest } from "@melian-agent/core";
import { StorePrune } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commit, createRepository, removeRepository } from "./fixtures/repo.ts";

vi.mock("node:fs/promises", { spy: true });

const manifest = ToolManifest.parse(JSON.stringify({ format_version: 1, tools: {}, misses: [] }));
let repo: string;
let state: string;
let locked: string | undefined;
const coverage = (letter: string) => `coverage/${letter.repeat(64)}`;
// Coverage whose graph is gone, so prune plans to remove it.
async function orphan(letter: string): Promise<void> {
	await mkdir(join(state, coverage(letter)), { recursive: true });
	await writeFile(join(state, coverage(letter), "index.json"), "12345");
}

beforeEach(async () => {
	repo = createRepository();
	commit(repo, { "a.ts": "export const a = 1;\n" });
	state = await realpath(await mkdtemp(join(tmpdir(), "melian-prune-rename-")));
	locked = undefined;
});
afterEach(async () => {
	vi.mocked(files.rename).mockReset();
	vi.mocked(files.rm).mockReset();
	if (locked !== undefined) {
		spawnSync("git", ["-C", repo, "worktree", "unlock", locked]);
		spawnSync("git", ["-C", repo, "worktree", "remove", "--force", locked]);
		await rm(locked, { recursive: true, force: true });
	}
	removeRepository(repo);
	await rm(state, { recursive: true, force: true });
});

// A rename that fails while a forced rm of the new name succeeds, as an immutable entry's does.
it("stops at a rename that fails for a reason other than the path being gone, and counts nothing removed", async () => {
	await orphan("a");
	const prune = await StorePrune.open(repo, { root: state, manifest });
	expect(prune.entries).toEqual([{ kind: "orphan coverage", paths: [coverage("a")], bytes: 5 }]);
	vi.mocked(files.rename).mockRejectedValueOnce(
		Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
	);
	await expect(prune.apply()).rejects.toMatchObject({ code: "EPERM" });
	expect((await lstat(join(state, coverage("a"), "index.json"))).size).toBe(5);
});

it("stops at a static run that starts between two removals, and keeps the second entry", async () => {
	await orphan("a");
	await orphan("b");
	const prune = await StorePrune.open(repo, { root: state, manifest });
	expect(prune.entries).toEqual([
		{ kind: "orphan coverage", paths: [coverage("a")], bytes: 5 },
		{ kind: "orphan coverage", paths: [coverage("b")], bytes: 5 },
	]);
	const path = await realpath(await mkdtemp(join(tmpdir(), "melian-prune-late-run-")));
	await rm(path, { recursive: true });
	vi.mocked(files.rm).mockImplementationOnce(async () => {
		const added = spawnSync("git", [
			"-C",
			repo,
			"worktree",
			"add",
			"--lock",
			"--reason",
			`melian-static pid ${process.pid}`,
			"--detach",
			path,
		]);
		expect(added.status).toBe(0);
		locked = path;
	});
	expect(await prune.apply()).toEqual({
		removed: [{ kind: "orphan coverage", paths: [coverage("a")], bytes: 5 }],
		live: [{ pid: process.pid, worktree: path }],
	});
	expect((await lstat(join(state, coverage("b"), "index.json"))).size).toBe(5);
});
