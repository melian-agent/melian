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
