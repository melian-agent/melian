import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultConfig } from "@melian-agent/core";
import { backgroundContext as context, createNodeExecutionEnv, runStaticTool } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Run } from "../src/static.ts";
import { commit, createRepository, gitIn, lines, removeRepository } from "./fixtures/repo.ts";
import { unconfinedNotes } from "./fixtures/sandbox.ts";

let repo: string;
let head: string;
const made: string[] = [];

beforeEach(() => {
	repo = createRepository();
	head = commit(repo, { "src/a.ts": lines("export const a = 1;") });
});

afterEach(() => {
	for (const owner of made.splice(0)) rmSync(owner, { recursive: true, force: true });
	removeRepository(repo);
});

// A worktree at the kind of path a static run uses, added as `lock` says.
function worktree(name: string, lock: readonly string[]): string {
	const owner = join(dirname(repo), `melian-static-${name}-${process.pid}`);
	made.push(owner);
	mkdirSync(owner);
	gitIn(repo, "worktree", "add", "--quiet", "--detach", ...lock, join(owner, "tree"));
	return join(owner, "tree");
}

function registered(tree: string): boolean {
	return gitIn(repo, "worktree", "list", "--porcelain").includes(`worktree ${tree}\n`);
}

const biome = () =>
	runStaticTool(
		{
			env: createNodeExecutionEnv(repo),
			repoRoot: repo,
			commit: head,
			tool: "biome",
			settings: defaultConfig.static.biome,
		},
		context,
	);

it("leaves the user's own worktrees at a run's kind of path, with their files, and names them", {
	timeout: 60_000,
}, async () => {
	const unlocked = worktree("feature", []);
	const theirs = worktree("pinned", ["--lock", "--reason", "do not prune: on a removable disk"]);
	const bare = worktree("bare", ["--lock"]);
	for (const tree of [unlocked, theirs, bare]) writeFileSync(join(tree, "work-in-progress.txt"), "unsaved");
	const result = await biome();
	if (result.status !== "ran") throw new Error(result.reason);
	for (const tree of [unlocked, theirs, bare]) {
		expect(registered(tree)).toBe(true);
		expect(readFileSync(join(tree, "work-in-progress.txt"), "utf8")).toBe("unsaved");
		expect(readFileSync(join(tree, "src/a.ts"), "utf8")).toBe(lines("export const a = 1;"));
	}
	expect([...result.notes].sort()).toEqual(
		[
			`biome left the worktree at ${unlocked} alone: it is not locked, so it is not a static run's.`,
			`biome left the worktree at ${theirs} alone: its lock is not a static run's.`,
			`biome left the worktree at ${bare} alone: its lock is not a static run's.`,
			...unconfinedNotes("biome"),
		].sort(),
	);
});

it("removes a genuine stale tree: a run's lock, a dead process, and its own marker", { timeout: 60_000 }, async () => {
	const tree = worktree("crashed", ["--lock", "--reason", "melian-static pid 2147483646"]);
	writeFileSync(
		join(gitIn(tree, "rev-parse", "--absolute-git-dir"), "melian-static"),
		JSON.stringify({ tree, pid: 2147483646 }),
	);
	const result = await biome();
	expect(result).toMatchObject({ status: "ran", notes: unconfinedNotes("biome") });
	expect(registered(tree)).toBe(false);
	expect(existsSync(dirname(tree))).toBe(false);
});

it("leaves a dead run's lock on a tree whose marker names another tree", { timeout: 60_000 }, async () => {
	const tree = worktree("moved", ["--lock", "--reason", "melian-static pid 2147483646"]);
	writeFileSync(
		join(gitIn(tree, "rev-parse", "--absolute-git-dir"), "melian-static"),
		JSON.stringify({ tree: join(dirname(repo), "melian-static-elsewhere/tree"), pid: 2147483646 }),
	);
	const result = await biome();
	if (result.status !== "ran") throw new Error(result.reason);
	expect(registered(tree)).toBe(true);
	expect(existsSync(join(tree, "src/a.ts"))).toBe(true);
	expect(result.notes).toContain(
		`biome left the worktree at ${tree} alone: its marker names another tree or process.`,
	);
});

it("marks each worktree it adds with its tree and its process, in the repository's git directory", {
	timeout: 60_000,
}, async () => {
	const run = new Run(
		{
			env: createNodeExecutionEnv(repo),
			repoRoot: repo,
			commit: head,
			tool: "biome",
			settings: defaultConfig.static.biome,
		},
		context,
	);
	await run.inWorktree(async (root) => {
		const admin = gitIn(root, "rev-parse", "--absolute-git-dir");
		expect(admin.startsWith(join(repo, ".git/worktrees/"))).toBe(true);
		expect(JSON.parse(readFileSync(join(admin, "melian-static"), "utf8"))).toEqual({ tree: root, pid: process.pid });
		expect(readFileSync(join(admin, "locked"), "utf8").trim()).toBe(`melian-static pid ${process.pid}`);
	});
});

it.each([
	["git cannot name the registration", "--absolute-git-dir", "git rev-parse failed in "],
	["the marker cannot be written", "write", "could not mark "],
] as const)("fails the run and leaves no worktree when %s", { timeout: 60_000 }, async (_name, fault, message) => {
	const env = createNodeExecutionEnv(repo);
	const execute = env.exec.bind(env);
	vi.spyOn(env, "exec").mockImplementation(async (command, options, at) =>
		fault !== "write" && command.includes(fault)
			? { ok: true, value: { exitCode: 128 } }
			: execute(command, options, at),
	);
	if (fault === "write")
		vi.spyOn(env, "writeFile").mockResolvedValue({
			ok: false,
			error: Object.assign(new Error("read-only"), { code: "permission_denied" as const }),
		});
	const run = new Run(
		{ env, repoRoot: repo, commit: head, tool: "biome", settings: defaultConfig.static.biome },
		context,
	);
	const use = vi.fn(async () => "ran");
	await expect(run.inWorktree(use)).rejects.toMatchObject({
		code: "worktreeFailed",
		message: expect.stringContaining(message),
	});
	expect(use).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	expect(gitIn(repo, "worktree", "list", "--porcelain")).not.toContain("melian-static-");
});
