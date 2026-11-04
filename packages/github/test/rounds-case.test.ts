import { PullRequestRoundsReader } from "@melian-agent/github";
import { recordedGitHub } from "@melian-agent/github/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("unexpected network");
		}),
	),
);
afterEach(() => vi.unstubAllGlobals());

it("keeps other pull request associations when GitHub canonicalises repository casing", async () => {
	const base = "a".repeat(40);
	const head = "b".repeat(40);
	const info = { hasNextPage: false, endCursor: null };
	const pull = { baseRefOid: base, headRefOid: head, mergeCommit: null };
	const fetch = recordedGitHub({
		owner: "owner",
		repo: "repo",
		graphql: {
			MelianRoundCommits: [
				{
					data: {
						repository: {
							pullRequest: { ...pull, commits: { nodes: [{ commit: { oid: head } }], pageInfo: info } },
						},
					},
				},
			],
			MelianRoundPushes: [
				{ data: { repository: { pullRequest: { ...pull, timelineItems: { nodes: [], pageInfo: info } } } } },
			],
			MelianRoundAssociations: [
				{
					data: {
						repository: {
							object: {
								associatedPullRequests: {
									nodes: [7, 12].map((number) => ({
										number,
										repository: { name: "repo", owner: { login: "owner" } },
									})),
									pageInfo: info,
								},
							},
						},
					},
				},
			],
		},
	});
	const reader = PullRequestRoundsReader.open({ owner: "OWNER", repo: "Repo", pullRequest: 7, token: "test", fetch });
	expect((await reader.read()).associated).toEqual({ [head]: [7, 12] });
});
