// Spike for issue #374: tries each GitHub call `melian publish` makes, from this session, against a scratch draft pull
// request, and prints a table. Scripts, not product code. Run from the checkout with NODE_USE_ENV_PROXY=1, after pushing
// the scratch branch `melian/spike-374`; the script opens the pull request, and closes it and deletes the branch at the
// end, whatever happened in between.
import { Octokit } from "@octokit/rest";

const owner = "melian-agent";
const repo = "melian";
const head = "melian/spike-374";
const file = "spikes/record-374/scratch.txt";
// Melian resolves GITHUB_TOKEN first; the session's proxy supplies the credential behind it.
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, userAgent: "melian-spike-374" });
const rows = [];

async function attempt(call, kind, what, run) {
	try {
		const result = await run();
		rows.push({ call, kind, what, worked: true, status: result?.status ?? 200 });
		return result;
	} catch (error) {
		const message = String(error?.response?.data?.message ?? error?.message ?? error)
			.split("\n")[0]
			.slice(0, 120);
		rows.push({ call, kind, what, worked: false, status: error?.status ?? "none", message });
		return undefined;
	}
}

let number;
try {
	const created = await attempt("pulls.create", "REST", "open the scratch draft", () =>
		octokit.rest.pulls.create({
			owner,
			repo,
			head,
			base: "main",
			title: "Scratch: publish calls",
			draft: true,
			body: "Scratch pull request for the spike in #374. Closed when the spike ends.",
		}),
	);
	number = created?.data.number;
	if (number === undefined) throw new Error("no scratch pull request");
	const pull = (await octokit.rest.pulls.get({ owner, repo, pull_number: number })).data;
	const sha = pull.head.sha;

	// The reads publish makes before and between its writes.
	await attempt("pulls.get", "REST", "the pull request and its head", () =>
		octokit.rest.pulls.get({ owner, repo, pull_number: number }),
	);
	const me = await attempt("users.getAuthenticated", "REST", "the token's login", () =>
		octokit.rest.users.getAuthenticated(),
	);
	const login = me?.data.login ?? "redbeard";
	await attempt("repos.getCollaboratorPermissionLevel", "REST", "the author's permission", () =>
		octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login }),
	);
	await attempt("repos.listActivities", "REST", "who pushed the head", () =>
		octokit.rest.repos.listActivities({ owner, repo, ref: `refs/heads/${head}`, per_page: 5 }),
	);
	await attempt("repos.getBranchRules", "REST", "the base branch's rules", () =>
		octokit.rest.repos.getBranchRules({ owner, repo, branch: "main" }),
	);
	await attempt("repos.listCommitStatusesForRef", "REST", "the head's statuses, paginated", () =>
		octokit
			.paginate(octokit.rest.repos.listCommitStatusesForRef, { owner, repo, ref: sha, per_page: 100 })
			.then((data) => ({ status: 200, data })),
	);
	await attempt("pulls.listReviews", "REST", "earlier reviews", () =>
		octokit.rest.pulls.listReviews({ owner, repo, pull_number: number }),
	);
	await attempt("pulls.listReviewComments", "REST", "earlier inline comments", () =>
		octokit.rest.pulls.listReviewComments({ owner, repo, pull_number: number }),
	);
	await attempt("issues.listComments", "REST", "the ledger, paginated", () =>
		octokit
			.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 })
			.then((data) => ({ status: 200, data })),
	);
	await attempt("graphql query", "GraphQL", "the review threads and whether each is resolved", () =>
		octokit.graphql(
			"query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 10) { nodes { id isResolved } } } } }",
			{ owner, repo, number },
		),
	);

	// The writes, in publish's order: status, review with an inline comment, the ledger, edits, a reply, a resolution.
	await attempt("repos.createCommitStatus", "REST", "melian/review on the head", () =>
		octokit.rest.repos.createCommitStatus({
			owner,
			repo,
			sha,
			state: "pending",
			context: "spike/publish-calls",
			description: "Scratch status for #374",
		}),
	);
	const review = await attempt("pulls.createReview", "REST", "a review with one inline comment", () =>
		octokit.rest.pulls.createReview({
			owner,
			repo,
			pull_number: number,
			commit_id: sha,
			event: "COMMENT",
			body: "Scratch review for #374.",
			comments: [{ path: file, line: 1, side: "RIGHT", body: "Scratch inline comment for #374." }],
		}),
	);
	await attempt("pulls.createReview (fallback)", "REST", "a review whose inline comment GitHub cannot place", () =>
		octokit.rest.pulls.createReview({
			owner,
			repo,
			pull_number: number,
			commit_id: sha,
			event: "COMMENT",
			body: "Scratch review for #374, placed off the diff.",
			comments: [{ path: file, line: 99, side: "RIGHT", body: "Off the diff." }],
		}),
	);
	if (review !== undefined) {
		await attempt("pulls.getReview", "REST", "the posted review", () =>
			octokit.rest.pulls.getReview({ owner, repo, pull_number: number, review_id: review.data.id }),
		);
		const comments = await attempt("pulls.listCommentsForReview", "REST", "the review's inline comments", () =>
			octokit
				.paginate(octokit.rest.pulls.listCommentsForReview, {
					owner,
					repo,
					pull_number: number,
					review_id: review.data.id,
				})
				.then((data) => ({ status: 200, data })),
		);
		const comment = comments?.data[0];
		if (comment !== undefined) {
			await attempt("pulls.getReviewComment", "REST", "one inline comment", () =>
				octokit.rest.pulls.getReviewComment({ owner, repo, comment_id: comment.id }),
			);
			await attempt("pulls.updateReviewComment", "REST", "edit an addressed finding", () =>
				octokit.rest.pulls.updateReviewComment({
					owner,
					repo,
					comment_id: comment.id,
					body: `${comment.body}\n\nAddressed (scratch).`,
				}),
			);
			await attempt("pulls.createReplyForReviewComment", "REST", "reply with a dismissal's reason", () =>
				octokit.rest.pulls.createReplyForReviewComment({
					owner,
					repo,
					pull_number: number,
					comment_id: comment.id,
					body: "Scratch dismissal reply for #374.",
				}),
			);
			const threads = await octokit
				.graphql(
					"query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 10) { nodes { id } } } } }",
					{ owner, repo, number },
				)
				.catch(() => undefined);
			const thread = threads?.repository.pullRequest.reviewThreads.nodes[0]?.id ?? "PRRT_unknown";
			await attempt("graphql resolveReviewThread", "GraphQL", "resolve an addressed thread", () =>
				octokit.graphql(
					"mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }",
					{ id: thread },
				),
			);
		}
	}
	const ledger = await attempt("issues.createComment", "REST", "create the ledger", () =>
		octokit.rest.issues.createComment({ owner, repo, issue_number: number, body: "Scratch ledger for #374." }),
	);
	if (ledger !== undefined) {
		await attempt("issues.getComment", "REST", "read the recorded ledger", () =>
			octokit.rest.issues.getComment({ owner, repo, comment_id: ledger.data.id }),
		);
		await attempt("issues.updateComment", "REST", "edit the ledger", () =>
			octokit.rest.issues.updateComment({
				owner,
				repo,
				comment_id: ledger.data.id,
				body: "Scratch ledger for #374, edited.",
			}),
		);
	}
	await attempt("repos.createCommitStatus", "REST", "the final status", () =>
		octokit.rest.repos.createCommitStatus({
			owner,
			repo,
			sha,
			state: "success",
			context: "spike/publish-calls",
			description: "Scratch status for #374, final",
		}),
	);
} finally {
	if (number !== undefined)
		await attempt("pulls.update", "REST", "close the scratch pull request", () =>
			octokit.rest.pulls.update({ owner, repo, pull_number: number, state: "closed" }),
		);
	await attempt("git.deleteRef", "REST", "delete the scratch branch", () =>
		octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${head}` }),
	);
	console.log(JSON.stringify({ number, rows }, null, 1));
}
