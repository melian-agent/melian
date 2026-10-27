import { MembershipError, type PullRequestRoundHeads } from "@melian-agent/core";
import { Octokit } from "@octokit/rest";
import { GitHubError } from "./errors.ts";
import type { ReviewThreadImporterOptions } from "./threads.ts";

const commitsQuery = `query MelianRoundCommits($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      baseRefOid headRefOid mergeCommit { oid }
      commits(first: 100, after: $after) {
        nodes { commit { oid } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const pushesQuery = `query MelianRoundPushes($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      baseRefOid headRefOid mergeCommit { oid }
      timelineItems(first: 100, after: $after, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
        nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const associatedQuery = `query MelianRoundAssociations($owner: String!, $name: String!, $oid: GitObjectID!, $after: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit {
      associatedPullRequests(first: 100, after: $after) {
        nodes { number repository { name owner { login } } }
        pageInfo { hasNextPage endCursor }
      }
    } }
  }
}`;

type Page = { nodes: Record<string, unknown>[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new GitHubError("failed", "incomplete GitHub membership page");
	return value as Record<string, unknown>;
}
function oid(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
		throw new GitHubError("failed", "invalid GitHub membership commit");
	return value;
}

/** Reads every page of GitHub's commit and force-push history before any membership snapshot is written. */
export class PullRequestRoundsReader {
	private readonly options: ReviewThreadImporterOptions;
	private readonly octokit: Octokit;

	private constructor(options: ReviewThreadImporterOptions) {
		this.options = options;
		this.octokit = new Octokit({
			auth: options.token,
			userAgent: "melian",
			...(options.apiUrl === undefined ? {} : { baseUrl: options.apiUrl }),
			...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
		});
	}
	/** Creates a reader for one repository and pull request; it posts nothing. */
	static open(options: ReviewThreadImporterOptions): PullRequestRoundsReader {
		return new PullRequestRoundsReader(options);
	}
	/** Returns a complete answer, refusing failed, partial or inconsistent pages and GitHub's 250-commit cap. */
	async read(): Promise<PullRequestRoundHeads> {
		const { owner, repo, pullRequest } = this.options;
		let identity: string | undefined;
		let answer: PullRequestRoundHeads | undefined;
		const readPull = (value: unknown): Record<string, unknown> => {
			const pull = object(object(object(value).repository).pullRequest);
			const base = oid(pull.baseRefOid);
			const head = oid(pull.headRefOid);
			const merge = pull.mergeCommit === null ? null : oid(object(pull.mergeCommit).oid);
			const now = JSON.stringify([base, head, merge]);
			if (identity !== undefined && identity !== now)
				throw new GitHubError("failed", "pull request moved while reading membership; refresh again");
			identity = now;
			answer ??= {
				repository: { owner, name: repo },
				number: pullRequest,
				base,
				head,
				merge,
				commits: [],
				forcePushes: [],
				associated: {},
			};
			return pull;
		};
		await this.pages(commitsQuery, {}, (value) => {
			const page = this.page(readPull(value).commits);
			for (const node of page.nodes) answer!.commits.push(oid(object(node.commit).oid));
			if (answer!.commits.length >= 250)
				throw new MembershipError(
					"GitHub caps pull request commits at 250; membership is incomplete; an explicit range --round write remains available",
				);
			return page;
		});
		await this.pages(pushesQuery, {}, (value) => {
			const page = this.page(readPull(value).timelineItems);
			for (const node of page.nodes)
				answer!.forcePushes.push({
					before: node.beforeCommit === null ? null : oid(object(node.beforeCommit).oid),
					after: node.afterCommit === null ? null : oid(object(node.afterCommit).oid),
				});
			return page;
		});
		for (const head of new Set([
			answer!.head,
			...answer!.commits,
			...answer!.forcePushes.flatMap(({ before, after }) =>
				[before, after].filter((each): each is string => each !== null),
			),
		])) {
			answer!.associated[head] = [];
			await this.pages(associatedQuery, { oid: head }, (value) => {
				const commit = object(object(object(value).repository).object);
				const page = this.page(commit.associatedPullRequests);
				for (const node of page.nodes) {
					const repository = object(node.repository);
					if (!Number.isSafeInteger(node.number) || Number(node.number) < 1)
						throw new GitHubError("failed", "invalid associated pull request number");
					const name = repository.name;
					const login = object(repository.owner).login;
					if (typeof name !== "string" || typeof login !== "string")
						throw new GitHubError("failed", "invalid associated pull request repository");
					if (name.toLowerCase() === repo.toLowerCase() && login.toLowerCase() === owner.toLowerCase())
						answer!.associated[head]!.push(Number(node.number));
				}
				return page;
			});
		}
		return answer!;
	}
	private page(value: unknown): Page {
		const page = object(value);
		const info = object(page.pageInfo);
		if (
			!Array.isArray(page.nodes) ||
			typeof info.hasNextPage !== "boolean" ||
			(info.endCursor !== null && typeof info.endCursor !== "string")
		)
			throw new GitHubError("failed", "incomplete GitHub membership connection");
		return { nodes: page.nodes.map(object), pageInfo: { hasNextPage: info.hasNextPage, endCursor: info.endCursor } };
	}
	private async pages(
		query: string,
		variables: Record<string, string>,
		read: (value: unknown) => Page,
	): Promise<void> {
		let after: string | null = null;
		const cursors = new Set<string>();
		for (let count = 0; count < 50; count++) {
			let value: unknown;
			try {
				value = await this.octokit.graphql<unknown>(query, {
					owner: this.options.owner,
					name: this.options.repo,
					number: this.options.pullRequest,
					...variables,
					after,
				});
			} catch {
				throw new GitHubError("failed", "GitHub refused a membership page; no snapshot was refreshed");
			}
			const { pageInfo } = read(value);
			if (!pageInfo.hasNextPage) return;
			if (!pageInfo.endCursor || cursors.has(pageInfo.endCursor))
				throw new GitHubError("failed", "missing or repeated membership cursor");
			cursors.add(pageInfo.endCursor);
			after = pageInfo.endCursor;
		}
		throw new GitHubError("failed", "membership exceeds 50 pages; no snapshot was refreshed");
	}
}
