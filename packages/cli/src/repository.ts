import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

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

// The common git directory, so every worktree of a clone shares one storage per changeset.
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
