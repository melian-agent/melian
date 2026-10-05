import { ExternalFinding, type ExternalImport, type ExternalImporter, type ExternalReviewer } from "@melian-agent/core";
import { Octokit } from "@octokit/rest";
import { GitHubError } from "./errors.ts";

/** The login CodeRabbit posts as, which Melian imports by default. */
export const coderabbitLogin = "coderabbitai[bot]";

// GraphQL pages hold at most 100 nodes; past this many pages the importer stops rather than loop on a cursor.
const maxPages = 50;

const threadsQuery = `query MelianReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          startLine
          originalLine
          originalStartLine
          diffSide
          startDiffSide
          subjectType
          comments(first: 1) {
            nodes { url body createdAt originalCommit { oid } author { __typename login } }
          }
        }
      }
    }
  }
}`;

const reviewsQuery = `query MelianReviews($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { body author { __typename login } }
      }
    }
  }
}`;

type Author = { __typename?: string; login: string } | null;
type PageInfo = { hasNextPage: boolean; endCursor: string | null };

type ThreadNode = {
	id: string;
	isResolved: boolean;
	path: string;
	line: number | null;
	startLine: number | null;
	originalLine: number | null;
	originalStartLine: number | null;
	diffSide: "LEFT" | "RIGHT";
	startDiffSide: "LEFT" | "RIGHT" | null;
	subjectType?: "LINE" | "FILE";
	comments: {
		nodes: {
			url: string;
			body: string;
			createdAt: string;
			originalCommit: { oid: string } | null;
			author: Author;
		}[];
	};
};

type ThreadsPage = {
	repository: {
		pullRequest: { headRefOid: string; reviewThreads: { pageInfo: PageInfo; nodes: ThreadNode[] } } | null;
	} | null;
};

type ReviewsPage = {
	repository: {
		pullRequest: { reviews: { pageInfo: PageInfo; nodes: { body: string; author: Author }[] } } | null;
	} | null;
};

/** How a {@link ReviewThreadImporter} reaches a pull request, and whose threads it imports. */
export interface ReviewThreadImporterOptions {
	readonly owner: string;
	readonly repo: string;
	readonly pullRequest: number;
	/** The author login whose threads to import, as REST spells it; {@link coderabbitLogin} by default. */
	readonly login?: string;
	/** A token that can read the repository's pull requests. Never logged. */
	readonly token: string;
	/** The REST API's address, from which the GraphQL endpoint follows; GitHub's own by default. */
	readonly apiUrl?: string;
	/** Replaces `fetch` for every request, so a test can answer them. */
	readonly fetch?: typeof fetch;
}

// GraphQL names a bot by its bare login, `coderabbitai`, where REST and the web say `coderabbitai[bot]`. A bot's
// comment is the login's under either spelling; a user's only under its own, so a bot's name never matches a person.
// Logins are case-insensitive.
function wrote(author: Author, login: string): boolean {
	if (author === null) return false;
	const wanted = login.toLowerCase();
	const own = author.login.toLowerCase();
	if (author.__typename !== "Bot") return own === wanted;
	return own.replace(/\[bot\]$/, "") === wanted.replace(/\[bot\]$/, "");
}

// The bots Melian names, by bare login.
const botNames: Readonly<Record<string, ExternalReviewer["name"]>> = {
	coderabbitai: "coderabbit",
	"copilot-pull-request-reviewer": "copilot",
};

// The reviewer an author is: CodeRabbit's and Copilot's bots by name, and anyone else a human kept by login, as REST
// spells it.
function reviewerOf(author: NonNullable<Author>): ExternalReviewer {
	const bot = author.__typename === "Bot";
	const bare = author.login.replace(/\[bot\]$/i, "");
	const login = bot ? `${bare}[bot]` : author.login;
	const kind = bot ? "bot" : "user";
	const key = bare.toLowerCase();
	const named = bot && Object.hasOwn(botNames, key) ? botNames[key] : undefined;
	return { name: named ?? "human", login, kind };
}

function statusOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
	return typeof error.status === "number" ? error.status : undefined;
}

/**
 * Imports a pull request's review threads through GitHub's GraphQL API, keeping each thread whose first comment one
 * login wrote: CodeRabbit's by default. REST's comment list carries no thread state, and a resolved thread is how
 * CodeRabbit marks a finding fixed. A thread's lines are GitHub's placement at the pull request's head, or its original
 * lines, marked outdated, when GitHub no longer places it. Review bodies have no thread; it counts that login's and
 * skips them, never parsing their markdown.
 */
export class ReviewThreadImporter implements ExternalImporter {
	/** `github:` and the login. */
	readonly source: string;
	private readonly octokit: Octokit;
	private readonly owner: string;
	private readonly repo: string;
	private readonly pullRequest: number;
	private readonly login: string;

	private constructor(options: ReviewThreadImporterOptions & { readonly login: string }) {
		this.owner = options.owner;
		this.repo = options.repo;
		this.pullRequest = options.pullRequest;
		this.login = options.login;
		this.source = `github:${options.login}`;
		this.octokit = new Octokit({
			auth: options.token,
			userAgent: "melian",
			...(options.apiUrl === undefined ? {} : { baseUrl: options.apiUrl }),
			...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
		});
	}

	/**
	 * An importer for one pull request's threads by `options.login`. Any login other than CodeRabbit's names a `human`
	 * reviewer, kept by login. Throws {@link GitHubError} `failed` for a login GitHub could not hold.
	 */
	static open(options: ReviewThreadImporterOptions): ReviewThreadImporter {
		const login = options.login ?? coderabbitLogin;
		if (!/^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/.test(login)) {
			throw new GitHubError("failed", `${JSON.stringify(login)} is not a GitHub login`);
		}
		return new ReviewThreadImporter({ ...options, login });
	}

	/**
	 * Reads every review thread and review of the pull request, and returns the login's threads as external findings,
	 * how many of its review bodies it skipped, and the head GitHub placed the threads at. Throws {@link GitHubError}
	 * when GitHub refuses or the pull request does not exist.
	 */
	async import(): Promise<ExternalImport & { readonly head: string }> {
		let head: string | undefined;
		const findings: ExternalFinding[] = [];
		await this.pages<ThreadsPage>(threadsQuery, (page) => {
			const pullRequest = this.found(page.repository?.pullRequest);
			if (head !== undefined && head !== pullRequest.headRefOid) {
				throw new GitHubError(
					"failed",
					`pull request #${this.pullRequest} in ${this.owner}/${this.repo} moved while reading review threads; run compare again`,
				);
			}
			head ??= pullRequest.headRefOid;
			for (const thread of pullRequest.reviewThreads.nodes) {
				const [first] = thread.comments.nodes;
				if (first !== undefined && wrote(first.author, this.login)) findings.push(this.finding(thread, first));
			}
			return pullRequest.reviewThreads.pageInfo;
		});
		let skippedBodies = 0;
		await this.pages<ReviewsPage>(reviewsQuery, (page) => {
			const { reviews } = this.found(page.repository?.pullRequest);
			for (const review of reviews.nodes) {
				if (wrote(review.author, this.login) && review.body.trim() !== "") skippedBodies++;
			}
			return reviews.pageInfo;
		});
		return { findings, skippedBodies, head: head! };
	}

	private finding(thread: ThreadNode, comment: ThreadNode["comments"]["nodes"][number]): ExternalFinding {
		// A file-level thread has no line; a thread GitHub no longer places keeps its original lines, marked outdated.
		const placed = thread.line !== null;
		const end = thread.subjectType === "FILE" ? null : placed ? thread.line : thread.originalLine;
		// A start on the other side of the diff from the end names lines of the other file, so the end stands alone.
		const sameSide = thread.startDiffSide === null || thread.startDiffSide === thread.diffSide;
		const start = !sameSide ? null : placed ? thread.startLine : thread.originalStartLine;
		const reviewer = reviewerOf(comment.author!);
		// CodeRabbit opens with a line naming its category and severity, then its headline on the next line that is not
		// blank. Melian selects the lines and parses no markdown.
		const lines = comment.body.split(/\r?\n/).filter((each) => each.trim() !== "");
		const rabbit = reviewer.name === "coderabbit" && lines.length > 1;
		const title = rabbit ? lines[1]! : comment.body.trim() === "" ? "(empty comment)" : comment.body;
		return ExternalFinding.create({
			reviewer,
			file: thread.path,
			...(end === null ? {} : { line: Math.min(start ?? end, end), endLine: end }),
			...(thread.diffSide === "LEFT" ? { revision: "base" as const } : {}),
			...(end !== null && !placed ? { outdated: true } : {}),
			title,
			body: comment.body,
			...(rabbit ? { severity: [...lines[0]!.trim()].slice(0, 100).join("") } : {}),
			source: {
				kind: "thread",
				thread: thread.id,
				url: comment.url,
			},
			postedAt: comment.createdAt,
			...(comment.originalCommit === null ? {} : { commit: comment.originalCommit.oid }),
			resolved: thread.isResolved,
		});
	}

	private found<T>(pullRequest: T | null | undefined): T {
		if (pullRequest === null || pullRequest === undefined) {
			throw new GitHubError(
				"notFound",
				`GitHub has no pull request #${this.pullRequest} in ${this.owner}/${this.repo}`,
			);
		}
		return pullRequest;
	}

	// Runs `query` page by page until GitHub says there is no next page.
	private async pages<T>(query: string, read: (page: T) => PageInfo): Promise<void> {
		let after: string | null = null;
		for (let count = 0; count < maxPages; count++) {
			let page: T;
			try {
				page = await this.octokit.graphql<T>(query, {
					owner: this.owner,
					name: this.repo,
					number: this.pullRequest,
					after,
				});
			} catch (error) {
				// Octokit's error carries the request, whose headers hold the token in redacted form; only the status and
				// GitHub's message reach ours.
				const status = statusOf(error);
				const message = error instanceof Error ? error.message : String(error);
				const code =
					status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "notFound" : "failed";
				throw new GitHubError(
					code,
					`GitHub refused to read the review threads of pull request #${this.pullRequest}: ${status ?? ""} ${message}`.replace(
						/ {2,}/g,
						" ",
					),
					status === undefined ? {} : { status },
				);
			}
			const info = read(page);
			if (!info.hasNextPage || info.endCursor === null) return;
			after = info.endCursor;
		}
		throw new GitHubError(
			"failed",
			`pull request #${this.pullRequest} has more than ${maxPages * 100} threads or reviews`,
		);
	}
}
