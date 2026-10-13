import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultConfig } from "@melian-agent/core";
import { backgroundContext as context, createNodeExecutionEnv, type ExecutionEnv } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MutationScratch } from "../src/mutation-scratch.ts";
import { Sandbox } from "../src/sandbox.ts";
import { Run } from "../src/static.ts";
import { commit, createRepository, gitIn, removeRepository } from "./fixtures/repo.ts";
import { unconfinedSandbox } from "./fixtures/sandbox.ts";

let repo: string;
let head: string;
let stale: string;
const owners: string[] = [];

// A worktree the user added and then deleted by hand: registered, unlocked, and prunable.
beforeEach(() => {
	repo = createRepository();
	head = commit(repo, { "a.ts": "export const a = 1;\n" });
	stale = join(dirname(repo), `users-stale-${process.pid}`);
	gitIn(repo, "worktree", "add", "--quiet", "--detach", stale);
	rmSync(stale, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const owner of owners.splice(0)) rmSync(owner, { recursive: true, force: true });
	removeRepository(repo);
});

function run(env: ExecutionEnv = createNodeExecutionEnv(repo)): Run {
	return new Run(
		{ env, repoRoot: repo, commit: head, tool: "biome", settings: { ...defaultConfig.static.biome, timeout: 60 } },
		context,
	);
}

function registrations(): string {
	return gitIn(repo, "worktree", "list", "--porcelain");
}

it("leaves the user's stale registration alone when a confined teardown drops its own", {
	timeout: 60_000,
}, async () => {
	const teardown = run();
	let scratch = "";
	await teardown.inWorktree(async (root, directory) => {
		scratch = directory;
		expect(registrations()).toContain(`worktree ${root}`);
		teardown.mutationScratch = MutationScratch.open(teardown, directory, unconfinedSandbox, []);
	});
	expect(registrations()).not.toContain(scratch);
	expect(existsSync(scratch)).toBe(false);
	expect(registrations()).toContain(`worktree ${stale}`);
});

// A run that died with its trees in scratch only confined cleanup may remove. The pid is one no process holds.
function crashed(name: string): string {
	const owner = join(dirname(repo), `melian-confined-${name}-${process.pid}`);
	owners.push(owner);
	mkdirSync(join(owner, "base"), { recursive: true });
	for (const tree of [join(owner, "base/tree"), join(owner, "tree")]) {
		gitIn(repo, "worktree", "add", "--quiet", "--detach", "--lock", "--reason", "melian-static pid 2147483646", tree);
		writeFileSync(
			join(gitIn(tree, "rev-parse", "--absolute-git-dir"), "melian-static"),
			JSON.stringify({ tree, pid: 2147483646 }),
		);
	}
	return owner;
}

// An environment whose `at`-th call about the crashed run's files or the repository's registrations throws, as a
// process that died there would stop. Reports whether it got that far.
function crashing(owner: string, at: number): { env: ExecutionEnv; reached: () => boolean } {
	const env = createNodeExecutionEnv(repo);
	let seen = 0;
	let reached = false;
	for (const method of ["exec", "fileInfo", "listDir", "readTextFile", "remove"] as const) {
		const original = env[method].bind(env) as (...args: unknown[]) => unknown;
		vi.spyOn(env, method).mockImplementation(((...args: unknown[]) => {
			const subject = String(args[0]);
			if (subject.includes(owner) || subject.includes("/worktrees") || subject.includes("--git-common-dir")) {
				if (++seen === at) {
					reached = true;
					throw new Error("crash");
				}
			}
			return original(...args);
		}) as never);
	}
	return { env, reached: () => reached };
}

it("ends clean on the next run after a crash between any two teardown steps", { timeout: 120_000 }, async () => {
	vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
	let points = 0;
	for (let at = 1; ; at++) {
		const owner = crashed(`crash${at}`);
		const interrupted = crashing(owner, at);
		const first = await run(interrupted.env)
			.inWorktree(async () => "ran")
			.catch((error: Error) => error.message);
		if (!interrupted.reached()) {
			expect(first).toBe("ran");
		} else {
			expect(first).toBe("crash");
			points++;
			await expect(run().inWorktree(async () => "ran")).resolves.toBe("ran");
		}
		expect(registrations()).not.toContain(owner);
		expect(existsSync(owner)).toBe(false);
		expect(registrations()).toContain(`worktree ${stale}`);
		if (!interrupted.reached()) break;
	}
	// Four lookups before the teardown starts, then its removals, its close, and two registrations to find and drop.
	expect(points).toBeGreaterThanOrEqual(12);
	expect(readdirSync(join(repo, ".git/worktrees"))).toHaveLength(1);
});
