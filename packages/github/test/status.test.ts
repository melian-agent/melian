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
				creator: { login: f.state.login, type: "User" },
				description: `0 findings, none blocking; base ${f.base}`,
				target_url: "https://github.com/owner/repo/pull/7#issuecomment-1",
			},
		]);
	});
	it.each([93, 94])(
		"17: cuts a %i-character prose prefix to fit 140 and keeps the base suffix whole",
		async (length) => {
			const f = fixture();
			const description = "x".repeat(length);
			await f.provider.setStatus(f.head, { state: "failure", description }, undefined, f.base);
			const posted = f.state.statuses[0]!.description;
			expect(posted).toBe(`${length === 93 ? description : `${"x".repeat(92)}…`}; base ${f.base}`);
			expect(posted).toHaveLength(140);
		},
	);
	it.each([140, 141])("cuts a %i-character description without a reviewed base to 140", async (length) => {
		const f = fixture();
		const description = "x".repeat(length);
		await f.provider.setStatus(f.head, { state: "failure", description });
		expect(f.state.statuses[0]!.description).toBe(length === 140 ? description : `${"x".repeat(139)}…`);
	});
	it("reads only the latest status for an optional reviewed base", async () => {
		const f = fixture();
		expect(await f.provider.getStatus(f.head, f.base)).toBeUndefined();
		await f.provider.setStatus(f.head, { state: "success", description: "Passed" }, undefined, f.base);
		expect(await f.provider.getStatus(f.head, f.base)).toMatchObject({ state: "success" });
		await f.provider.setStatus(f.head, { state: "success", description: "Passed" });
		expect(await f.provider.getStatus(f.head)).toMatchObject({ state: "success" });
		expect(await f.provider.getStatus(f.head, f.base)).toBeUndefined();
		Reflect.set(f.state.statuses.at(-1)!, "description", null);
		expect(await f.provider.getStatus(f.head, f.base)).toBeUndefined();
	});

	it("keeps raw status reads separate from publication identity", async () => {
		const f = fixture();
		await f.provider.setStatus(f.head, { state: "success", description: "Passed" }, undefined, f.base);
		f.state.statuses[0]!.creator = { login: "app[bot]", type: "Bot" };
		expect(await f.provider.getStatus(f.head)).toMatchObject({ state: "success" });
		expect(await f.provider.getStatus(f.head, f.base)).toBeUndefined();
	});
	it("keeps installation-token deduplication when the user identity is unavailable", async () => {
		const f = fixture();
		f.state.failUser = true;
		await f.provider.setStatus(f.head, { state: "success", description: "Passed" }, undefined, f.base);
		f.state.statuses[0]!.creator = { login: "app[bot]", type: "Bot" };
		expect(await f.provider.getStatus(f.head, f.base)).toMatchObject({ state: "success" });
	});

	it("keeps bot-account deduplication when the user endpoint names a bot", async () => {
		const f = fixture();
		f.state.actorType = "Bot";
		await f.provider.setStatus(f.head, { state: "success", description: "Passed" }, undefined, f.base);
		expect(await f.provider.getStatus(f.head, f.base)).toMatchObject({ state: "success" });
	});

	it("keeps the description unchanged when no reviewed base is supplied", async () => {
		const f = fixture();
		await f.provider.setStatus(f.head, { state: "success", description: "merge group verified" });
		expect(f.state.statuses[0]!.description).toBe("merge group verified");
	});
});
