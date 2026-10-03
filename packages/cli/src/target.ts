import {
	type Changeset,
	ChangesetError,
	type PullRequest,
	type ReviewProvider,
	resolveRange,
} from "@melian-agent/core";
import { createGitHubProvider, GitHubError, parseGitHubRemote, resolveGitHubToken } from "@melian-agent/github";
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

export async function gitHubFor(cwd: string, env: NodeJS.ProcessEnv): Promise<ReviewProvider> {
	const url = await git(cwd, ["remote", "get-url", remote]).catch(() => {
		throw new CliError(
			`this repository has no ${remote} remote, so Melian cannot tell which GitHub repository it is`,
		);
	});
	const { owner, repo } = parseGitHubRemote(url);
	const found = await resolveGitHubToken(env);
	if (found === undefined) {
		throw new GitHubError("noToken", "no GitHub token: set GITHUB_TOKEN or GH_TOKEN, or log in with gh auth login");
	}
	return createGitHubProvider({ owner, repo, token: found.token });
}

export async function pullRequestChangeset(cwd: string, number: number): Promise<Changeset> {
	try {
		return await resolveRange(cwd, pullRequestRefs(number).range);
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
	return { pullRequest, changeset: await resolveRange(cwd, pullRequestRefs(number).range) };
}

// A pull request retargeted to another branch keeps its head but not its merge base, so the stored review's diff and
// policy no longer match what GitHub shows.
export async function baseMoved(cwd: string, pullRequest: PullRequest, changeset: Changeset): Promise<boolean> {
	await fetchBase(cwd, remote, pullRequest);
	const base = await git(cwd, ["merge-base", pullRequest.base.sha, pullRequest.head.sha]).catch(() => undefined);
	return base !== changeset.revision.base;
}
