import {
	type ClosedFinding,
	type LedgerDraft,
	LedgerRefusal,
	type PostedLedger,
	type PostedReview,
	type PublishedMarkers,
	type PullRequest,
	type ReviewDraft,
	type ReviewProvider,
	type ReviewStatus,
	replyKey,
} from "@melian-agent/core";
import { Octokit } from "@octokit/rest";
import { GitHubError } from "./errors.ts";
import { Ledger } from "./ledger.ts";
import {
	type Marker,
	type MarkerKind,
	marker,
	markersIn,
	maxBodyLength,
	parseMarker,
	type RepositoryLinks,
	ReviewComment,
	renderResolvedReply,
	renderReviewBody,
	verifyMarker,
} from "./publication.ts";

/** The commit status context Melian sets. A check run needs a GitHub App, which a user's token is not. */
export const statusContext = "melian/review";

// GitHub refuses a commit status description longer than this.
const maxDescription = 140;

/** How a {@link GitHubProvider} reaches a repository. */
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

// The marker opening `body`, when it is of `kind`, names `revision`, and `secret` signed it.
function signedMarker(
	body: string | null | undefined,
	kind: MarkerKind,
	revision: string,
	secret: string,
): Marker | undefined {
	const found = parseMarker(firstLine(body));
	if (found === undefined || found.kind !== kind || found.revision !== revision) return undefined;
	return verifyMarker(found, secret) ? found : undefined;
}

/**
 * A {@link ReviewProvider} for one GitHub repository, through Octokit.
 *
 * It posts every review with the event `COMMENT`, never `APPROVE` or `REQUEST_CHANGES`: Melian never approves, and the
 * status, not the review, says whether a change may merge. Findings go on the right-hand side of the diff by line.
 * A marker counts only when the changeset's publisher secret signed it, whoever posted it. When the provider knows the
 * token's own user, a marker on anyone else's post does not count either.
 */
export class GitHubProvider implements ReviewProvider {
	readonly name = "github";
	readonly owner: string;
	readonly repo: string;
	private readonly octokit: Octokit;
	private readonly links: RepositoryLinks;
	// Who Melian posts as: from /user, or from the author of a review it posted. /user is asked once per provider, its
	// failure remembered too: an installation token always fails it, and asking again for every marker cost one request
	// each. A review posted later still teaches the viewer.
	private viewer: string | undefined;
	private asked: Promise<void> | undefined;
	private threads: Promise<Map<string, { id: string; isResolved: boolean }>> | undefined;

	constructor(options: GitHubProviderOptions) {
		this.owner = options.owner;
		this.repo = options.repo;
		this.octokit = new Octokit({
			auth: options.token,
			userAgent: "melian",
			...(options.apiUrl === undefined ? {} : { baseUrl: options.apiUrl }),
			...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
		});
		this.links = { web: `${options.webUrl ?? "https://github.com"}/${options.owner}/${options.repo}` };
	}

	beginPublish(): void {
		this.threads = undefined;
	}

	async pullRequest(number: number): Promise<PullRequest> {
		const { data } = await call(`read pull request #${number}`, () =>
			this.octokit.rest.pulls.get({ owner: this.owner, repo: this.repo, pull_number: number }),
		);
		return {
			repository: { owner: data.base.repo.owner.login, name: data.base.repo.name },
			number: data.number,
			title: data.title,
			url: data.html_url,
			state: data.state === "open" ? "open" : "closed",
			base: { ref: data.base.ref, sha: data.base.sha },
			head: { ref: data.head.ref, sha: data.head.sha },
			fetch: { url: data.base.repo.clone_url, headRef: `refs/pull/${data.number}/head` },
		};
	}

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
					body: ReviewComment.from(placed.finding, placed.placement).render({
						revision: draft.revision,
						base: draft.base,
						links: this.links,
						secret: draft.secret,
					}),
				},
			];
		});
		const create = (body: string, inline: typeof comments) =>
			call(`post a review on pull request #${draft.pullRequest}`, () =>
				this.octokit.rest.pulls.createReview({
					owner: this.owner,
					repo: this.repo,
					pull_number: draft.pullRequest,
					commit_id: draft.revision,
					event: "COMMENT",
					body,
					comments: inline,
				}),
			);
		let created: Awaited<ReturnType<typeof create>>;
		try {
			created = await create(renderReviewBody(draft, this.links), comments);
		} catch (error) {
			// GitHub refuses the whole review with a 422 when it cannot place one comment, such as on a line an
			// outdated diff no longer has. Every finding then goes in the body, which has no line to refuse.
			if (!(error instanceof GitHubError && error.status === 422 && comments.length > 0)) throw error;
			const findings = draft.findings.map((placed) => ({ ...placed, placement: { kind: "body" as const } }));
			created = await create(renderReviewBody({ ...draft, findings }, this.links, { inlineRefused: true }), []);
		}
		const review = created.data;
		this.viewer ??= review.user?.login;
		const posted = await call(`read review ${review.id}`, () =>
			this.octokit.paginate(this.octokit.rest.pulls.listCommentsForReview, {
				owner: this.owner,
				repo: this.repo,
				pull_number: draft.pullRequest,
				review_id: review.id,
				per_page: 100,
			}),
		);
		const threads: Record<string, string> = {};
		for (const comment of posted) {
			const found = signedMarker(comment.body, "finding", draft.revision, draft.secret);
			if (found !== undefined) threads[found.id] = String(comment.id);
		}
		return { id: String(review.id), threads };
	}

	async replyResolved(
		pullRequest: number,
		finding: ClosedFinding & { thread: string },
		revision: string,
		secret: string,
	): Promise<string | undefined> {
		try {
			if (finding.dismissal === undefined) return await this.address(pullRequest, finding, revision, secret);
			const { data } = await call(`reply on pull request #${pullRequest}`, () =>
				this.octokit.rest.pulls.createReplyForReviewComment({
					owner: this.owner,
					repo: this.repo,
					pull_number: pullRequest,
					comment_id: Number(finding.thread),
					body: renderResolvedReply(finding, revision, secret),
				}),
			);
			return String(data.id);
		} catch (error) {
			// A deleted comment answers 404, and one on an outdated line can answer 422; either way no thread is left.
			if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) return undefined;
			throw error;
		}
	}

	async findLedger(
		pullRequest: number,
		secret: string,
		recorded?: PostedLedger,
		review?: string,
	): Promise<PostedLedger | undefined> {
		const login = await this.login();
		if (recorded !== undefined) {
			const comment = await this.recordedLedger(recorded);
			// A 404 means the recorded comment is gone; a ledger created since may not be recorded yet, so scan for it.
			if (comment !== undefined) {
				const author = login ?? recorded.author;
				if (
					author === undefined ||
					comment.user?.login !== author ||
					(recorded.author !== undefined && comment.user?.login !== recorded.author)
				)
					throw new LedgerRefusal(
						"foreignPublisher",
						"the recorded ledger belongs to another publisher or its author is unknown; restore the publisher before editing it",
					);
				return this.readLedger(comment, secret);
			}
		}
		let author = login ?? recorded?.author;
		if (author === undefined && review !== undefined) {
			const { data } = await call("read the publisher's review", () =>
				this.octokit.rest.pulls.getReview({
					owner: this.owner,
					repo: this.repo,
					pull_number: pullRequest,
					review_id: Number(review),
				}),
			);
			author = data.user?.login;
		}
		if (author === undefined) return undefined;
		const comments = await call(`list ledger comments on pull request #${pullRequest}`, () =>
			this.octokit.paginate(this.octokit.rest.issues.listComments, {
				owner: this.owner,
				repo: this.repo,
				issue_number: pullRequest,
				per_page: 100,
			}),
		);
		const candidates = comments
			.filter(
				(comment) =>
					/^<!-- melian:revision=.* ledger=/.test(firstLine(comment.body)) && comment.user?.login === author,
			)
			.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
		const signed = candidates.find((comment) => {
			const found = parseMarker(firstLine(comment.body));
			return found?.kind === "ledger" && verifyMarker(found, secret);
		});
		const chosen = signed ?? candidates[0];
		if (chosen !== undefined) return this.readLedger(chosen, secret);
		return undefined;
	}

	private async recordedLedger(recorded: PostedLedger) {
		try {
			return (
				await call("read the recorded ledger comment", () =>
					this.octokit.rest.issues.getComment({
						owner: this.owner,
						repo: this.repo,
						comment_id: Number(recorded.id),
					}),
				)
			).data;
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return undefined;
			throw error;
		}
	}

	private readLedger(
		comment: { id: number; html_url: string; body?: string; user: { login: string } | null },
		secret: string,
	): PostedLedger {
		const body = comment.body ?? "";
		const found = parseMarker(firstLine(body));
		if (found?.kind !== "ledger" || !verifyMarker(found, secret))
			throw new LedgerRefusal(
				"unverifiable",
				"the pull request has a ledger Melian cannot verify; restore the changeset's storage, or delete the orphaned ledger comment by hand before publishing again",
			);
		const stamp = Ledger.readStamp(body);
		if (stamp === undefined)
			throw new LedgerRefusal(
				"damaged",
				"the signed ledger's stamp or visible body is missing or damaged; delete the ledger comment by hand before publishing again",
			);
		return { id: String(comment.id), url: comment.html_url, stamp, author: comment.user!.login };
	}

	async writeLedger(draft: LedgerDraft): Promise<PostedLedger> {
		const ledger = Ledger.from(draft.verdict, draft.publication, draft);
		const body = ledger.render(this.links);
		const existing = await this.findLedger(draft.pullRequest, draft.secret, draft.recorded, draft.review);
		if (existing !== undefined && !ledger.diff(existing.stamp)) return existing;
		const { data } =
			existing === undefined
				? await call("create the review ledger", () =>
						this.octokit.rest.issues.createComment({
							owner: this.owner,
							repo: this.repo,
							issue_number: draft.pullRequest,
							body,
						}),
					)
				: await call("edit the review ledger", () =>
						this.octokit.rest.issues.updateComment({
							owner: this.owner,
							repo: this.repo,
							comment_id: Number(existing.id),
							body,
						}),
					);
		return {
			id: String(data.id),
			url: data.html_url,
			stamp: ledger.stamp,
			...(data.user?.login === undefined ? {} : { author: data.user.login }),
		};
	}

	private async address(
		pullRequest: number,
		finding: ClosedFinding & { thread: string },
		revision: string,
		secret: string,
	): Promise<string | undefined> {
		const { data } = await call("read the finding to address", () =>
			this.octokit.rest.pulls.getReviewComment({
				owner: this.owner,
				repo: this.repo,
				comment_id: Number(finding.thread),
			}),
		);
		const opening = signedMarker(data.body, "finding", finding.revision, secret);
		const editable = opening?.id === finding.id && (await this.ours(data.user));
		const closed = marker(finding.addressedIn ?? revision, "resolved", finding.id, secret);
		if (editable && !data.body.split(/\r?\n/).includes(closed)) {
			const suffix = `\n\nAddressed in commit ${(finding.addressedIn ?? revision).slice(0, 12)}.\n${closed}`;
			await call("edit the addressed finding", () =>
				this.octokit.rest.pulls.updateReviewComment({
					owner: this.owner,
					repo: this.repo,
					comment_id: Number(finding.thread),
					body: data.body.slice(0, maxBodyLength - suffix.length) + suffix,
				}),
			);
		}
		const resolved = await this.resolveThread(pullRequest, finding.thread);
		return editable && resolved ? finding.thread : undefined;
	}

	async resolveThread(pullRequest: number, comment: string): Promise<boolean> {
		this.threads ??= this.readThreads(pullRequest);
		const thread = (await this.threads).get(comment);
		if (thread === undefined) return false;
		if (!thread.isResolved) {
			await call("resolve the addressed finding's thread", () =>
				this.octokit.graphql(
					`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`,
					{ id: thread.id },
				),
			);
			thread.isResolved = true;
		}
		return true;
	}

	private async readThreads(pullRequest: number): Promise<Map<string, { id: string; isResolved: boolean }>> {
		const threads = new Map<string, { id: string; isResolved: boolean }>();
		let cursor: string | null = null;
		do {
			const response: {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: { id: string; isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[];
							pageInfo: { hasNextPage: boolean; endCursor: string | null };
						};
					};
				};
			} = await call("read finding threads", () =>
				this.octokit.graphql(
					`query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) {
     nodes { id isResolved comments(first: 1) { nodes { databaseId } } } pageInfo { hasNextPage endCursor }
    } } }
   }`,
					{ owner: this.owner, repo: this.repo, number: pullRequest, cursor },
				),
			);
			const page = response.repository.pullRequest.reviewThreads;
			for (const node of page.nodes) {
				for (const comment of node.comments.nodes)
					threads.set(String(comment.databaseId), { id: node.id, isResolved: node.isResolved });
			}
			cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
		} while (cursor !== null);
		return threads;
	}

	async getStatus(revision: string): Promise<{ readonly state: string; readonly targetUrl?: string } | undefined> {
		const statuses = await call(`read the status of ${revision}`, () =>
			this.octokit.paginate(this.octokit.rest.repos.listCommitStatusesForRef, {
				owner: this.owner,
				repo: this.repo,
				ref: revision,
				per_page: 100,
			}),
		);
		const status = statuses.find((each) => each.context === statusContext);
		return status === undefined
			? undefined
			: { state: status.state, ...(status.target_url === null ? {} : { targetUrl: status.target_url }) };
	}

	async setStatus(revision: string, status: ReviewStatus, ledgerUrl?: string): Promise<void> {
		const description =
			status.description.length <= maxDescription
				? status.description
				: `${status.description.slice(0, maxDescription - 1)}…`;
		await call(`set the status of ${revision}`, () =>
			this.octokit.rest.repos.createCommitStatus({
				owner: this.owner,
				repo: this.repo,
				sha: revision,
				state: status.state,
				description,
				context: statusContext,
				...(ledgerUrl === undefined ? {} : { target_url: ledgerUrl }),
			}),
		);
	}

	async findPublished(
		pullRequest: number,
		revision: string,
		wanted: { readonly fingerprint: string; readonly round: number },
		secret: string,
	): Promise<PublishedMarkers> {
		const page = { owner: this.owner, repo: this.repo, pull_number: pullRequest, per_page: 100 };
		const [reviews, comments] = await Promise.all([
			call(`list reviews on pull request #${pullRequest}`, () =>
				this.octokit.paginate(this.octokit.rest.pulls.listReviews, page),
			),
			call(`list review comments on pull request #${pullRequest}`, () =>
				this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, page),
			),
		]);
		// The first post carrying a marker is Melian's: anyone can copy a signed marker, but only after Melian posted it.
		let review: string | undefined;
		for (const each of reviews) {
			const opening = signedMarker(each.body, "verdict", revision, secret);
			// The round as well as the verdict: a verdict that recurs at a head must not find its earlier review.
			if (opening?.id === wanted.fingerprint && opening.round === wanted.round && (await this.ours(each.user))) {
				review = String(each.id);
				break;
			}
		}
		const threads: Record<string, string> = {};
		const replies: Record<string, string> = {};
		for (const comment of comments) {
			// GitHub may send a top-level comment's in_reply_to_id as null rather than leave it out.
			for (const resolved of markersIn(comment.body).filter(
				(found) => found.kind === "resolved" && found.revision === revision,
			)) {
				if (verifyMarker(resolved, secret) && (await this.ours(comment.user)))
					replies[replyKey(resolved.id, String(comment.in_reply_to_id ?? comment.id), resolved.dismissal)] ??=
						String(comment.id);
			}
			const thread = comment.in_reply_to_id;
			const reply = typeof thread === "number";
			const found = signedMarker(comment.body, reply ? "resolved" : "finding", revision, secret);
			if (found === undefined || !(await this.ours(comment.user))) continue;
			if (reply) replies[replyKey(found.id, String(thread), found.dismissal)] ??= String(comment.id);
			else threads[found.id] ??= String(comment.id);
		}
		return { ...(review === undefined ? {} : { review }), threads, replies };
	}

	private async login(): Promise<string | undefined> {
		this.asked ??= this.octokit.rest.users.getAuthenticated().then(
			({ data }) => {
				this.viewer ??= data.login;
			},
			() => {},
		);
		await this.asked;
		return this.viewer;
	}

	// A filter, never the proof: the signature is. An installation token cannot read /user, and a crash between a post
	// and its record must still find the post.
	private async ours(author: { login: string } | null | undefined): Promise<boolean> {
		const me = await this.login();
		return me === undefined || author?.login === me;
	}
}

/** Creates a {@link GitHubProvider}, as `new GitHubProvider(options)` does. */
export function createGitHubProvider(options: GitHubProviderOptions): GitHubProvider {
	return new GitHubProvider(options);
}
