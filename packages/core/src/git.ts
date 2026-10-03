import { spawn } from "node:child_process";
import { ChangesetError } from "./errors.ts";

export interface GitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
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

export function git(cwd: string, args: readonly string[]): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		// Melian only reads; optional locks would contend with an editor or a concurrent git.
		const child = spawn("git", args, { cwd, env: gitEnvironment() });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (cause) =>
			reject(
				new ChangesetError("gitUnavailable", "git could not be started; is it installed and on PATH?", { cause }),
			),
		);
		child.on("close", (code) =>
			resolve({
				code: code ?? -1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		);
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

// Throws `gitFailed` with git's own message.
export async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
	const result = await git(cwd, args);
	if (result.code !== 0) {
		throw new ChangesetError("gitFailed", `git ${subcommand(args)} failed: ${result.stderr.trim()}`);
	}
	return result.stdout;
}
