import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangesetError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitVersion, git, gitOutput, requireGitVersion, stderrLimit } from "../src/git.ts";
import { type ProcessControl, ProcessTable } from "../src/process-tree.ts";
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
	// An orphan that has exited stays a zombie until pid 1 reaps it, and a cloud container's pid 1 can leave it unreaped.
	const alive = () => {
		try {
			process.kill(pid, 0);
		} catch {
			return false;
		}
		return !spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
			.stdout.trim()
			.startsWith("Z");
	};
	for (let wait = 0; wait < 40 && alive(); wait++) await new Promise((resolve) => setTimeout(resolve, 50));
	expect(alive()).toBe(false);
}

// Stops the process whose pid a test's stand-in recorded, by that pid alone, if it still runs.
function stopRecorded(file: string): void {
	let pid: number;
	try {
		pid = Number(readFileSync(file, "utf8"));
	} catch {
		return;
	}
	if (!Number.isSafeInteger(pid) || pid <= 1) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}

// A process table that reads the real one and records each signal without sending it.
class RecordingTable implements ProcessControl {
	kills: [number, string][] = [];
	list() {
		return new ProcessTable().list();
	}
	kill(pid: number, signal: "SIGTERM" | "SIGKILL") {
		this.kills.push([pid, signal]);
	}
}

// A process table whose first read works and whose later reads fail, so the stop records the tree but cannot check a
// pid again before it signals it.
class FailsAfterFirstRead extends RecordingTable {
	reads = 0;
	override list() {
		this.reads++;
		if (this.reads > 1) throw new Error("ps failed");
		return super.list();
	}
}

// A process table that cannot be read, as with no ps or a sandbox that refuses it.
const unreadable: ProcessControl = {
	list: () => {
		throw new Error("ps failed");
	},
	kill: () => {
		throw new Error("nothing may be signalled without a table");
	},
};

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

	it.each(["-C", "--git-dir", "--work-tree", "--namespace", "--config-env"])(
		"names the subcommand, not the value of %s",
		async (option) => {
			const value = option === "--config-env" ? "x.y=HOME" : option === "--git-dir" ? join(repo, ".git") : repo;
			const error = await rejection(gitOutput(repo, [option, value, "diff", "no-such-ref", "--"]), ChangesetError);
			expect(error.message).toMatch(/^git diff failed: /);
		},
	);

	it("names no subcommand when every argument is one of git's own options", async () => {
		const error = await rejection(gitOutput(repo, ["--no-such-option"]), ChangesetError);
		expect(error.code).toBe("gitFailed");
		expect(error.message).toMatch(/^git {2}failed: /);
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

	it("stops git once its output reaches maxBytes, and gives the cut result an exit code of -1", async () => {
		// A stand-in for git, found first on PATH, that writes without end, so only the kill ends it.
		const bin = join(repo, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "git"), "#!/bin/sh\nexec yes\n", { mode: 0o755 });
		const result = await git(repo, ["log"], { maxBytes: 4, env: { PATH: `${bin}:${process.env.PATH}` } });
		expect(result).toMatchObject({ code: -1, truncated: true, stdout: "y\ny\n" });
	});

	it("stops the programs git started once its output reaches maxBytes, though one holds the output open", async () => {
		// The stand-in starts a child that keeps git's output for ten seconds, then writes without end.
		const bin = join(repo, "bin");
		const recorded = join(repo, "child-pid");
		mkdirSync(bin);
		writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 10 &\necho $! > ${recorded}\nexec yes\n`, { mode: 0o755 });
		const start = Date.now();
		try {
			const result = await git(repo, ["log"], { maxBytes: 4, env: { PATH: `${bin}:${process.env.PATH}` } });
			expect(result).toMatchObject({ code: -1, truncated: true, stdout: "y\ny\n" });
			expect(result.childrenLeft).toBeUndefined();
			expect(result.timedOut).toBeUndefined();
			expect(Date.now() - start).toBeLessThan(5000);
			await expectEnded(Number(readFileSync(recorded, "utf8")));
		} finally {
			stopRecorded(recorded);
		}
	}, 20_000);
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

	it("reads the process table while git runs, and signals git and its transport by pid", async () => {
		const recorded = join(repo, "pids");
		const transport = join(repo, "transport.sh");
		writeFileSync(transport, `echo "$(ps -o ppid= -p $PPID | tr -d ' ') $$" > ${recorded}\nexec sleep 10\n`);
		const processes = new RecordingTable();
		const result = await git(repo, ["-c", "protocol.ext.allow=always", "fetch", `ext::sh ${transport}`], {
			deadlineMs: 500,
			processes,
		});
		expect(result).toMatchObject({ code: -1, timedOut: true });
		expect(result.childrenLeft).toBeUndefined();
		const [gitPid, transportPid] = readFileSync(recorded, "utf8").trim().split(" ").map(Number);
		expect(processes.kills[0]).toEqual([gitPid, "SIGTERM"]);
		expect(processes.kills).toContainEqual([transportPid, "SIGTERM"]);
	});

	it("stops git alone, and says the programs it started were not stopped, when the process table cannot be read", async () => {
		const recorded = join(repo, "git-pid");
		const transport = join(repo, "transport.sh");
		writeFileSync(transport, `ps -o ppid= -p $PPID | tr -d ' ' > ${recorded}\nexec sleep 10\n`);
		const result = await git(repo, ["-c", "protocol.ext.allow=always", "fetch", `ext::sh ${transport}`], {
			deadlineMs: 500,
			processes: unreadable,
		});
		expect(result).toMatchObject({ code: -1, timedOut: true, childrenLeft: true });
		await expectEnded(Number(readFileSync(recorded, "utf8")));
	});

	it("says the programs git started were not stopped when the process table fails after its first read", async () => {
		const transport = join(repo, "transport.sh");
		writeFileSync(transport, "exec sleep 10\n");
		const processes = new FailsAfterFirstRead();
		const result = await git(repo, ["-c", "protocol.ext.allow=always", "fetch", `ext::sh ${transport}`], {
			deadlineMs: 500,
			processes,
		});
		expect(result).toMatchObject({ code: -1, timedOut: true, childrenLeft: true });
		expect(processes.kills).toEqual([]);
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

	it("stops the transport git started, which would outlive git", async () => {
		// The transport records its own pid and waits, as ssh does at a passphrase prompt; it exits on its own later.
		const recorded = join(repo, "transport-pid");
		const transport = join(repo, "transport.sh");
		writeFileSync(transport, `echo $$ > ${recorded}\nexec sleep 10\n`);
		await git(repo, ["-c", "protocol.ext.allow=always", "fetch", `ext::sh ${transport}`], { deadlineMs: 500 });
		await expectEnded(Number(readFileSync(recorded, "utf8")));
	}, 20_000);

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

	it("says the programs git started were not stopped when git has already exited and one holds its output open", async () => {
		// Git exits at once and its child is re-parented, so the table no longer shows it below git.
		const bin = join(repo, "bin");
		const recorded = join(repo, "child-pid");
		mkdirSync(bin);
		writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 10 &\necho $! > ${recorded}\n`, { mode: 0o755 });
		try {
			const result = await git(repo, ["fetch"], { deadlineMs: 500, env: { PATH: `${bin}:${process.env.PATH}` } });
			expect(result).toMatchObject({ code: -1, timedOut: true, childrenLeft: true });
		} finally {
			stopRecorded(recorded);
		}
	}, 20_000);

	it("lets the process exit when git has already exited and one of the programs it started holds its output open", () => {
		// Git exits at once and its child, re-parented, keeps git's output for ten seconds; the process must not wait for it.
		const bin = join(repo, "bin");
		const recorded = join(repo, "child-pid");
		mkdirSync(bin);
		writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 10 &\necho $! > ${recorded}\n`, { mode: 0o755 });
		const fixture = fileURLToPath(new URL("./fixtures/children-left-exit.ts", import.meta.url));
		const start = Date.now();
		try {
			const out = execFileSync(process.execPath, ["--conditions=@melian-agent/source", fixture, repo, bin], {
				encoding: "utf8",
				timeout: 20_000,
			});
			expect(JSON.parse(out)).toEqual({ code: -1, stdout: "", timedOut: true, childrenLeft: true });
			expect(Date.now() - start).toBeLessThan(5000);
		} finally {
			stopRecorded(recorded);
		}
	}, 30_000);

	it.each([
		["exits", ""],
		["is killed by a signal", "kill -KILL $$\n"],
	])(
		"signals nothing below git once git %s, though another process now holds its pid",
		async (_, ending) => {
			// Git ends at once while its child holds its output, and the table then shows git's pid as another process's.
			const bin = join(repo, "bin");
			const gitPid = join(repo, "git-pid");
			const recorded = join(repo, "child-pid");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "git"),
				`#!/bin/sh\necho $$ > ${gitPid}\nsleep 10 &\necho $! > ${recorded}\n${ending}`,
				{
					mode: 0o755,
				},
			);
			const kills: [number, string][] = [];
			const reused: ProcessControl = {
				list: () => {
					const pid = Number(readFileSync(gitPid, "utf8"));
					return [
						{ pid, ppid: 1, start: "Mon Nov 16 03:00:00 2026", command: "vim" },
						{ pid: pid + 100_000, ppid: pid, start: "Mon Nov 16 03:00:01 2026", command: "less" },
					];
				},
				kill: (pid, signal) => {
					kills.push([pid, signal]);
				},
			};
			try {
				const result = await git(repo, ["fetch"], {
					deadlineMs: 500,
					env: { PATH: `${bin}:${process.env.PATH}` },
					processes: reused,
				});
				expect(result).toMatchObject({ code: -1, timedOut: true, childrenLeft: true });
				expect(kills).toEqual([]);
			} finally {
				stopRecorded(recorded);
			}
		},
		20_000,
	);

	// A stand-in git that keeps running, and a fake table that shows it with one child. A kill is recorded, never sent, so
	// both stay in the table and the stop runs its whole course: SIGTERM to each, a second of grace, SIGKILL to each.
	function budgetStop(jumpAfterThirdRead?: number) {
		const bin = join(repo, "bin");
		const gitPid = join(repo, "git-pid");
		mkdirSync(bin);
		writeFileSync(join(bin, "git"), `#!/bin/sh\necho $$ > ${gitPid}\nexec sleep 10\n`, { mode: 0o755 });
		let now = 0;
		let reads = 0;
		const kills: [number, string][] = [];
		const processes: ProcessControl = {
			list: () => {
				reads++;
				if (reads === 3 && jumpAfterThirdRead !== undefined) now = jumpAfterThirdRead;
				const pid = Number(readFileSync(gitPid, "utf8"));
				return [
					{ pid, ppid: process.pid, start: "Mon Nov 16 03:00:00 2026", command: "git" },
					{ pid: pid + 100_000, ppid: pid, start: "Mon Nov 16 03:00:01 2026", command: "ssh" },
				];
			},
			kill: (pid, signal) => {
				kills.push([pid, signal]);
			},
		};
		const run = (clock?: () => number) =>
			git(repo, ["fetch"], {
				deadlineMs: 500,
				env: { PATH: `${bin}:${process.env.PATH}` },
				processes,
				...(clock === undefined ? {} : { clock }),
			});
		return { run, kills, clock: () => now, pid: () => Number(readFileSync(gitPid, "utf8")) };
	}

	it("runs a stop whose reads all fall inside its budget as before", async () => {
		const stop = budgetStop();
		const result = await stop.run();
		const pid = stop.pid();
		expect(result).toMatchObject({ code: -1, timedOut: true });
		expect(result.childrenLeft).toBeUndefined();
		expect(stop.kills).toEqual([
			[pid, "SIGTERM"],
			[pid + 100_000, "SIGTERM"],
			[pid, "SIGKILL"],
			[pid + 100_000, "SIGKILL"],
		]);
	}, 20_000);

	it("reads the table at the end of the stop's three-second budget", async () => {
		const stop = budgetStop(3000);
		const result = await stop.run(stop.clock);
		const pid = stop.pid();
		expect(result.childrenLeft).toBeUndefined();
		expect(stop.kills).toEqual([
			[pid, "SIGTERM"],
			[pid + 100_000, "SIGTERM"],
			[pid, "SIGKILL"],
			[pid + 100_000, "SIGKILL"],
		]);
	}, 20_000);

	it("reads and signals nothing more one millisecond past the stop's budget, and says the children may still run", async () => {
		const stop = budgetStop(3001);
		const result = await stop.run(stop.clock);
		expect(result).toMatchObject({ code: -1, timedOut: true, childrenLeft: true });
		expect(stop.kills).toEqual([[stop.pid(), "SIGTERM"]]);
	}, 20_000);

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
		// Git still runs when the stop reads the table, as a fetch does while its remote writes.
		const flood = standIn(`${writes(stderrLimit + 1)}\nwhile :; do sleep 1; done`);
		const error = await rejection(
			git(repo, ["-c", "fetch.prune=false", "fetch", "origin"], { env: flood }),
			ChangesetError,
		);
		expect(error.code).toBe("gitOutputTooLarge");
		expect(error.message).toBe(
			`git fetch wrote more than ${stderrLimit} bytes to standard error, so Melian stopped it`,
		);
	});

	it("stops git's tree on a flood, through the process table it is given", async () => {
		const processes = new RecordingTable();
		// Git still runs when the stop reads the table; one that had exited would leave the stop nothing to record. It
		// runs no exec, which would change its command before the signal, and nothing it starts outlives a second.
		const error = await rejection(
			git(repo, ["fetch"], { env: standIn(`${writes(stderrLimit + 1)}\nwhile :; do sleep 1; done`), processes }),
			ChangesetError,
		);
		expect(error.message).toBe(
			`git fetch wrote more than ${stderrLimit} bytes to standard error, so Melian stopped it`,
		);
		expect(processes.kills.map(([, signal]) => signal)).toContain("SIGTERM");
	});

	it("says the programs git started were not stopped on a flood, when the process table cannot be read", async () => {
		const error = await rejection(
			git(repo, ["fetch"], { env: standIn(writes(stderrLimit + 1)), processes: unreadable }),
			ChangesetError,
		);
		expect(error.message).toBe(
			`git fetch wrote more than ${stderrLimit} bytes to standard error, so Melian stopped it; Melian could not find or stop every program git started, so some may still run`,
		);
	});

	it("says the programs git started were not stopped on a flood, when the process table fails after its first read", async () => {
		const processes = new FailsAfterFirstRead();
		const error = await rejection(
			git(repo, ["fetch"], { env: standIn(writes(stderrLimit + 1)), processes }),
			ChangesetError,
		);
		expect(error.message).toBe(
			`git fetch wrote more than ${stderrLimit} bytes to standard error, so Melian stopped it; Melian could not find or stop every program git started, so some may still run`,
		);
		expect(processes.kills).toEqual([]);
	});

	it("stops git itself by its own pid, not only the stream", async () => {
		// After passing the limit this git writes nothing more, so closing the stream cannot end it; only the kill can.
		// Unkilled, it ends on its own after ten seconds.
		const recorded = join(repo, "git-pid");
		const env = standIn(`echo $$ > ${recorded}\n${writes(stderrLimit + 1)}\nsleep 10`);
		const error = await rejection(git(repo, ["fetch"], { env }), ChangesetError);
		expect(error.code).toBe("gitOutputTooLarge");
		await expectEnded(Number(readFileSync(recorded, "utf8")));
	}, 20_000);

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
