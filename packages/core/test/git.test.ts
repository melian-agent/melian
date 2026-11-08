import { ChangesetError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitVersion, git, gitOutput, requireGitVersion } from "../src/git.ts";
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

describe("git", () => {
	it("writes its input to git's standard input", async () => {
		const result = await git(repo, ["hash-object", "--stdin"], { input: "melian\n" });
		expect(result).toMatchObject({ code: 0, stdout: "a0f65a5c40a43bdb94fe28039ba991c097628f00\n" });
	});

	it("adds the variables it is given to git's environment", async () => {
		const result = await git(repo, ["var", "GIT_COMMITTER_IDENT"], {
			env: { GIT_COMMITTER_NAME: "Melian state", GIT_COMMITTER_EMAIL: "state@melian.invalid" },
		});
		expect(result.stdout).toMatch(/^Melian state <state@melian\.invalid> /);
	});
});

describe("git with input it does not read", () => {
	it("resolves with git's failure when git exits before reading a large input", async () => {
		const result = await git(repo, ["rev-parse", "--verify", "--quiet", "absent"], {
			input: "x".repeat(16 * 1024 * 1024),
		});
		expect(result.code).not.toBe(0);
	});
});

it("gives git an ended input when it is given none, so a command that reads it cannot wait forever", async () => {
	const result = await git(repo, ["hash-object", "--stdin"]);
	expect(result).toMatchObject({ code: 0, stdout: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n" });
}, 5_000);

describe("git with a deadline", () => {
	// A transport that never answers, as a stalled remote does; it exits on its own after ten seconds.
	const stalled = ["-c", "protocol.ext.allow=always", "fetch", "ext::sh -c sleep% 10"];

	it("stops git once the deadline passes, and says it timed out", async () => {
		const start = Date.now();
		const result = await git(repo, stalled, { deadlineMs: 500 });
		expect(result).toMatchObject({ code: -1, timedOut: true });
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("leaves a command that ends in time as it is", async () => {
		const result = await git(repo, ["rev-parse", "--is-inside-work-tree"], { deadlineMs: 10_000 });
		expect(result).toEqual({ code: 0, stdout: "true\n", stdoutBytes: Buffer.from("true\n"), stderr: "" });
	});
});
