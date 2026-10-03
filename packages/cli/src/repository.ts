import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { openSqliteStorage } from "@melian-agent/pipeline";

export function git(cwd: string, args: readonly string[]): Promise<string> {
	return new Promise((done, fail) => {
		execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error === null) done(stdout.trim());
			else fail(new CliError(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
		});
	});
}

// A failure printed as its message alone.
export class CliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliError";
	}
}

/** The environment variable naming a directory for Melian's storage, for a host that cannot write under `.git`. */
export const stateDirectoryVariable = "MELIAN_STATE_DIR";

// `melian/` in the common git directory, so every worktree of a clone shares one storage per changeset. Under
// MELIAN_STATE_DIR, a directory per clone: a range's changeset ID hashes only its ref names, so two clones reviewing
// main...HEAD would otherwise share a file.
export async function stateDirectory(repoRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
	const reported = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
	const common = isAbsolute(reported) ? reported : resolve(repoRoot, reported);
	const configured = env[stateDirectoryVariable] ?? "";
	if (configured === "") return join(common, "melian");
	const clone = createHash("sha256").update(realpathSync(common)).digest("hex").slice(0, 16);
	return join(resolve(repoRoot, configured), clone);
}

export async function storagePath(
	repoRoot: string,
	changesetId: string,
	env: NodeJS.ProcessEnv,
	scripted: boolean,
): Promise<string> {
	const directory = join(await stateDirectory(repoRoot, env), ...(scripted ? ["scripted"] : []));
	await mkdir(directory, { recursive: true }).catch((error: Error) => {
		throw unwritable(directory, error);
	});
	return join(directory, `${changesetId}.sqlite`);
}

function unwritable(path: string, error: Error): CliError {
	return new CliError(
		`Melian cannot write its storage at ${path}: ${error.message}. Give this host write access there, or set ${stateDirectoryVariable} to a writable directory, then run the same command again`,
	);
}

// A sandbox that keeps .git read-only fails here, as SQLite's "unable to open database file".
export async function openStorage(path: string): ReturnType<typeof openSqliteStorage> {
	try {
		return await openSqliteStorage(path);
	} catch (error) {
		throw unwritable(path, error as Error);
	}
}

// Fixed ref names, so a pull request's changeset ID, which hashes them, survives every push.
export function pullRequestRefs(number: number): { base: string; head: string; range: string } {
	const base = `refs/melian/pull/${number}/base`;
	const head = `refs/melian/pull/${number}/head`;
	return { base, head, range: `${base}...${head}` };
}

// Points the refs at exactly the commits the provider reported, whatever the branches hold by now.
export async function fetchPullRequest(
	repoRoot: string,
	remote: string,
	pullRequest: {
		number: number;
		base: { ref: string; sha: string };
		head: { sha: string };
		fetch: { headRef: string };
	},
): Promise<void> {
	const refs = pullRequestRefs(pullRequest.number);
	await git(repoRoot, [
		"fetch",
		"--quiet",
		"--no-tags",
		"--no-write-fetch-head",
		remote,
		`+${pullRequest.fetch.headRef}:${refs.head}`,
		`+refs/heads/${pullRequest.base.ref}:${refs.base}`,
	]);
	for (const [ref, commit] of [
		[refs.head, pullRequest.head.sha],
		[refs.base, pullRequest.base.sha],
	] as const) {
		await git(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]).catch(() => {
			throw new CliError(`${commit} is not in this clone after fetching pull request #${pullRequest.number}`);
		});
		await git(repoRoot, ["update-ref", ref, commit]);
	}
}

// Fetches the branch a pull request merges into now, beside the refs its review read, without moving them.
export async function fetchBase(
	repoRoot: string,
	remote: string,
	pullRequest: { number: number; base: { ref: string } },
): Promise<void> {
	await git(repoRoot, [
		"fetch",
		"--quiet",
		"--no-tags",
		"--no-write-fetch-head",
		remote,
		`+refs/heads/${pullRequest.base.ref}:refs/melian/pull/${pullRequest.number}/current-base`,
	]);
}
