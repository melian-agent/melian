import { readFile } from "node:fs/promises";
import {
	Changeset,
	ChangesetError,
	type PullRequest,
	pullRequestChangesetId,
	type ReviewProvider,
} from "@melian-agent/core";
import {
	createGitHubProvider,
	GitHubError,
	type GitHubRepository,
	parseGitHubRemote,
	resolveGitHubToken,
} from "@melian-agent/github";
import { type GitHubRecording, recordedGitHub } from "@melian-agent/github/testing";
import { isScripted } from "./models.ts";
import { CliError, fetchBase, fetchPullRequest, git, pullRequestRefs } from "./repository.ts";

export type Target =
	| { readonly kind: "pullRequest"; readonly number: number }
	| { readonly kind: "range"; readonly spec: string };

// A bare number is a range: 1234 is also an abbreviated commit hash.
export function parseTarget(argument: string): Target {
	const match = /^#(\d+)$/.exec(argument);
	return match === null ? { kind: "range", spec: argument } : { kind: "pullRequest", number: Number(match[1]) };
}

const remote = "origin";

async function gitHubRepository(cwd: string): Promise<GitHubRepository> {
	const url = await git(cwd, ["remote", "get-url", remote]).catch(() => {
		throw new CliError(
			`this repository has no ${remote} remote, so Melian cannot tell which GitHub repository it is`,
		);
	});
	return parseGitHubRemote(url);
}

/**
 * The environment variable naming a recording of GitHub's answers, in `@melian-agent/github/testing`'s shape, which
 * scripted mode reads GitHub from instead of the network.
 */
export const recordingVariable = "MELIAN_TEST_GITHUB";

/** How Melian reaches the `origin` repository on GitHub: its owner and name, a token, and in tests a `fetch`. */
export interface GitHubAccess {
	readonly owner: string;
	readonly repo: string;
	readonly token: string;
	readonly fetch?: typeof fetch;
}

// Under scripted mode with a recording, GitHub's answers come from the recording, and no token is needed or read.
export async function gitHubAccess(cwd: string, env: NodeJS.ProcessEnv): Promise<GitHubAccess> {
	const { owner, repo } = await gitHubRepository(cwd);
	const recordingPath = env[recordingVariable] ?? "";
	if (isScripted(env) && recordingPath !== "") {
		const text = await readFile(recordingPath, "utf8").catch(() => {
			throw new CliError(`${recordingVariable} names ${recordingPath}, which cannot be read`);
		});
		return { owner, repo, token: "scripted", fetch: recordedGitHub(JSON.parse(text) as GitHubRecording) };
	}
	const found = await resolveGitHubToken(env);
	if (found === undefined) {
		throw new GitHubError("noToken", "no GitHub token: set GITHUB_TOKEN or GH_TOKEN, or log in with gh auth login");
	}
	return { owner, repo, token: found.token };
}

export async function gitHubFor(cwd: string, env: NodeJS.ProcessEnv): Promise<ReviewProvider> {
	return createGitHubProvider(await gitHubAccess(cwd, env));
}

// The range over the refs Melian fetched, under the pull request's own changeset ID. A range review of the same refs
// keeps its range ID, so it never shares the pull request's storage, or its verdicts.
async function asPullRequest(cwd: string, number: number): Promise<Changeset> {
	const range = await Changeset.resolve(cwd, pullRequestRefs(number).range);
	const { owner, repo } = await gitHubRepository(cwd);
	return range.withId(pullRequestChangesetId("github", { owner, name: repo }, number));
}

export async function pullRequestChangeset(cwd: string, number: number): Promise<Changeset> {
	try {
		return await asPullRequest(cwd, number);
	} catch (error) {
		if (error instanceof ChangesetError && error.code === "unknownRef") {
			throw new CliError(
				`Melian has not reviewed pull request #${number} here; run melian review "#${number}" first`,
			);
		}
		throw error;
	}
}

export async function fetchedPullRequest(
	cwd: string,
	provider: ReviewProvider,
	number: number,
): Promise<{ pullRequest: PullRequest; changeset: Changeset }> {
	const pullRequest = await provider.pullRequest(number);
	await fetchPullRequest(cwd, remote, pullRequest);
	return { pullRequest, changeset: await asPullRequest(cwd, number) };
}

// The commit the pull request diffs from now: the merge base of its base branch, fetched afresh, and its head. A
// retargeted pull request, or one whose base branch took some of its commits, keeps its head but not this, and the
// stored review covers a different diff. Undefined when the head is not here, which happens only once it moved.
export async function currentBase(cwd: string, pullRequest: PullRequest): Promise<string | undefined> {
	await fetchBase(cwd, remote, pullRequest);
	return git(cwd, ["merge-base", pullRequest.base.sha, pullRequest.head.sha]).catch(() => undefined);
}
