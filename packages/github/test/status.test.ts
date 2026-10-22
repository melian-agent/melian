import { createGitHubProvider } from "@melian-agent/github";
import { describe, expect, it } from "vitest";
import { fakeGitHub, fakeState } from "./fixtures/fake-github.ts";

function fixture() {
	const base = "a".repeat(40);
	const head = "b".repeat(40);
	const state = fakeState(
		"owner",
		"repo",
		{ number: 7, title: "Change", base: { ref: "main", sha: base }, head: { ref: "feature", sha: head } },
		{},
	);
	const provider = createGitHubProvider({ owner: "owner", repo: "repo", token: "fake", fetch: fakeGitHub(state) });
	return { base, head, state, provider };
}

describe("reviewed base in the published status", () => {
	it("binds the head status to the full reviewed base", async () => {
		const f = fixture();
		await f.provider.setStatus(
			f.head,
			{ state: "success", description: "0 findings, none blocking" },
			"https://github.com/owner/repo/pull/7#issuecomment-1",
			f.base,
		);
		expect(f.state.statuses).toEqual([
			{
				sha: f.head,
				state: "success",
				context: "melian/review",
				description: `0 findings, none blocking; base ${f.base}`,
				target_url: "https://github.com/owner/repo/pull/7#issuecomment-1",
			},
		]);
	});
	it.each([140, 141])("17: accepts exactly 140 characters and refuses %i without cutting", async (length) => {
		const f = fixture();
		const description = "x".repeat(length - 47);
		const posting = f.provider.setStatus(f.head, { state: "failure", description }, undefined, f.base);
		if (length === 140) {
			await posting;
			expect(f.state.statuses[0]!.description).toBe(`${description}; base ${f.base}`);
		} else {
			await expect(posting).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("140") });
			expect(f.state.calls).toEqual([]);
		}
	});
	it("keeps the description unchanged when no reviewed base is supplied", async () => {
		const f = fixture();
		await f.provider.setStatus(f.head, { state: "success", description: "merge group verified" });
		expect(f.state.statuses[0]!.description).toBe("merge group verified");
	});
});
