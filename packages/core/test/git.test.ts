import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangesetError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitVersion, git, gitOutput, requireGitVersion, stderrLimit } from "../src/git.ts";
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

// Waits up to two seconds for a recorded process to end. Only a real process's own pid is signalled, never 0, 1 or a
// group, and only with signal 0, which tests whether it exists.
async function expectEnded(pid: number): Promise<void> {
	expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	for (let wait = 0; wait < 40 && alive(); wait++) await new Promise((resolve) => setTimeout(resolve, 50));
	expect(alive()).toBe(false);
}

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

	it("stops the git process itself, not only the wait for it", async () => {
		// The transport's parent is git's remote helper, whose parent is the git process the deadline must stop; the
		// transport records that pid, and exits on its own later.
		const recorded = join(repo, "git-pid");
		const transport = join(repo, "transport.sh");
		writeFileSync(transport, `ps -o ppid= -p $PPID | tr -d ' ' > ${recorded}\nsleep 10\n`);
		await git(repo, ["-c", "protocol.ext.allow=always", "fetch", `ext::sh ${transport}`], { deadlineMs: 500 });
		await expectEnded(Number(readFileSync(recorded, "utf8")));
	});

	it("lets the process exit once the deadline passes, though git's transport holds its output open", () => {
		// The transport keeps the output git gave it for ten seconds; the process must not wait for it.
		const transport = join(repo, "transport.sh");
		writeFileSync(transport, "sleep 10\n");
		const fixture = fileURLToPath(new URL("./fixtures/deadline-exit.ts", import.meta.url));
		const start = Date.now();
		const out = execFileSync(process.execPath, ["--conditions=@melian-agent/source", fixture, repo, transport], {
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(out).toBe("true\n");
		expect(Date.now() - start).toBeLessThan(5000);
	}, 30_000);

	it("leaves a command that ends in time as it is", async () => {
		const result = await git(repo, ["rev-parse", "--is-inside-work-tree"], { deadlineMs: 10_000 });
		expect(result).toEqual({ code: 0, stdout: "true\n", stdoutBytes: Buffer.from("true\n"), stderr: "" });
	});
});

describe("git with a standard error past its limit", () => {
	// A stand-in for git, found first on PATH, that runs the given shell script.
	const standIn = (script: string) => {
		const bin = join(repo, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
		return { PATH: `${bin}:${process.env.PATH}` };
	};
	const writes = (bytes: number) => `head -c ${bytes} /dev/zero | tr '\\0' x >&2`;

	it("keeps a standard error of exactly its limit", async () => {
		const result = await git(repo, ["fetch"], { env: standIn(writes(stderrLimit)) });
		expect(result).toEqual({ code: 0, stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "x".repeat(stderrLimit) });
	});

	it("stops git one byte past its limit, and says which stream passed which limit", async () => {
		const error = await rejection(
			git(repo, ["-c", "fetch.prune=false", "fetch", "origin"], { env: standIn(writes(stderrLimit + 1)) }),
			ChangesetError,
		);
		expect(error.code).toBe("gitOutputTooLarge");
		expect(error.message).toBe(
			`git fetch wrote more than ${stderrLimit} bytes to standard error, so Melian stopped it`,
		);
	});

	it("stops a remote that writes to standard error without end, and the remote with it", async () => {
		// The transport records its own pid, then writes for ever to the standard error it shares with git.
		const recorded = join(repo, "transport-pid");
		const transport = join(repo, "transport.sh");
		writeFileSync(transport, `echo $$ > ${recorded}\nexec yes >&2\n`);
		const error = await rejection(
			git(repo, ["-c", "protocol.ext.allow=always", "fetch", `ext::sh ${transport}`], { deadlineMs: 60_000 }),
			ChangesetError,
		);
		expect(error.code).toBe("gitOutputTooLarge");
		await expectEnded(Number(readFileSync(recorded, "utf8")));
	}, 20_000);

	it("lets the process exit once it stops git, though the deadline is far off", () => {
		const transport = join(repo, "transport.sh");
		writeFileSync(transport, "exec yes >&2\n");
		const fixture = fileURLToPath(new URL("./fixtures/stderr-flood-exit.ts", import.meta.url));
		const start = Date.now();
		const out = execFileSync(process.execPath, ["--conditions=@melian-agent/source", fixture, repo, transport], {
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(out).toBe("gitOutputTooLarge\n");
		expect(Date.now() - start).toBeLessThan(10_000);
	}, 30_000);
});
