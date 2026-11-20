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

// Names a recording of GitHub's answers, in `@melian-agent/github/testing`'s shape, which scripted mode reads GitHub
// from instead of the network.
export const recordingVariable = "MELIAN_TEST_GITHUB";

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

export async function gitHubFor(
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: { readonly emoji?: boolean } = {},
): Promise<ReviewProvider> {
	return createGitHubProvider({ ...(await gitHubAccess(cwd, env)), ...options });
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

const commitId = /^[0-9a-f]{40}$/;

// Refuses a pull request that moved from the base and head the caller approved, such as the melian round workflow's
// gate approved. The fetched refs are checked too, since a second fetch of the pull request in this clone can move them
// after GitHub answered. `outcome` ends each message, saying what did not happen.
export async function checkExpected(
	pullRequest: PullRequest,
	fetched: Changeset,
	expect: { readonly base: string; readonly head: string },
	outcome: string,
): Promise<void> {
	if (pullRequest.base.sha !== expect.base || pullRequest.head.sha !== expect.head)
		throw new CliError(
			`pull request #${pullRequest.number} is at base ${pullRequest.base.sha} and head ${pullRequest.head.sha}, not the expected base ${expect.base} and head ${expect.head}, so ${outcome}`,
		);
	const mergeBase = await git(fetched.repoRoot, ["merge-base", expect.base, expect.head]);
	if (fetched.revision.base !== mergeBase || fetched.revision.head !== expect.head)
		throw new CliError(
			`pull request #${pullRequest.number}'s fetched refs resolve to base ${fetched.revision.base} and head ${fetched.revision.head}, not the expected base ${mergeBase} and head ${expect.head}, so ${outcome}`,
		);
}

// Refuses records a round reviewed at the approved base and head once the pull request no longer names their revision.
// Main may move on from the approved base, as it does several times during a round: the records still name the
// revision when the head is the same, the approved base is in the base tip's history, and the head's merge base with
// the approved base is the one the pull request diffs from now. Both commits must be whole IDs, since a name such as
// `main` resolves to the tip the caller meant to rule out. `outcome` ends each message, saying what did not happen.
export async function checkApproved(
	pullRequest: PullRequest,
	fetched: Changeset,
	expect: { readonly base: string; readonly head: string },
	outcome: string,
): Promise<void> {
	if (!commitId.test(expect.base) || !commitId.test(expect.head))
		throw new CliError(`the approved base and head must be whole commit IDs, so ${outcome}`);
	if (pullRequest.head.sha !== expect.head || fetched.revision.head !== expect.head)
		throw new CliError(
			`pull request #${pullRequest.number} is at head ${pullRequest.head.sha}, and its fetched refs at ${fetched.revision.head}, not the approved head ${expect.head}, so ${outcome}`,
		);
	const { repoRoot } = fetched;
	const descends = await git(repoRoot, ["merge-base", "--is-ancestor", expect.base, pullRequest.base.sha]).then(
		() => true,
		() => false,
	);
	if (!descends)
		throw new CliError(
			`pull request #${pullRequest.number}'s base ${pullRequest.base.sha} does not hold the approved base ${expect.base} in its history, so ${outcome}`,
		);
	const mergeBase = await git(repoRoot, ["merge-base", expect.base, expect.head]);
	if (fetched.revision.base !== mergeBase)
		throw new CliError(
			`pull request #${pullRequest.number} diffs from ${fetched.revision.base}, not ${mergeBase}, the merge base its approved base and head share, so ${outcome}`,
		);
}

// The commit the pull request diffs from now: the merge base of its base branch, fetched afresh, and its head. A
// retargeted pull request, or one whose base branch took some of its commits, keeps its head but not this, and the
// stored review covers a different diff. Undefined when the head is not here, which happens only once it moved.
export async function currentBase(cwd: string, pullRequest: PullRequest): Promise<string | undefined> {
	await fetchBase(cwd, remote, pullRequest);
	return git(cwd, ["merge-base", pullRequest.base.sha, pullRequest.head.sha]).catch(() => undefined);
}
