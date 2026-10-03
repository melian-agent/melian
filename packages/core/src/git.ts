import { spawn } from "node:child_process";
import { ChangesetError } from "./errors.ts";

export interface GitResult {
	readonly code: number;
	readonly stdout: string;
	// Undecoded, for output that carries paths: a path need not be UTF-8, and decoding would replace its bytes.
	readonly stdoutBytes: Buffer;
	readonly stderr: string;
	/** Set when stdout reached `maxBytes` and git was stopped; `stdout` then holds the first `maxBytes` bytes. */
	readonly truncated?: boolean;
}

export interface GitOptions {
	/** Stop git once stdout reaches this many bytes. */
	readonly maxBytes?: number;
}

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

export function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		// Melian only reads; optional locks would contend with an editor or a concurrent git.
		const child = spawn("git", args, { cwd, env: gitEnvironment() });
		const stdout: Buffer[] = [];
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
			child.kill();
		});
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (cause) =>
			reject(
				new ChangesetError("gitUnavailable", "git could not be started; is it installed and on PATH?", { cause }),
			),
		);
		child.on("close", (code) => {
			const stdoutBytes = Buffer.concat(stdout);
			resolve({
				code: code ?? -1,
				stdout: stdoutBytes.toString("utf8"),
				stdoutBytes,
				stderr: Buffer.concat(stderr).toString("utf8"),
				...(truncated ? { truncated } : {}),
			});
		});
	});
}

// The first argument after git's own options, such as `diff` in `git -c diff.renames=true diff`.
function subcommand(args: readonly string[]): string {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-c" || args[i] === "-C") i++;
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

// Throws `gitFailed` with git's own message.
export async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
	const result = await git(cwd, args);
	if (result.code !== 0) throw gitFailure(args, result);
	return result.stdout;
}

export async function gitOutputBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
	const result = await git(cwd, args);
	if (result.code !== 0) throw gitFailure(args, result);
	return result.stdoutBytes;
}

export function gitFailure(args: readonly string[], result: GitResult): ChangesetError {
	return new ChangesetError("gitFailed", `git ${subcommand(args)} failed: ${result.stderr.trim()}`);
}

export function isNotARepository(stderr: string): boolean {
	return /not a git repository/i.test(stderr);
}
