import { type GitHubRecording, recordedGitHub } from "@melian-agent/github/testing";
import { describe, expect, it } from "vitest";

const recording: GitHubRecording = {
	owner: "melian-agent",
	repo: "example",
	pullRequest: { number: 7, title: "Review the handler" },
};

describe("recordedGitHub", () => {
	it.each(["string", "URL", "Request"])("answers a REST pull request given as %s", async (kind) => {
		const url = "https://api.github.com/repos/melian-agent/example/pulls/7";
		const input = kind === "string" ? url : kind === "URL" ? new URL(url) : new Request(url);

		const response = await recordedGitHub(recording)(input);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.json()).toEqual(recording.pullRequest);
	});

	it.each([
		["GET", "/repos/melian-agent/example/pulls/8", undefined],
		["POST", "/repos/melian-agent/example/pulls/7", undefined],
		["POST", "/graphql", undefined],
		["POST", "/graphql", new URLSearchParams({ query: "query Missing { viewer { login } }" })],
	] as const)("refuses an unrecorded %s %s with body %s", async (method, path, body) => {
		const response = await recordedGitHub(recording)(`https://api.github.com${path}`, { method, body });

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ message: `no recorded answer for ${method} ${path}` });
	});

	it("refuses an unknown cursor when recorded pages have no page information", async () => {
		const answer = recordedGitHub({
			...recording,
			graphql: { Review: [{ data: { repository: null } }] },
		});

		const response = await answer("https://api.github.com/graphql", {
			method: "POST",
			body: JSON.stringify({ query: "query Review { repository { name } }", variables: { after: "missing" } }),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ message: "no recorded page of Review after missing" });
	});

	it("searches past an empty object for a nested page cursor", async () => {
		const next = { data: { pageInfo: { endCursor: null } } };
		const answer = recordedGitHub({
			...recording,
			graphql: { Review: [{ data: { empty: {}, connection: { pageInfo: { endCursor: "next" } } } }, next] },
		});

		const response = await answer("https://api.github.com/graphql", {
			method: "POST",
			body: JSON.stringify({ query: "query Review { viewer { login } }", variables: { after: "next" } }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(next);
	});

	it.each(["query Missing { viewer { login } }", "{ viewer { login } }"])(
		"refuses a query with no recorded operation: %s",
		async (query) => {
			const response = await recordedGitHub(recording)("https://api.github.com/graphql", {
				method: "POST",
				body: JSON.stringify({ query }),
			});

			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				message: `no recorded page of ${query.startsWith("query") ? "Missing" : ""} after null`,
			});
		},
	);
});
