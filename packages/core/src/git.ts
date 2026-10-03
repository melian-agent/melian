import { spawn } from "node:child_process";
import { ChangesetError } from "./errors.ts";

export interface GitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export function git(cwd: string, args: readonly string[]): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		// Melian only reads; optional locks would contend with an editor or a concurrent git.
		const child = spawn("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
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

/** Runs git and returns stdout, or throws `gitFailed` with git's own message. */
export async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
	const result = await git(cwd, args);
	if (result.code !== 0) {
		throw new ChangesetError("gitFailed", `git ${args[0]} failed: ${result.stderr.trim()}`);
	}
	return result.stdout;
}
