import { spawn } from "node:child_process";
import { ChangesetError } from "./errors.ts";
import { type ProcessControl, ProcessTable, stopTree } from "./process-tree.ts";

/** What a Git command exited with and printed. */
export interface GitResult {
	readonly code: number;
	readonly stdout: string;
	// Undecoded, for output that carries paths: a path need not be UTF-8, and decoding would replace its bytes.
	readonly stdoutBytes: Buffer;
	readonly stderr: string;
	// Set when stdout reached `maxBytes` and git was stopped; `stdout` then holds the first `maxBytes` bytes.
	readonly truncated?: boolean;
	// Set when git ran past `deadlineMs` and was stopped; `code` is then -1.
	readonly timedOut?: boolean;
	// Set when git was stopped but the stop could not find or end the programs git started: the table could not be read
	// in its budget, or no longer showed git. They may still run.
	readonly childrenLeft?: boolean;
}

/** How to run a Git command: a cap on its output, its standard input, and variables to add to its environment. */
export interface GitOptions {
	// Stop git once stdout reaches this many bytes.
	readonly maxBytes?: number;
	// Written to git's standard input, which otherwise ends at once.
	readonly input?: string | Uint8Array;
	// Stop git once it has run this long, as a transfer that stalls on any transport needs.
	readonly deadlineMs?: number;
	// Set in git's environment after the repository-local variables are removed.
	readonly env?: Readonly<Record<string, string>>;
	// The process table a stop reads and signals through; a test passes a fake.
	readonly processes?: ProcessControl;
	// A monotonic clock in milliseconds, which times the stop's budget; a test passes a fake.
	readonly clock?: () => number;
}

/**
 * The most bytes of a Git command's standard error that `git` keeps; past it, `git` stops the command and rejects with
 * `gitOutputTooLarge`. A fetch or push carries there whatever the remote or a credential helper sends. Before the tests
 * that write past this limit on purpose, no command in Melian's tests wrote more than 250 bytes there.
 */
export const stderrLimit = 4 * 1024 * 1024;
const stderrSlab = 64 * 1024;

// What `git rev-parse --local-env-vars` prints. A hook runs with these set for its own repository, and git honours
// them over `cwd`, so Melian run from a hook would read that repository instead of the one it was given.
const repositoryLocalVariables = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
];

function gitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
	for (const name of repositoryLocalVariables) delete env[name];
	return env;
}

/** Runs Git in cwd with repository-local environment variables removed, and resolves with its exit code and output. */
export function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		// Melian only reads; optional locks would contend with an editor or a concurrent git.
		const child = spawn("git", args, { cwd, env: { ...gitEnvironment(), ...options.env } });
		// Git may exit before it reads its input, which ends the pipe with EPIPE; its exit code reports the failure.
		// With no input, git's input ends at once, so a command or credential helper that reads it cannot wait forever.
		child.stdin.on("error", () => {}).end(options.input);
		const stdout: Buffer[] = [];
		// Standard error is copied into slabs: a Buffer kept for each chunk costs a hundred bytes or more, so a remote that
		// writes one byte at a time would hold many times the limit.
		const stderr: Buffer[] = [];
		let size = 0;
		let truncated = false;
		child.stdout.on("data", (chunk: Buffer) => {
			if (truncated) return;
			const room = (options.maxBytes ?? Number.POSITIVE_INFINITY) - size;
			if (chunk.length <= room) {
				stdout.push(chunk);
				size += chunk.length;
				return;
			}
			stdout.push(chunk.subarray(0, room));
			truncated = true;
			void stop().then((all) => finish(-1, false, !all));
		});
		let stderrSize = 0;
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderrSize + chunk.length <= stderrLimit) {
				for (let offset = 0; offset < chunk.length; ) {
					const used = stderrSize % stderrSlab;
					if (used === 0) stderr.push(Buffer.allocUnsafe(stderrSlab));
					const copied = chunk.copy(stderr[stderr.length - 1], used, offset);
					offset += copied;
					stderrSize += copied;
				}
				return;
			}
			// A cut stream is never resolved, so no caller can read part of a message as a failure it knows.
			void stop().then((all) =>
				reject(
					new ChangesetError(
						"gitOutputTooLarge",
						`git ${subcommand(args)} wrote more than ${stderrLimit} bytes to standard error, so Melian stopped it${all ? "" : `; ${unstopped}`}`,
					),
				),
			);
		});
		child.on("error", (cause) =>
			reject(
				new ChangesetError("gitUnavailable", "git could not be started; is it installed and on PATH?", { cause }),
			),
		);
		const finish = (code: number, timedOut: boolean, childrenLeft = false) => {
			clearTimeout(deadline);
			const stdoutBytes = Buffer.concat(stdout);
			resolve({
				code,
				stdout: stdoutBytes.toString("utf8"),
				stdoutBytes,
				stderr: Buffer.concat(stderr, stderrSize).toString("utf8"),
				...(truncated ? { truncated } : {}),
				...(timedOut ? { timedOut } : {}),
				...(childrenLeft ? { childrenLeft } : {}),
			});
		};
		// Git and every program below it, such as ssh waiting at a passphrase prompt, by the pids one read of the process
		// table recorded while git still ran, and git again through its own handle. A program the stop could not find can
		// hold the output pipes open, so this end of both is closed, and git's close no longer settles the call; the stop
		// does, within about a second and within the stop's budget. Resolves false when git had already exited, the budget
		// ran out, or any read of the table failed or no longer showed git, so programs below git may still run.
		let stopped: Promise<boolean> | undefined;
		const stop = () => {
			if (stopped !== undefined) return stopped;
			clearTimeout(deadline);
			// Until Node has reaped git, which sets exitCode or signalCode, git's pid can be no other process's. After, a
			// process that took it would be stopped with its own children, so nothing below git is signalled.
			const stopping =
				child.pid === undefined || child.exitCode !== null || child.signalCode !== null
					? undefined
					: stopTree(
							child.pid,
							budgeted(options.processes ?? new ProcessTable(), options.clock ?? (() => performance.now())),
						);
			child.kill();
			child.stderr.destroy();
			child.stdout.destroy();
			const all = stopping?.then(
				() => true,
				() => false,
			);
			stopped = all ?? Promise.resolve(false);
			return stopped;
		};
		const deadline =
			options.deadlineMs === undefined
				? undefined
				: setTimeout(() => void stop().then((all) => finish(-1, true, !all)), options.deadlineMs);
		child.on("close", (code) => {
			if (stopped === undefined) finish(code ?? -1, false);
		});
	});
}

// How long a stop may read the table and signal, from when it begins. A normal stop takes about a second; each read can
// take up to the table's own limit, so a call settles at most this plus one read after its deadline or output bound.
const stopBudgetMs = 10_000;

// The table, until the budget is spent; then every read throws, so the stop signals nothing more and reports the children
// may still run.
function budgeted(control: ProcessControl, now: () => number): ProcessControl {
	const end = now() + stopBudgetMs;
	return {
		list: () => {
			if (now() > end) throw new Error("the stop's budget is spent");
			return control.list();
		},
		kill: (pid, signal) => control.kill(pid, signal),
	};
}

const unstopped = "Melian could not find or stop every program git started, so some may still run";

// Git's own options that take their value as the next argument.
const optionsWithValues = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

// The first argument after git's own options, such as `diff` in `git -c diff.renames=true diff`.
function subcommand(args: readonly string[]): string {
	for (let i = 0; i < args.length; i++) {
		if (optionsWithValues.has(args[i]!)) i++;
		else if (!args[i]!.startsWith("-")) return args[i]!;
	}
	return "";
}

// 2.40 added --attr-source, without which a checked-out head's .gitattributes decides what its own diff shows.
const minimumVersion = [2, 40] as const;
let versionCheck: Promise<void> | undefined;

// Takes `git --version` output; throws `gitTooOld` for anything older than the minimum, or unrecognised.
export function checkGitVersion(output: string): void {
	const match = /^git version (\d+)\.(\d+)/.exec(output.trim());
	const [major, minor] = minimumVersion;
	if (match !== null && (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor)))
		return;
	throw new ChangesetError(
		"gitTooOld",
		`Melian needs git ${major}.${minor} or later to read diff attributes from the base; found "${output.trim()}"`,
	);
}

export function requireGitVersion(cwd: string): Promise<void> {
	versionCheck ??= git(cwd, ["--version"]).then(
		(result) => checkGitVersion(result.stdout),
		(error: unknown) => {
			versionCheck = undefined;
			throw error;
		},
	);
	return versionCheck;
}

/** Runs a read-only Git command in cwd with repository-local environment variables removed; failures carry Git's message. */
export async function gitOutput(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
	const result = await git(cwd, args, options);
	if (result.code !== 0) throw gitFailure(args, result);
	return result.stdout;
}

/** Runs a read-only Git command as `gitOutput` does, and returns its output undecoded. */
export async function gitOutputBytes(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<Buffer> {
	const result = await git(cwd, args, options);
	if (result.code !== 0) throw gitFailure(args, result);
	return result.stdoutBytes;
}

/** The error a failed Git command raises, naming its subcommand and quoting what Git printed. */
export function gitFailure(args: readonly string[], result: GitResult): ChangesetError {
	return new ChangesetError("gitFailed", `git ${subcommand(args)} failed: ${result.stderr.trim()}`);
}

export function isNotARepository(stderr: string): boolean {
	return /not a git repository/i.test(stderr);
}
