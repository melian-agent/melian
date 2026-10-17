import { createGitHubProvider, marker } from "@melian-agent/github";
import { describe, expect, it, vi } from "vitest";
import { type FakeComment, fakeGitHub, fakeState } from "./fixtures/fake-github.ts";

function fixture() {
	const state = fakeState(
		"owner",
		"repo",
		{
			number: 7,
			title: "Change",
			base: { ref: "main", sha: "a".repeat(40) },
			head: { ref: "feature", sha: "b".repeat(40) },
		},
		{},
	);
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test",
		fetch: fakeGitHub(state),
	});
	return { state, provider };
}

describe("publication response gaps", () => {
	it.each([
		["missing repository", {}],
		["deleted pull request", { repository: { pullRequest: null } }],
		["missing thread page", { repository: { pullRequest: {} } }],
		[
			"empty thread comments",
			{
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [] } }],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		],
		[
			"null first comment",
			{
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [null] } }],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		],
	])("fails closed on %s before resolving a thread", async (_, data) => {
		const { state } = fixture();
		const transport = fakeGitHub(state);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test",
			fetch: async (input, init) => {
				const response = await transport(input, init);
				expect(new URL(String(input)).pathname).toBe("/graphql");
				return new Response(JSON.stringify({ data }), { status: response.status, headers: response.headers });
			},
		});
		await expect(provider.resolveThread(7, "1")).rejects.toThrow();
		expect(state.calls).toHaveLength(1);
		expect(state.resolvedThreads).toEqual([]);
		expect(state.comments).toEqual([]);
	});

	it("accepts an empty thread page and confirms the root is deleted through REST", async () => {
		const { state, provider } = fixture();
		expect(await provider.isThreadOpen(7, "1")).toBe(false);
		expect(state.calls.map(({ path }) => path)).toEqual(["/graphql", "/repos/owner/repo/pulls/comments/1"]);
	});

	it("skips a ghost reply author and keeps reading signed answers", async () => {
		const { state, provider } = fixture();
		const head = state.pull.head.sha;
		const secret = "11".repeat(32);
		const finding = "fedcba9876543210";
		const root = {
			id: 1,
			user: { login: state.login },
			body: marker(head, "finding", finding, secret),
			path: "src/a.ts",
			line: 1,
			side: "RIGHT",
			pull_request_review_id: 1,
		};
		const answer = marker(head, "resolved", finding, secret);
		state.reviews.push({
			id: 1,
			user: { login: state.login },
			body: marker(head, "verdict", "0123456789abcdef", secret, { round: 1 }),
			commit_id: head,
			event: "COMMENT",
		});
		state.comments.push(
			root,
			{ ...root, id: 2, body: answer, in_reply_to_id: 1, user: null },
			{ ...root, id: 3, body: answer, in_reply_to_id: 1 },
		);
		expect(await provider.findPublished(7, head, { fingerprint: "0123456789abcdef", round: 1 }, secret)).toEqual({
			review: "1",
			threads: { [finding]: "1" },
			replies: { [`${finding} 1`]: "3" },
		});
	});

	it("returns no publication markers from empty review and comment listings", async () => {
		const { state, provider } = fixture();
		expect(
			await provider.findPublished(
				7,
				state.pull.head.sha,
				{ fingerprint: "0123456789abcdef", round: 1 },
				"11".repeat(32),
			),
		).toEqual({ threads: {}, replies: {} });
		expect(state.calls.map(({ path }) => path)).toEqual([
			"/repos/owner/repo/pulls/7/reviews",
			"/repos/owner/repo/pulls/7/comments",
		]);
	});
});

describe("root review ownership", () => {
	const secret = "11".repeat(32);
	const finding = "fedcba9876543210";
	const wanted = { fingerprint: "0123456789abcdef", round: 1 };
	function ownership() {
		const { state, provider } = fixture();
		state.failUser = true;
		const head = state.pull.head.sha;
		const review = {
			id: 1,
			user: { login: state.login },
			body: marker(head, "verdict", wanted.fingerprint, secret, { round: 1 }),
			commit_id: head,
			event: "COMMENT",
		};
		const root: FakeComment = {
			id: 2,
			user: { login: state.login },
			body: marker(head, "finding", finding, secret),
			path: "src/a.ts",
			line: 1,
			side: "RIGHT",
			pull_request_review_id: 1,
		};
		state.reviews.push(review);
		state.comments.push(root);
		return { state, provider, head, review, root };
	}

	it.each([
		"human review",
		"missing review",
		"wrong author",
		"wrong revision",
		"bad signature",
		"finding review marker",
	])("rejects a copied root attached to a %s when /user is unavailable", async (kind) => {
		const { state, provider, head, root, review } = ownership();
		if (kind === "human review") {
			state.reviews.push({ ...review, id: 3, user: { login: "human" }, body: "Human review" });
			root.pull_request_review_id = 3;
			root.user = { login: "human" };
		} else if (kind === "missing review") root.pull_request_review_id = 99;
		else if (kind === "wrong author") root.user = { login: "human" };
		else if (kind === "wrong revision")
			review.body = marker("c".repeat(40), "verdict", wanted.fingerprint, secret, { round: 1 });
		else if (kind === "finding review marker") review.body = marker(head, "finding", wanted.fingerprint, secret);
		else review.body = marker(head, "verdict", wanted.fingerprint, "22".repeat(32), { round: 1 });
		const found = await provider.findPublished(7, head, wanted, secret);
		expect(found.threads).toEqual({});
		expect(found.replies).toEqual({});
	});

	it("rejects a later review copying the signed review and root while /user is unavailable", async () => {
		const { state, provider, head, root, review } = ownership();
		state.reviews.push({ ...review, id: 3, user: { login: "human" } });
		root.user = { login: "human" };
		root.pull_request_review_id = 3;
		expect(await provider.findPublished(7, head, wanted, secret)).toEqual({ review: "1", threads: {}, replies: {} });
	});

	it("keeps the first signed review when its author repeats the marker", async () => {
		const { state, provider, head, review } = ownership();
		state.reviews.push({ ...review, id: 3 });
		expect(await provider.findPublished(7, head, wanted, secret)).toEqual({
			review: "1",
			threads: { [finding]: "2" },
			replies: {},
		});
	});

	it("skips a deleted review author and still recovers the owned root", async () => {
		const { state, provider, head, review } = ownership();
		state.reviews.unshift({ ...review, id: 9, user: null });
		expect(await provider.findPublished(7, head, wanted, secret)).toEqual({
			review: "1",
			threads: { [finding]: "2" },
			replies: {},
		});
	});

	it.each([true, false])(
		"checks the parent review before addressing a copied root (unknown user: %s)",
		async (unknown) => {
			const { state, provider, head, root, review } = ownership();
			state.failUser = unknown;
			review.body = "Human-started review with a copied finding marker";
			expect(
				await provider.replyResolved(
					7,
					{ id: finding, ruleId: "unsafe", path: root.path, line: 1, revision: head, thread: String(root.id) },
					head,
					secret,
				),
			).toBeUndefined();
			expect(root.body).not.toContain("Addressed in commit");
			expect(state.resolvedThreads).toEqual([]);
			expect(state.calls.filter(({ method }) => method === "PATCH")).toEqual([]);
		},
	);

	it.each(["wrong author", "wrong revision", "reply", "missing review", "bad signature", "null review"])(
		"refuses an addressed edit with %s",
		async (kind) => {
			const { state, provider, head, root, review } = ownership();
			if (kind === "wrong author") root.user = { login: "human" };
			else if (kind === "wrong revision")
				review.body = marker("c".repeat(40), "verdict", wanted.fingerprint, secret, { round: 1 });
			else if (kind === "bad signature")
				review.body = marker(head, "verdict", wanted.fingerprint, "22".repeat(32), { round: 1 });
			else if (kind === "missing review") root.pull_request_review_id = 99;
			else if (kind === "null review") root.pull_request_review_id = null;
			else {
				root.in_reply_to_id = 3;
				vi.spyOn(provider, "isThreadOpen").mockResolvedValue(true);
			}
			expect(
				await provider.replyResolved(
					7,
					{ id: finding, ruleId: "unsafe", path: root.path, line: 1, revision: head, thread: String(root.id) },
					head,
					secret,
				),
			).toBeUndefined();
			expect(state.calls.filter(({ method }) => method === "PATCH")).toEqual([]);
			expect(state.resolvedThreads).toEqual([]);
			if (kind === "null review") expect(state.calls.filter(({ path }) => path.includes("/reviews"))).toEqual([]);
		},
	);

	it("addresses a root in its signed review without /user", async () => {
		const { state, provider, head, root } = ownership();
		expect(
			await provider.replyResolved(
				7,
				{ id: finding, ruleId: "unsafe", path: root.path, line: 1, revision: head, thread: String(root.id) },
				head,
				secret,
			),
		).toBe(String(root.id));
		expect(root.body).toContain("Addressed in commit");
		expect(state.resolvedThreads).toEqual([root.id]);
	});

	it("skips an addressed root whose author was deleted without failing publication", async () => {
		const { state, provider, head, root } = ownership();
		root.user = null;
		expect(
			await provider.replyResolved(
				7,
				{ id: finding, ruleId: "unsafe", path: root.path, line: 1, revision: head, thread: String(root.id) },
				head,
				secret,
			),
		).toBeUndefined();
		expect(state.resolvedThreads).toEqual([]);
		expect(state.calls.filter(({ method }) => method === "PATCH")).toEqual([]);
	});

	it("ignores finding markers copied into replies even under the signed parent review", async () => {
		const { state, provider, head, root } = ownership();
		const copied = "aaaaaaaaaaaaaaaa";
		state.comments.unshift({
			...root,
			id: 3,
			body: marker(head, "finding", copied, secret),
			in_reply_to_id: root.id,
		});
		expect(await provider.findPublished(7, head, wanted, secret)).toEqual({
			review: "1",
			threads: { [finding]: String(root.id) },
			replies: {},
		});
	});
});

describe("provider identity", () => {
	it("reads the pull request author and repository permission for each login", async () => {
		const { state, provider } = fixture();
		state.author = "contributor";
		state.permissions = { contributor: "read", "melian-user": "admin" };
		expect((await provider.pullRequest(7)).author).toBe("contributor");
		expect(await provider.login()).toBe("melian-user");
		expect(await provider.permission("melian-user")).toBe("admin");
		expect(await provider.permission("contributor")).toBe("read");
		expect(state.calls.filter(({ path }) => path.endsWith("/permission")).map(({ path }) => path)).toEqual([
			"/repos/owner/repo/collaborators/melian-user/permission",
			"/repos/owner/repo/collaborators/contributor/permission",
		]);
	});

	it.each(["admin", "maintain", "write", "triage", "read", "none"])(
		"classifies repository permission %s",
		async (permission) => {
			const { state, provider } = fixture();
			state.permissions = { publisher: permission };
			expect(await provider.permission("publisher")).toBe(permission);
			expect(state.calls).toEqual([
				{
					method: "GET",
					path: "/repos/owner/repo/collaborators/publisher/permission",
				},
			]);
		},
	);

	it.each(["null", "absent"])("keeps a %s author unknown", async (kind) => {
		const { state } = fixture();
		const transport = fakeGitHub(state);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: async (input, init) => {
				const response = await transport(input, init);
				if (new URL(String(input)).pathname !== "/repos/owner/repo/pulls/7") return response;
				const data = (await response.json()) as Record<string, unknown>;
				if (kind === "null") data.user = null;
				else delete data.user;
				return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
			},
		});
		expect(await provider.pullRequest(7)).not.toHaveProperty("author");
	});

	it("remembers a refused viewer lookup", async () => {
		const { state, provider } = fixture();
		state.failUser = true;
		expect(await provider.login()).toBeUndefined();
		expect(await provider.login()).toBeUndefined();
		expect(state.calls.filter(({ path }) => path === "/user")).toHaveLength(1);
	});

	it("leaves a refused or unknown permission unclassified", async () => {
		const { state, provider } = fixture();
		state.failPermission = true;
		expect(await provider.permission("melian-user")).toBeUndefined();
		state.failPermission = false;
		state.permissions = { "melian-user": "unexpected-role" };
		expect(await provider.permission("melian-user")).toBeUndefined();
	});
});

it.each(["OtherEvent", "wrong-head", "wrong-ref"])(
	"reads the exact head push identity past %s decoys",
	async (decoy) => {
		const { state, provider } = fixture();
		state.pushEvents = [
			{
				type: decoy === "OtherEvent" ? "OtherEvent" : "PushEvent",
				actor: { login: "wrong" },
				payload: {
					head: decoy === "wrong-head" ? "a".repeat(40) : state.pull.head.sha,
					ref: decoy === "wrong-ref" ? "refs/heads/another" : "refs/heads/feature",
				},
			},
			{
				type: "PushEvent",
				actor: { login: "head-writer" },
				payload: { head: state.pull.head.sha, ref: "refs/heads/feature" },
			},
		];
		expect((await provider.pullRequest(7)).head).toMatchObject({
			repository: { owner: "owner", name: "repo" },
			pusher: "head-writer",
		});
		expect(state.calls.filter(({ path }) => path.endsWith("/events"))).toEqual([
			{ method: "GET", path: "/repos/owner/repo/events" },
		]);
	},
);
it("distinguishes absent push events, unreadable events and an event with no actor", async () => {
	const { state, provider } = fixture();
	expect((await provider.pullRequest(7)).head).not.toHaveProperty("pusher");
	expect((await provider.pullRequest(7)).head).not.toHaveProperty("writerError");
	state.failEvents = true;
	expect((await provider.pullRequest(7)).head.writerError).toContain("could not be read");
	state.failEvents = false;
	state.pushEvents = [{ type: "PushEvent", payload: { head: state.pull.head.sha, ref: "refs/heads/feature" } }];
	expect((await provider.pullRequest(7)).head.writerError).toContain("names no pushing identity");
	state.headRepository = null;
	expect((await provider.pullRequest(7)).head).not.toHaveProperty("repository");
});
it("reads subsequent event pages before using the author fallback", async () => {
	const { state } = fixture();
	const transport = fakeGitHub(state);
	const pages: number[] = [];
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname !== "/repos/owner/repo/events") return transport(input, init);
			expect(url.searchParams.get("per_page")).toBe("100");
			const page = Number(url.searchParams.get("page") ?? "1");
			pages.push(page);
			return new Response(
				JSON.stringify(
					page === 1
						? []
						: [
								{
									type: "PushEvent",
									actor: { login: "second-page-writer" },
									payload: { head: state.pull.head.sha, ref: "refs/heads/feature" },
								},
							],
				),
				{
					headers: {
						"content-type": "application/json",
						...(page === 1
							? { link: '<https://api.github.com/repos/owner/repo/events?per_page=100&page=2>; rel="next"' }
							: {}),
					},
				},
			);
		},
	});
	expect((await provider.pullRequest(7)).head.pusher).toBe("second-page-writer");
	expect(pages).toEqual([1, 2]);
});

it.each(["one page", "two pages"])("uses the newest matching push from %s", async (pagination) => {
	const { state } = fixture();
	state.permissions = { contributor: "read", maintainer: "write" };
	const events = ["contributor", "maintainer"].map((login) => ({
		type: "PushEvent",
		actor: { login },
		payload: { head: state.pull.head.sha, ref: "refs/heads/feature" },
	}));
	const transport = fakeGitHub(state);
	const pages: number[] = [];
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname !== "/repos/owner/repo/events") return transport(input, init);
			expect(url.searchParams.get("per_page")).toBe("100");
			const page = Number(url.searchParams.get("page") ?? "1");
			pages.push(page);
			expect(page).toBeLessThanOrEqual(pagination === "one page" ? 1 : 2);
			return new Response(JSON.stringify(pagination === "one page" ? events : [events[page - 1]]), {
				headers: {
					"content-type": "application/json",
					...(pagination === "two pages" && page === 1
						? {
								link: '<https://api.github.com/repos/owner/repo/events?per_page=100&page=2>; rel="next"',
							}
						: {}),
				},
			});
		},
	});
	const { head } = await provider.pullRequest(7);
	expect(head.pusher).toBe("contributor");
	expect(await provider.permission(head.pusher!)).toBe("read");
	expect(pages).toEqual(pagination === "one page" ? [1] : [1, 2]);
});

describe("publication record validation", () => {
	const secret = "11".repeat(32);
	const wanted = { fingerprint: "0123456789abcdef", round: 1 };
	const common: { name: string; field?: string; value?: unknown; element?: unknown }[] = [
		{ name: "null element", element: null },
		{ name: "string element", element: "partial" },
		{ name: "missing id", field: "id" },
		{ name: "null id", field: "id", value: null },
		{ name: "string id", field: "id", value: "1" },
		{ name: "zero id", field: "id", value: 0 },
		{ name: "negative id", field: "id", value: -1 },
		{ name: "fractional id", field: "id", value: 1.5 },
		{ name: "unsafe id", field: "id", value: Number.MAX_SAFE_INTEGER + 1 },
		{ name: "missing author", field: "user" },
		{ name: "string author", field: "user", value: "human" },
		{ name: "missing login", field: "user", value: {} },
		{ name: "null login", field: "user", value: { login: null } },
		{ name: "array login", field: "user", value: { login: ["human"] } },
		{ name: "empty login", field: "user", value: { login: "" } },
		{ name: "missing body", field: "body" },
		{ name: "null body", field: "body", value: null },
		{ name: "object body", field: "body", value: {} },
	];
	const cases: { name: string; kind: string; field?: string; value?: unknown; element?: unknown }[] = [
		...common.flatMap((each) => [
			{ ...each, kind: "review" },
			{ ...each, kind: "comment" },
		]),
		...["pull_request_review_id", "in_reply_to_id"].flatMap((field) => [
			{ name: `string ${field}`, field, value: "1", kind: "comment" },
			{ name: `zero ${field}`, field, value: 0, kind: "comment" },
			{ name: `fractional ${field}`, field, value: 1.5, kind: "comment" },
			{ name: `unsafe ${field}`, field, value: Number.MAX_SAFE_INTEGER + 1, kind: "comment" },
		]),
		{ name: "missing review link", field: "pull_request_review_id", kind: "comment" },
		{ name: "null reply link", field: "in_reply_to_id", value: null, kind: "comment" },
	];

	it.each(cases)("rejects the whole $kind listing on $name", async ({ kind, ...bad }) => {
		const { state } = fixture();
		const head = state.pull.head.sha;
		const review = {
			id: 1,
			user: { login: state.login },
			body: marker(head, "verdict", wanted.fingerprint, secret, { round: 1 }),
			commit_id: head,
			event: "COMMENT",
		};
		const comment = {
			id: 2,
			user: { login: state.login },
			body: marker(head, "finding", "fedcba9876543210", secret),
			path: "src/a.ts",
			line: 1,
			side: "RIGHT",
			pull_request_review_id: 1,
		};
		state.reviews.push(review);
		state.comments.push(comment);
		const valid = kind === "review" ? review : comment;
		const malformed: Record<string, unknown> = { ...valid };
		if (bad.field !== undefined) {
			if (Object.hasOwn(bad, "value")) malformed[bad.field] = bad.value;
			else delete malformed[bad.field];
		}
		const element = Object.hasOwn(bad, "element") ? bad.element : malformed;
		const transport = fakeGitHub(state);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test",
			fetch: async (input, init) => {
				const response = await transport(input, init);
				const path = new URL(String(input)).pathname;
				return path.endsWith(kind === "review" ? "/reviews" : "/comments")
					? new Response(JSON.stringify([valid, element]), { status: 200, headers: response.headers })
					: response;
			},
		});
		await expect(provider.findPublished(7, head, wanted, secret)).rejects.toMatchObject({
			code: "failed",
			message: expect.stringContaining("incomplete publication page"),
		});
		expect(state.calls.every(({ method }) => method === "GET")).toBe(true);
	});

	it("accepts a documented null review link without granting ownership to that root", async () => {
		const { state, provider } = fixture();
		const head = state.pull.head.sha;
		state.reviews.push({
			id: 1,
			user: { login: state.login },
			body: marker(head, "verdict", wanted.fingerprint, secret, { round: 1 }),
			commit_id: head,
			event: "COMMENT",
		});
		const root = {
			id: 2,
			user: { login: state.login },
			body: marker(head, "finding", "fedcba9876543210", secret),
			path: "src/a.ts",
			line: 1,
			side: "RIGHT",
			pull_request_review_id: 1,
		};
		state.comments.push({ ...root, id: 3, user: { login: "human" }, pull_request_review_id: null }, root);
		expect(await provider.findPublished(7, head, wanted, secret)).toEqual({
			review: "1",
			threads: { fedcba9876543210: "2" },
			replies: {},
		});
	});

	it("accepts positive IDs at one and the safe-integer bound, optional root links and null deleted authors", async () => {
		const { state, provider } = fixture();
		const head = state.pull.head.sha;
		state.reviews.push({
			id: 1,
			user: { login: state.login },
			body: marker(head, "verdict", wanted.fingerprint, secret, { round: 1 }),
			commit_id: head,
			event: "COMMENT",
		});
		const root = {
			id: Number.MAX_SAFE_INTEGER,
			user: { login: state.login },
			body: marker(head, "finding", "fedcba9876543210", secret),
			path: "src/a.ts",
			line: 1,
			side: "RIGHT",
			pull_request_review_id: 1,
		};
		state.comments.push(root, { ...root, id: 1, user: null, in_reply_to_id: root.id, body: "Deleted author" });
		expect(await provider.findPublished(7, head, wanted, secret)).toEqual({
			review: "1",
			threads: { fedcba9876543210: String(root.id) },
			replies: {},
		});
	});
});
