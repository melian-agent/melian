// A GitHub REST API in memory, answering Octokit through its fetch option. It records every call, refuses an inline
// comment outside the diff as GitHub does, and can persist its state so a crashed process's posts outlive it.
import type { DiffLines } from "@melian-agent/core";

export type Call = { method: string; path: string; body?: unknown };

type User = { login: string };

export type FakeReview = { id: number; user: User; body: string; commit_id: string; event: string };

export type FakeComment = {
	id: number;
	user: User;
	body: string;
	path: string;
	line: number;
	side: string;
	start_line?: number;
	start_side?: string;
	in_reply_to_id?: number;
	pull_request_review_id: number;
};

export type FakeStatus = { sha: string; state: string; description: string; context: string; target_url?: string };

export type FakeState = {
	owner: string;
	repo: string;
	login: string;
	pull: { number: number; title: string; base: { ref: string; sha: string }; head: { ref: string; sha: string } };
	// The lines the pull request's diff adds, which alone take an inline comment.
	lines: DiffLines;
	reviews: FakeReview[];
	comments: FakeComment[];
	ledgers: { id: number; user: User; body: string; html_url: string }[];
	resolvedThreads: number[];
	statuses: FakeStatus[];
	nextId: number;
	// Set to make every review fail, as GitHub does when it has an outage.
	failReviews?: boolean;
	// Set to make every reply fail, as GitHub does when it has an outage.
	failReplies?: boolean;
	// Set to make every ledger write fail, as GitHub does when it has an outage.
	failLedger?: boolean;
	// Set to make /user refuse, as it does for an installation token.
	failUser?: boolean;
	calls: Call[];
};

export function fakeState(owner: string, repo: string, pull: FakeState["pull"], lines: DiffLines): FakeState {
	return {
		owner,
		repo,
		login: "melian-user",
		pull,
		lines,
		reviews: [],
		comments: [],
		ledgers: [],
		resolvedThreads: [],
		statuses: [],
		nextId: 1000,
		calls: [],
	};
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function inDiff(lines: DiffLines, path: string, line: number): boolean {
	return (Object.hasOwn(lines, path) ? lines[path]! : []).some(([first, last]) => first <= line && line <= last);
}

type ReviewComment = {
	path: string;
	line: number;
	side: string;
	start_line?: number;
	start_side?: string;
	body: string;
};

// A fetch that answers the routes Melian calls. `afterWrite` runs after each write is applied and before its response
// returns, so a crash fixture can persist the state and park there; `beforeWrite` runs before a write is applied, so
// one can park before GitHub has anything.
export function fakeGitHub(
	state: FakeState,
	afterWrite: (call: Call) => Promise<void> | void = () => {},
	beforeWrite: (call: Call) => Promise<void> | void = () => {},
): typeof fetch {
	const repoPath = `/repos/${state.owner}/${state.repo}`;
	const pull = () => ({
		number: state.pull.number,
		title: state.pull.title,
		state: "open",
		html_url: `https://github.com/${state.owner}/${state.repo}/pull/${state.pull.number}`,
		base: {
			ref: state.pull.base.ref,
			sha: state.pull.base.sha,
			repo: {
				clone_url: `https://github.com/${state.owner}/${state.repo}.git`,
				name: state.repo,
				owner: { login: state.owner },
			},
		},
		head: { ref: state.pull.head.ref, sha: state.pull.head.sha },
	});
	return async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
		const call: Call = { method, path: url.pathname, ...(body === undefined ? {} : { body }) };
		state.calls.push(call);
		const path = url.pathname;
		const user = { login: state.login };
		if (method === "POST" || method === "PATCH") await beforeWrite(call);
		if (method === "POST" && path === "/graphql") {
			const query = body as { query: string; variables: { id?: string } };
			if (query.query.includes("resolveReviewThread")) {
				const id = Number(query.variables.id);
				if (state.failReplies) return json({ message: "Server Error" }, 500);
				state.resolvedThreads.push(id);
				await afterWrite(call);
				return json({ data: { resolveReviewThread: { thread: { id: String(id), isResolved: true } } } });
			}
			return json({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: state.comments
									.filter((comment) => comment.in_reply_to_id === undefined)
									.map((comment) => ({
										id: String(comment.id),
										isResolved: state.resolvedThreads.includes(comment.id),
										comments: { nodes: [{ databaseId: comment.id }] },
									})),
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
				},
			});
		}
		const issues = `${repoPath}/issues/${state.pull.number}/comments`;
		if (method === "GET" && path === issues) return json(state.ledgers);
		if (method === "POST" && path === issues) {
			if (state.failLedger) return json({ message: "Server Error" }, 500);
			const id = state.nextId++;
			const comment = {
				id,
				user,
				body: (body as { body: string }).body,
				html_url: `https://github.com/${state.owner}/${state.repo}/pull/${state.pull.number}#issuecomment-${id}`,
			};
			state.ledgers.push(comment);
			await afterWrite(call);
			return json(comment, 201);
		}
		const ledgerId = new RegExp(`^${repoPath}/issues/comments/(\\d+)$`).exec(path);
		if ((method === "GET" || method === "PATCH") && ledgerId !== null) {
			const comment = state.ledgers.find((each) => each.id === Number(ledgerId[1]));
			if (comment === undefined) return json({ message: "Not Found" }, 404);
			if (method === "PATCH") {
				comment.body = (body as { body: string }).body;
				await afterWrite(call);
			}
			return json(comment);
		}
		const commentId = new RegExp(`^${repoPath}/pulls/comments/(\\d+)$`).exec(path);
		if ((method === "GET" || method === "PATCH") && commentId !== null) {
			const comment = state.comments.find((each) => each.id === Number(commentId[1]));
			if (comment === undefined) return json({ message: "Not Found" }, 404);
			if (method === "PATCH") {
				if (state.failReplies) return json({ message: "Server Error" }, 500);
				comment.body = (body as { body: string }).body;
				await afterWrite(call);
			}
			return json(comment);
		}
		const pulls = `${repoPath}/pulls/${state.pull.number}`;
		if (method === "GET" && path === "/user")
			return state.failUser ? json({ message: "Forbidden" }, 403) : json(user);
		if (method === "GET" && path === pulls) return json(pull());
		if (method === "GET" && path === `${pulls}/reviews`) return json(state.reviews);
		if (method === "GET" && path === `${pulls}/comments`) return json(state.comments);
		const forReview = new RegExp(`^${pulls}/reviews/(\\d+)/comments$`).exec(path);
		if (method === "GET" && forReview !== null) {
			return json(state.comments.filter((comment) => comment.pull_request_review_id === Number(forReview[1])));
		}
		if (method === "POST" && path === `${pulls}/reviews`) {
			if (state.failReviews) return json({ message: "Server Error" }, 500);
			const draft = body as { commit_id: string; event: string; body: string; comments: ReviewComment[] };
			for (const comment of draft.comments) {
				if (!inDiff(state.lines, comment.path, comment.line) || comment.side !== "RIGHT")
					return json({ message: "Unprocessable Entity", errors: ["Line could not be resolved"] }, 422);
			}
			const review: FakeReview = {
				id: state.nextId++,
				user,
				body: draft.body,
				commit_id: draft.commit_id,
				event: draft.event,
			};
			state.reviews.push(review);
			for (const comment of draft.comments) {
				state.comments.push({ ...comment, id: state.nextId++, user, pull_request_review_id: review.id });
			}
			await afterWrite(call);
			return json({ ...review, state: "COMMENTED" });
		}
		const reply = new RegExp(`^${pulls}/comments/(\\d+)/replies$`).exec(path);
		if (method === "POST" && reply !== null) {
			if (state.failReplies) return json({ message: "Server Error" }, 500);
			const parent = state.comments.find((comment) => comment.id === Number(reply[1]));
			if (parent === undefined) return json({ message: "Not Found" }, 404);
			const created: FakeComment = {
				...parent,
				id: state.nextId++,
				body: (body as { body: string }).body,
				in_reply_to_id: parent.id,
			};
			state.comments.push(created);
			await afterWrite(call);
			return json(created, 201);
		}
		const status = new RegExp(`^${repoPath}/statuses/([0-9a-f]+)$`).exec(path);
		if (method === "POST" && status !== null) {
			const posted = body as Omit<FakeStatus, "sha">;
			state.statuses.push({ sha: status[1]!, ...posted });
			await afterWrite(call);
			return json({ id: state.nextId++, ...posted }, 201);
		}
		return json({ message: `no fake route for ${method} ${path}` }, 404);
	};
}

export function posts(state: FakeState): Call[] {
	return state.calls.filter((call) => call.method === "POST");
}
