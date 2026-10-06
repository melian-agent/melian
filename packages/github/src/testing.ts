/**
 * Test helpers, published as `@melian-agent/github/testing`. The CLI's scripted mode reads GitHub through them, so a
 * test can run `melian` end to end without the network.
 *
 * @module
 */

/**
 * GitHub's answers, recorded or written by hand: the REST pull request `GET /repos/{owner}/{repo}/pulls/{number}`
 * returns, and each GraphQL operation's pages in order, keyed by operation name, such as `MelianReviewThreads`.
 */
export interface GitHubRecording {
	readonly owner: string;
	readonly repo: string;
	readonly pullRequest?: { readonly number: number } & Record<string, unknown>;
	readonly graphql?: Readonly<Record<string, readonly unknown[]>>;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function endCursor(value: unknown): string | null | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if ("pageInfo" in value && typeof value.pageInfo === "object" && value.pageInfo !== null) {
		const cursor = (value.pageInfo as { endCursor?: unknown }).endCursor;
		return typeof cursor === "string" ? cursor : null;
	}
	for (const each of Object.values(value)) {
		const found = endCursor(each);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * A `fetch` that answers from `recording` and never reaches the network. A GraphQL request gets the page of its
 * operation that follows the page whose end cursor it names as `after`, or the first page without one. Anything it was
 * not given answers 404, as GitHub does for what does not exist.
 */
export function recordedGitHub(recording: GitHubRecording): typeof fetch {
	return async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		const { pullRequest } = recording;
		if (
			method === "GET" &&
			pullRequest !== undefined &&
			url.pathname === `/repos/${recording.owner}/${recording.repo}/pulls/${pullRequest.number}`
		) {
			return json(pullRequest);
		}
		if (method === "POST" && url.pathname === "/graphql" && typeof init?.body === "string") {
			const { query, variables } = JSON.parse(init.body) as { query: string; variables?: { after?: string | null } };
			const operation = /^\s*query\s+(\w+)/.exec(query)?.[1] ?? "";
			const pages = recording.graphql?.[operation] ?? [];
			const after = variables?.after ?? null;
			const index = after === null ? 0 : pages.findIndex((page) => endCursor(page) === after) + 1;
			const page = index > 0 || after === null ? pages[index] : undefined;
			if (page !== undefined) return json(page);
			return json({ message: `no recorded page of ${operation} after ${String(after)}` }, 404);
		}
		return json({ message: `no recorded answer for ${method} ${url.pathname}` }, 404);
	};
}
