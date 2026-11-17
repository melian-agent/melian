import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { git } from "../src/git.ts";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

let repo: string;
let original: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, { "melian.yaml": lines("resolution:", "  P2: block") });
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "strict");
	original = gitIn(repo, "rev-parse", "HEAD");
	writeFiles(repo, { "melian.yaml": lines("resolution:", "  P2: advisory") });
	gitIn(repo, "commit", "--quiet", "--all", "-m", "loose");
	gitIn(repo, "replace", original, gitIn(repo, "rev-parse", "HEAD"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

it("reads a commit's own policy though refs/replace puts a looser one behind its ID", async () => {
	const { config } = await loadConfig(repo, { kind: "revision", commit: original }, ".");

	expect(config.resolution.P2).toBe("block");
});

it("shows a commit's own file through git, not its replacement's", async () => {
	const { stdout } = await git(repo, ["show", `${original}:melian.yaml`]);

	expect(stdout).toBe(lines("resolution:", "  P2: block"));
});
