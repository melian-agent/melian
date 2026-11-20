import type { RepositoryPermission } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { describe, expect, it } from "vitest";

type Answer = { status: number; body?: unknown } | "network";
type Routes = Record<string, Answer>;

const collaborator = (login: string) => `GET /repos/Owner/Repo/collaborators/${encodeURIComponent(login)}/permission`;
const user = "GET /user";
const repository = "GET /repos/Owner/Repo";

// Answers only the requests a test names, by method and exact path, and records every request.
function github(routes: Routes) {
	const calls: string[] = [];
	const unexpected: string[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const key = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
		calls.push(key);
		const answer = routes[key];
		if (answer === undefined) {
			unexpected.push(key);
			return new Response(JSON.stringify({ message: "unexpected" }), { status: 599 });
		}
		if (answer === "network") throw new TypeError("fetch failed");
		return new Response(JSON.stringify(answer.body ?? { message: "refused" }), {
			status: answer.status,
			headers: { "content-type": "application/json" },
		});
	};
	const provider = createGitHubProvider({ owner: "Owner", repo: "Repo", token: "test", fetch });
	return { provider, calls, unexpected };
}

const refused = { status: 403 };
const me = (login: string) => ({ status: 200, body: { login, type: "User" } });
const repo = (permissions: unknown, full_name: unknown = "Owner/Repo") => ({
	status: 200,
	body: { full_name, ...(permissions === "absent" ? {} : { permissions }) },
});
const roles = (on: string[]) =>
	Object.fromEntries(["admin", "maintain", "push", "triage", "pull"].map((role) => [role, on.includes(role)]));

async function run(login: string, routes: Routes, expected: RepositoryPermission | undefined, requests: string[]) {
	const { provider, calls, unexpected } = github(routes);
	expect(await provider.permission(login)).toBe(expected);
	expect(unexpected).toEqual([]);
	expect(calls).toEqual(requests);
}

describe("the collaborator endpoint is the authority when it answers", () => {
	it("keeps read against a repository answer of admin", () =>
		run(
			"redbeard",
			{
				[collaborator("redbeard")]: { status: 200, body: { permission: "read" } },
				[user]: me("redbeard"),
				[repository]: repo(roles(["admin", "push", "pull"])),
			},
			"read",
			[collaborator("redbeard")],
		));

	it("keeps admin against a repository answer of read", () =>
		run(
			"redbeard",
			{
				[collaborator("redbeard")]: { status: 200, body: { permission: "admin" } },
				[user]: me("redbeard"),
				[repository]: repo(roles(["pull"])),
			},
			"admin",
			[collaborator("redbeard")],
		));

	it.each([
		["an unknown role", { permission: "owner" }],
		["no role", {}],
	])("reads %s as unknown and never falls back", (_, body) =>
		run(
			"redbeard",
			{
				[collaborator("redbeard")]: { status: 200, body },
				[user]: me("redbeard"),
				[repository]: repo(roles(["admin"])),
			},
			undefined,
			[collaborator("redbeard")],
		),
	);
});

describe("GET /user must name the asked login exactly", () => {
	it.each([
		["case", "Redbeard"],
		["a trailing character", "redbeard2"],
		["a bot suffix", "redbeard[bot]"],
		["another user", "someone-else"],
	])("refuses a login differing by %s", (_, name) =>
		run(
			"redbeard",
			{ [collaborator("redbeard")]: refused, [user]: me(name), [repository]: repo(roles(["admin"])) },
			undefined,
			[collaborator("redbeard"), user],
		),
	);

	it("never answers for another login with one user's token", () =>
		run(
			"other",
			{ [collaborator("other")]: refused, [user]: me("redbeard"), [repository]: repo(roles(["admin"])) },
			undefined,
			[collaborator("other"), user],
		));
});

describe("the repository answer", () => {
	const routes = (answer: Answer): Routes => ({
		[collaborator("redbeard")]: refused,
		[user]: me("redbeard"),
		[repository]: answer,
	});
	const asked = [collaborator("redbeard"), user, repository];

	it("accepts a full_name differing only by case", () =>
		run("redbeard", routes(repo(roles(["push"]), "owner/repo")), "write", asked));

	it("refuses another owner's repository of the same name", () =>
		run("redbeard", routes(repo(roles(["admin"]), "redbeard/Repo")), undefined, asked));

	it("refuses a repository whose name only begins the same", () =>
		run("redbeard", routes(repo(roles(["admin"]), "Owner/Repo2")), undefined, asked));

	it("refuses an absent full_name", () =>
		run("redbeard", routes({ status: 200, body: { permissions: roles(["admin"]) } }), undefined, asked));

	it.each([
		["several roles", roles(["maintain", "push", "triage", "pull"]), "maintain"],
		["every role", roles(["admin", "maintain", "push", "triage", "pull"]), "admin"],
		["push alone", roles(["push"]), "write"],
		["triage and pull", roles(["triage", "pull"]), "triage"],
		["pull alone", roles(["pull"]), "read"],
		["no role", roles([]), "none"],
		["an empty object", {}, "none"],
		["the string true", { admin: "true", push: "true", pull: true }, "read"],
		["the number 1", { admin: 1, pull: false }, "none"],
		["a missing object", "absent", undefined],
		["null", null, undefined],
		["an array", [], undefined],
		["a string", "admin", undefined],
	])("maps %s", (_, permissions, expected) =>
		run("redbeard", routes(repo(permissions)), expected as RepositoryPermission | undefined, asked),
	);

	it("is unknown when the repository endpoint is refused", () => run("redbeard", routes(refused), undefined, asked));
});

describe("a failing collaborator endpoint", () => {
	it.each([
		["403", { status: 403 }],
		["404", { status: 404 }],
		["500", { status: 500 }],
		["a network error", "network"],
	] as const)("falls back to the viewer's own permission after %s", (_, answer) =>
		run(
			"redbeard",
			{ [collaborator("redbeard")]: answer, [user]: me("redbeard"), [repository]: repo(roles(["push"])) },
			"write",
			[collaborator("redbeard"), user, repository],
		),
	);
});

describe("the cached viewer does not count", () => {
	it("is unknown when GET /user is refused, though login() named the asked login before", async () => {
		const answers: Record<string, Answer> = {
			[collaborator("redbeard")]: refused,
			[user]: me("redbeard"),
			[repository]: repo(roles(["admin"])),
		};
		const { provider, calls, unexpected } = github(answers);
		expect(await provider.login()).toBe("redbeard");
		answers[user] = refused;
		expect(await provider.permission("redbeard")).toBeUndefined();
		expect(unexpected).toEqual([]);
		expect(calls).toEqual([user, collaborator("redbeard"), user]);
	});

	it("asks GET /user afresh on each lookup, after login() was refused", async () => {
		const answers: Record<string, Answer> = {
			[collaborator("redbeard")]: refused,
			[user]: refused,
			[repository]: repo(roles(["push"])),
		};
		const { provider, calls } = github(answers);
		expect(await provider.login()).toBeUndefined();
		answers[user] = me("redbeard");
		expect(await provider.permission("redbeard")).toBe("write");
		expect(await provider.permission("redbeard")).toBe("write");
		expect(calls.filter((call) => call === user)).toHaveLength(3);
	});
});
