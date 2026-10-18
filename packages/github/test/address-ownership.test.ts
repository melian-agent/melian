import { createGitHubProvider, marker } from "@melian-agent/github";
import { describe, expect, it } from "vitest";
import { fakeGitHub, fakeState } from "./fixtures/fake-github.ts";

const secret = "11".repeat(32);
const revision = "a".repeat(40);
const finding = "fedcba9876543210";

function fixture(unknown: boolean, signed: boolean, body: string) {
	const state = fakeState(
		"owner",
		"repo",
		{
			number: 7,
			title: "Change",
			base: { ref: "main", sha: "b".repeat(40) },
			head: { ref: "feature", sha: revision },
		},
		{},
	);
	state.failUser = unknown;
	state.reviews.push({
		id: 1,
		user: { login: state.login, type: "Bot" },
		body: signed ? marker(revision, "verdict", "0123456789abcdef", secret, { round: 1 }) : "Human review",
		commit_id: revision,
		event: "COMMENT",
	});
	state.comments.push({
		id: 2,
		user: { login: state.login, type: "Bot" },
		body,
		path: "src/a.ts",
		line: 1,
		side: "RIGHT",
		pull_request_review_id: 1,
	});
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test",
		fetch: fakeGitHub(state),
	});
	return { state, provider };
}

describe.each([true, false])("ownership after a root's marker changes (unknown user: %s)", (unknown) => {
	it.each(["removed", "another finding"])(
		"leaves a human review's root unresolved when its marker is %s",
		async (kind) => {
			const body =
				kind === "removed" ? "Edited human text" : marker(revision, "finding", "0123456789abcdef", secret);
			const { state, provider } = fixture(unknown, false, body);
			expect(
				await provider.replyResolved(
					7,
					{ id: finding, ruleId: "unsafe", path: "src/a.ts", line: 1, revision, thread: "2" },
					revision,
					secret,
					["1"],
				),
			).toBeUndefined();
			expect(state.resolvedThreads).toEqual([]);
			expect(state.calls.filter(({ method }) => method === "PATCH")).toEqual([]);
		},
	);

	it("resolves its own review's thread without editing a removed finding marker", async () => {
		const { state, provider } = fixture(unknown, true, "Maintainer edited the finding");
		expect(
			await provider.replyResolved(
				7,
				{ id: finding, ruleId: "unsafe", path: "src/a.ts", line: 1, revision, thread: "2" },
				revision,
				secret,
				["1"],
			),
		).toBeUndefined();
		expect(state.resolvedThreads).toEqual([2]);
		expect(state.calls.filter(({ method }) => method === "PATCH")).toEqual([]);
	});
});
