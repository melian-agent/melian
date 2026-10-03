import { GitHubError, parseGitHubRemote, resolveGitHubToken } from "@melian-agent/github";
import { describe, expect, it } from "vitest";

describe("parseGitHubRemote", () => {
	it.each([
		"https://github.com/melian-agent/melian.git",
		"https://github.com/melian-agent/melian",
		"https://user@github.com/melian-agent/melian.git/",
		"git@github.com:melian-agent/melian.git",
		"ssh://git@github.com/melian-agent/melian.git",
		"ssh://git@github.com:22/melian-agent/melian",
	])("reads %s", (url) => {
		expect(parseGitHubRemote(url)).toEqual({ owner: "melian-agent", repo: "melian" });
	});

	it("keeps a dot in a repository's name", () => {
		expect(parseGitHubRemote("git@github.com:owner/site.github.io.git")).toEqual({
			owner: "owner",
			repo: "site.github.io",
		});
	});

	it("refuses another host or a path that is not owner and repository", () => {
		for (const url of ["git@gitlab.com:owner/repo.git", "https://github.com/owner", "/srv/repo.git"]) {
			expect(() => parseGitHubRemote(url)).toThrow(GitHubError);
		}
	});
});

describe("resolveGitHubToken", () => {
	const gh = (token?: string) => () => Promise.resolve(token);

	it("prefers GITHUB_TOKEN, then GH_TOKEN, then gh's login", async () => {
		expect(await resolveGitHubToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }, gh("c"))).toEqual({
			token: "a",
			source: "GITHUB_TOKEN",
		});
		expect(await resolveGitHubToken({ GH_TOKEN: "b" }, gh("c"))).toEqual({ token: "b", source: "GH_TOKEN" });
		expect(await resolveGitHubToken({ GITHUB_TOKEN: " " }, gh("c"))).toEqual({ token: "c", source: "gh" });
	});

	it("finds none when nothing is set and gh has no login", async () => {
		expect(await resolveGitHubToken({}, gh())).toBeUndefined();
	});
});
