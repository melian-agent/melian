import { spawn } from "node:child_process";
import { ChangesetError } from "./errors.ts";

export interface GitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Set when stdout reached `maxBytes` and git was stopped; `stdout` then holds the first `maxBytes` bytes. */
	readonly truncated?: boolean;
}

export interface GitOptions {
	/** Stop git once stdout reaches this many bytes. */
	readonly maxBytes?: number;
}

export function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		// Melian only reads; optional locks would contend with an editor or a concurrent git.
		const child = spawn("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
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
		child.on("close", (code) =>
			resolve({
				code: code ?? -1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				...(truncated ? { truncated } : {}),
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
