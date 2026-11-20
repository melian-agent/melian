import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, writeFiles } from "../../pipeline/test/fixtures/repo.ts";
import { CliError, git, stateDirectory } from "../src/repository.ts";

describe("git", () => {
	it("shows a commit's own file though refs/replace puts another commit behind its ID", async () => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		const repo = await realpath(await mkdtemp(join(tmpdir(), "melian-replace-")));
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, { "melian.yaml": "resolution:\n  P2: block\n" });
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "strict");
			const original = gitIn(repo, "rev-parse", "HEAD");
			writeFiles(repo, { "melian.yaml": "resolution:\n  P2: advisory\n" });
			gitIn(repo, "commit", "--quiet", "--all", "-m", "loose");
			gitIn(repo, "replace", original, gitIn(repo, "rev-parse", "HEAD"));

			expect(await git(repo, ["show", `${original}:melian.yaml`])).toBe("resolution:\n  P2: block");
		} finally {
			vi.unstubAllEnvs();
			await rm(repo, { recursive: true, force: true });
		}
	});
	it("reads core.useReplaceRefs as false though the repository turns it on", async () => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		const repo = await realpath(await mkdtemp(join(tmpdir(), "melian-replace-refs-")));
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			gitIn(repo, "config", "core.useReplaceRefs", "true");

			expect(await git(repo, ["config", "--get", "core.useReplaceRefs"])).toBe("false");
		} finally {
			vi.unstubAllEnvs();
			await rm(repo, { recursive: true, force: true });
		}
	});
});

// Git names the variables that point it at another repository, as a hook's environment sets them for its own.
const localVariables = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
	.split("\n")
	.filter(Boolean);

describe("git's repository-local variables", () => {
	it.each(localVariables)("keeps the caller's %s from the git it runs", async (name) => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		const sentinel = "melian-caller-value";
		const repo = await realpath(await mkdtemp(join(tmpdir(), "melian-local-env-")));
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			gitIn(repo, "config", "alias.melian-env", "!env");
			vi.stubEnv(name, sentinel);

			const environment = (await git(repo, ["melian-env"])).split("\n");
			expect(environment.filter((line) => line.includes(sentinel))).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			await rm(repo, { recursive: true, force: true });
		}
	});
	it("reads the repository it was given though GIT_DIR names another", async () => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		const repo = await realpath(await mkdtemp(join(tmpdir(), "melian-given-")));
		const other = await realpath(await mkdtemp(join(tmpdir(), "melian-other-")));
		try {
			for (const [root, policy] of [
				[repo, "resolution:\n  P2: block\n"],
				[other, "resolution:\n  P2: advisory\n"],
			] as const) {
				gitIn(root, "init", "--quiet", "--initial-branch=main");
				writeFiles(root, { "melian.yaml": policy });
				gitIn(root, "add", "--all");
				gitIn(root, "commit", "--quiet", "-m", "policy");
			}
			vi.stubEnv("GIT_DIR", join(other, ".git"));

			expect(await git(repo, ["show", "main:melian.yaml"])).toBe("resolution:\n  P2: block");
		} finally {
			vi.unstubAllEnvs();
			await rm(repo, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
		}
	});
});

describe("stateDirectory", () => {
	it("reports a directory git refuses as a CliError, which carries no numeric code", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "melian-not-a-repo-")));
		try {
			const failure = await stateDirectory(directory, { GIT_CEILING_DIRECTORIES: directory }).catch(
				(error) => error,
			);
			expect(failure).toBeInstanceOf(CliError);
			expect((failure as { code?: unknown }).code).toBeUndefined();
			expect((failure as Error).message).toMatch(/^git rev-parse failed: fatal: /);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
