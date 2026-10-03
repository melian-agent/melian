import type {
	PostedReview,
	PublishedMarkers,
	PullRequest,
	ResolvedFinding,
	ReviewDraft,
	ReviewProvider,
	ReviewStatus,
} from "@melian-agent/core";
import { Octokit } from "@octokit/rest";
import { GitHubError } from "./errors.ts";
import { parseMarker, renderComment, renderResolvedReply, renderReviewBody } from "./publication.ts";

/** The commit status context Melian sets. A check run needs a GitHub App, which a user's token is not. */
export const statusContext = "melian/review";

// GitHub refuses a commit status description longer than this.
const maxDescription = 140;

/** How {@link createGitHubProvider} reaches a repository. */
export interface GitHubProviderOptions {
	readonly owner: string;
	readonly repo: string;
	/** A token with `pull_requests: write` and `statuses: write`, or a classic token with `repo`. Never logged. */
	readonly token: string;
	/** The REST API's address; GitHub's own by default. */
	readonly apiUrl?: string;
	/** The web address links point at; `https://github.com` by default. */
	readonly webUrl?: string;
	/** Replaces `fetch` for every request, so a test can answer them. */
	readonly fetch?: typeof fetch;
}

function statusOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
	return typeof error.status === "number" ? error.status : undefined;
}

// Octokit's error carries the request, whose headers hold the token in redacted form; only the status and GitHub's
// message reach ours.
function failure(what: string, error: unknown): GitHubError {
	const status = statusOf(error);
	const message = error instanceof Error ? error.message : String(error);
	const code = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "notFound" : "failed";
	return new GitHubError(code, `GitHub refused to ${what}: ${status ?? "no response"} ${message}`.trim(), {
		...(status === undefined ? {} : { status }),
	});
}

async function call<T>(what: string, request: () => Promise<T>): Promise<T> {
	try {
		return await request();
	} catch (error) {
		throw failure(what, error);
	}
}

function firstLine(body: string | null | undefined): string {
	return (body ?? "").split(/\r?\n/, 1)[0]!;
}

/**
 * A {@link ReviewProvider} for one GitHub repository, through Octokit.
 *
 * It posts every review with the event `COMMENT`, never `APPROVE` or `REQUEST_CHANGES`: Melian never approves, and the
 * status, not the review, says whether a change may merge. Findings go on the right-hand side of the diff by line.
 * Markers are read back only from posts by the token's own user, so another user cannot forge one to hide a post.
 */
export function createGitHubProvider(options: GitHubProviderOptions): ReviewProvider {
	const { owner, repo } = options;
	const octokit = new Octokit({
		auth: options.token,
		userAgent: "melian",
		...(options.apiUrl === undefined ? {} : { baseUrl: options.apiUrl }),
		...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
	});
	const links = { web: `${options.webUrl ?? "https://github.com"}/${owner}/${repo}` };
	let viewer: Promise<string | undefined> | undefined;
	// An installation token cannot read /user; it then reads every author's markers, which only risks a skipped post.
	const login = () => {
		viewer ??= octokit.rest.users.getAuthenticated().then(
			({ data }) => data.login,
			() => undefined,
		);
		return viewer;
	};
	const ours = async (author: { login: string } | null | undefined) => {
		const me = await login();
		return me === undefined || author?.login === me;
	};

	return {
		name: "github",

		async pullRequest(number) {
			const { data } = await call(`read pull request #${number}`, () =>
				octokit.rest.pulls.get({ owner, repo, pull_number: number }),
			);
			const pullRequest: PullRequest = {
				number: data.number,
				title: data.title,
				url: data.html_url,
				state: data.state === "open" ? "open" : "closed",
				base: { ref: data.base.ref, sha: data.base.sha },
				head: { ref: data.head.ref, sha: data.head.sha },
				fetch: { url: data.base.repo.clone_url, headRef: `refs/pull/${data.number}/head` },
			};
			return pullRequest;
		},

		async postReview(draft: ReviewDraft): Promise<PostedReview> {
			const comments = draft.findings.flatMap((placed) => {
				const { placement, finding } = placed;
				if (placement.kind === "body") return [];
				const range =
					placement.kind === "lines" && placement.startLine < placement.line
						? { start_line: placement.startLine, start_side: "RIGHT" as const }
						: {};
				return [
					{
						path: finding.properties.path,
						line: placement.line,
						side: "RIGHT" as const,
						...range,
						body: renderComment(placed, draft.revision, links),
					},
				];
			});
			const { data: review } = await call(`post a review on pull request #${draft.pullRequest}`, () =>
				octokit.rest.pulls.createReview({
					owner,
					repo,
					pull_number: draft.pullRequest,
					commit_id: draft.revision,
					event: "COMMENT",
					body: renderReviewBody(draft, links),
					comments,
				}),
			);
			const posted = await call(`read review ${review.id}`, () =>
				octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
					owner,
					repo,
					pull_number: draft.pullRequest,
					review_id: review.id,
					per_page: 100,
				}),
			);
			const threads: Record<string, string> = {};
			for (const comment of posted) {
				const found = parseMarker(firstLine(comment.body));
				if (found?.finding !== undefined && found.revision === draft.revision)
					threads[found.finding] = String(comment.id);
			}
			return { id: String(review.id), threads };
		},

		async replyResolved(pullRequest: number, finding: ResolvedFinding & { thread: string }, revision: string) {
			try {
				const { data } = await call(`reply on pull request #${pullRequest}`, () =>
					octokit.rest.pulls.createReplyForReviewComment({
						owner,
						repo,
						pull_number: pullRequest,
						comment_id: Number(finding.thread),
						body: renderResolvedReply(finding, revision),
					}),
				);
				return String(data.id);
			} catch (error) {
				// A deleted comment answers 404, and one on an outdated line can answer 422; either way no thread is left.
				if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) return undefined;
				throw error;
			}
		},

		async setStatus(revision: string, status: ReviewStatus) {
			const description =
				status.description.length <= maxDescription
					? status.description
					: `${status.description.slice(0, maxDescription - 1)}…`;
			await call(`set the status of ${revision}`, () =>
				octokit.rest.repos.createCommitStatus({
					owner,
					repo,
					sha: revision,
					state: status.state,
					description,
					context: statusContext,
				}),
			);
		},

		async findPublished(pullRequest: number, revision: string): Promise<PublishedMarkers> {
			const page = { owner, repo, pull_number: pullRequest, per_page: 100 };
			const [reviews, comments] = await Promise.all([
				call(`list reviews on pull request #${pullRequest}`, () =>
					octokit.paginate(octokit.rest.pulls.listReviews, page),
				),
				call(`list review comments on pull request #${pullRequest}`, () =>
					octokit.paginate(octokit.rest.pulls.listReviewComments, page),
				),
			]);
			let review: string | undefined;
			for (const each of reviews) {
				const opening = parseMarker(firstLine(each.body));
				if (opening?.revision === revision && opening.finding === undefined && (await ours(each.user))) {
					review = String(each.id);
				}
			}
			const threads: Record<string, string> = {};
			const replies: Record<string, string> = {};
			for (const comment of comments) {
				const found = parseMarker(firstLine(comment.body));
				if (found?.revision !== revision || found.finding === undefined || !(await ours(comment.user))) continue;
				// GitHub may send a top-level comment's in_reply_to_id as null rather than leave it out.
				(typeof comment.in_reply_to_id === "number" ? replies : threads)[found.finding] = String(comment.id);
			}
			return { ...(review === undefined ? {} : { review }), threads, replies };
		},
	};
}
