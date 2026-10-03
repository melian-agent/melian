import { ChangesetError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitVersion, gitOutput, requireGitVersion } from "../src/git.ts";
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

describe("checkGitVersion", () => {
	it.each(["git version 2.40.0", "git version 2.50.1 (Apple Git-155)", "git version 3.0.0.windows.1"])(
		"accepts %j",
		(output) => {
			expect(() => checkGitVersion(output)).not.toThrow();
		},
	);

	it.each(["git version 2.39.5", "git version 1.99.0", "not git"])("refuses %j as too old", (output) => {
		expect(() => checkGitVersion(output)).toThrow(expect.objectContaining({ code: "gitTooOld" }));
	});
});

describe("requireGitVersion", () => {
	it("accepts the git these tests run, which must support --attr-source", async () => {
		await expect(requireGitVersion(repo)).resolves.toBeUndefined();
	});
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
