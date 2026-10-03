import { ChangesetError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitOutput } from "../src/git.ts";
import { gitIn, isolatedGitEnv, rejection, removeDirectory, temporaryDirectory } from "./fixtures/repo.ts";

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

describe("gitOutput", () => {
	it("names the subcommand that failed, not the first option", async () => {
		const error = await rejection(
			gitOutput(repo, ["-c", "diff.renames=true", "diff", "no-such-ref", "--"]),
			ChangesetError,
		);
		expect(error.code).toBe("gitFailed");
		expect(error.message).toMatch(/^git diff failed: /);
	});
});
