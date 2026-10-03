import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Runs git with an argument array, never a shell string. Resolves with its output, or rejects with its stderr. */
export function git(cwd: string, args: readonly string[]): Promise<string> {
	return new Promise((done, fail) => {
		execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error === null) done(stdout.trim());
			else fail(new CliError(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
		});
	});
}

/** A failure the CLI reports as a message, without a stack. */
export class CliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliError";
	}
}

/**
 * Where Melian keeps a changeset's storage: `melian/<id>.sqlite` in the repository's common git directory, so every
 * worktree of a clone shares one history per changeset. Scripted runs keep theirs apart under `melian/scripted/`, so a
 * review the fake model wrote is never published.
 */
export async function storagePath(repoRoot: string, changesetId: string, scripted: boolean): Promise<string> {
	const common = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
	const directory = join(
		isAbsolute(common) ? common : resolve(repoRoot, common),
		"melian",
		...(scripted ? ["scripted"] : []),
	);
	await mkdir(directory, { recursive: true });
	return join(directory, `${changesetId}.sqlite`);
}

/** The refs a pull request's review reads, under `refs/melian/`, so its changeset keeps one identity across pushes. */
export function pullRequestRefs(number: number): { base: string; head: string; range: string } {
	const base = `refs/melian/pull/${number}/base`;
	const head = `refs/melian/pull/${number}/head`;
	return { base, head, range: `${base}...${head}` };
}

/**
 * Fetches a pull request's head and base branch from `remote` and points its refs at exactly the commits the provider
 * reported, so the review is of the head the pull request shows.
 */
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
