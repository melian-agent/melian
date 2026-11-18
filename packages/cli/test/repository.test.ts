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
	it("reads core.useReplaceRefs as false though the repository turns it on, and keeps the caller's own settings", async () => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "melian.caller");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "kept");
		const repo = await realpath(await mkdtemp(join(tmpdir(), "melian-replace-refs-")));
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			gitIn(repo, "config", "core.useReplaceRefs", "true");

			expect(await git(repo, ["config", "--get", "core.useReplaceRefs"])).toBe("false");
			expect(await git(repo, ["config", "--get", "melian.caller"])).toBe("kept");
		} finally {
			vi.unstubAllEnvs();
			await rm(repo, { recursive: true, force: true });
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
