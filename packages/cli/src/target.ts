import {
	type Changeset,
	ChangesetError,
	type PullRequest,
	pullRequestChangesetId,
	type ReviewProvider,
	resolveRange,
} from "@melian-agent/core";
import {
	createGitHubProvider,
	GitHubError,
	type GitHubRepository,
	parseGitHubRemote,
	resolveGitHubToken,
} from "@melian-agent/github";
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

export async function gitHubFor(cwd: string, env: NodeJS.ProcessEnv): Promise<ReviewProvider> {
	const { owner, repo } = await gitHubRepository(cwd);
	const found = await resolveGitHubToken(env);
	if (found === undefined) {
		throw new GitHubError("noToken", "no GitHub token: set GITHUB_TOKEN or GH_TOKEN, or log in with gh auth login");
	}
	return createGitHubProvider({ owner, repo, token: found.token });
}

// The range over the refs Melian fetched, under the pull request's own changeset ID. A range review of the same refs
// keeps its range ID, so it never shares the pull request's storage, or its verdicts.
async function asPullRequest(cwd: string, number: number): Promise<Changeset> {
	const range = await resolveRange(cwd, pullRequestRefs(number).range);
	const { owner, repo } = await gitHubRepository(cwd);
	return { ...range, id: pullRequestChangesetId("github", { owner, name: repo }, number) };
}

export async function pullRequestChangeset(cwd: string, number: number): Promise<Changeset> {
	try {
		return await asPullRequest(cwd, number);
	} catch (error) {
		if (error instanceof ChangesetError && error.code === "unknownRef") {
			throw new CliError(`Melian has not reviewed pull request #${number} here; run melian review #${number} first`);
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
