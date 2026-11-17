import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { git, withoutReplacements } from "../src/git.ts";
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

// Git 2.40 and 2.41 let this setting outrank GIT_NO_REPLACE_OBJECTS, and Melian accepts both.
it("reads core.useReplaceRefs as false though the repository's configuration turns it on", async () => {
	gitIn(repo, "config", "core.useReplaceRefs", "true");

	const { stdout } = await git(repo, ["config", "--get", "core.useReplaceRefs"]);

	expect(stdout).toBe("false\n");
});

it("pins core.useReplaceRefs after every setting a caller's count holds, and keeps them", () => {
	gitIn(repo, "config", "core.useReplaceRefs", "true");
	const caller = Object.fromEntries(
		Array.from({ length: 10 }, (_, n) => [
			[`GIT_CONFIG_KEY_${n}`, `melian.caller${n}`],
			[`GIT_CONFIG_VALUE_${n}`, `kept${n}`],
		]).flat(),
	);
	const env = withoutReplacements({ ...process.env, GIT_CONFIG_COUNT: "10", ...caller });
	const read = (key: string) => execFileSync("git", ["-C", repo, "config", "--get", key], { env, encoding: "utf8" });

	expect([read("core.useReplaceRefs"), read("melian.caller0"), read("melian.caller9")]).toEqual([
		"false\n",
		"kept0\n",
		"kept9\n",
	]);
});

it("pins core.useReplaceRefs in place of a count git would refuse", () => {
	gitIn(repo, "config", "core.useReplaceRefs", "true");
	for (const count of ["x1", "1x"]) {
		const env = withoutReplacements({ ...process.env, GIT_CONFIG_COUNT: count });

		expect(
			execFileSync("git", ["-C", repo, "config", "--get", "core.useReplaceRefs"], { env, encoding: "utf8" }),
			count,
		).toBe("false\n");
	}
});

it("pins core.useReplaceRefs after the settings a caller's GIT_CONFIG_PARAMETERS holds, which git reads after the count", () => {
	const env = withoutReplacements({
		...process.env,
		GIT_CONFIG_COUNT: "0",
		GIT_CONFIG_PARAMETERS: "'core.useReplaceRefs=true' 'melian.caller=kept'",
	});
	const read = (key: string) => execFileSync("git", ["-C", repo, "config", "--get", key], { env, encoding: "utf8" });

	expect([read("core.useReplaceRefs"), read("melian.caller")]).toEqual(["false\n", "kept\n"]);
});
