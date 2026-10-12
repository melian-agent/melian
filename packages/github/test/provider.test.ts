import { createGitHubProvider } from "@melian-agent/github";
import { describe, expect, it } from "vitest";
import { fakeGitHub, fakeState } from "./fixtures/fake-github.ts";

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
