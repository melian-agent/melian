import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as github from "@melian-agent/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitHubAccess, gitHubFor } from "../src/target.ts";

let repo: string;

beforeEach(() => {
	repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-target-")));
	execFileSync("git", ["init", "--quiet", repo]);
	execFileSync("git", ["remote", "add", "origin", "https://github.com/melian-agent/example.git"], { cwd: repo });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(repo, { recursive: true, force: true });
});

describe("GitHub access", () => {
	it("reads a scripted recording without resolving a token", async () => {
		const token = vi.spyOn(github, "resolveGitHubToken").mockResolvedValue(undefined);
		const recording = join(repo, "github.json");
		writeFileSync(recording, JSON.stringify({ owner: "melian-agent", repo: "example", pullRequest: { number: 7 } }));

		const access = await gitHubAccess(repo, { MELIAN_TEST_SCRIPT: "script.json", MELIAN_TEST_GITHUB: recording });

		expect(access).toMatchObject({ owner: "melian-agent", repo: "example", token: "scripted", fetch: expect.any(Function) });
		expect(token).not.toHaveBeenCalled();
		const response = await access.fetch!("https://api.github.com/repos/melian-agent/example/pulls/7");
		expect(await response.json()).toEqual({ number: 7 });
	});

	it.each([
		{},
		{ MELIAN_TEST_GITHUB: "missing.json" },
		{ MELIAN_TEST_SCRIPT: "script.json" },
		{ MELIAN_TEST_SCRIPT: "script.json", MELIAN_TEST_GITHUB: "" },
	])("resolves a token without a scripted recording: %j", async (env) => {
		const token = vi.spyOn(github, "resolveGitHubToken").mockResolvedValue({ token: "test-token", source: "GITHUB_TOKEN" });

		expect(await gitHubAccess(repo, env)).toEqual({ owner: "melian-agent", repo: "example", token: "test-token" });
		expect(token).toHaveBeenCalledExactlyOnceWith(env);
	});

	it("names an unreadable scripted recording", async () => {
		const token = vi.spyOn(github, "resolveGitHubToken").mockResolvedValue(undefined);
		const path = join(repo, "missing.json");

		await expect(gitHubAccess(repo, { MELIAN_TEST_SCRIPT: "script.json", MELIAN_TEST_GITHUB: path })).rejects.toMatchObject({
			name: "CliError", message: `MELIAN_TEST_GITHUB names ${path}, which cannot be read`,
		});
		expect(token).not.toHaveBeenCalled();
	});

	it("passes access coordinates and the resolved token to the provider", async () => {
		vi.spyOn(github, "resolveGitHubToken").mockResolvedValue({ token: "test-token", source: "GITHUB_TOKEN" });
		const create = vi.spyOn(github, "createGitHubProvider");

		await gitHubFor(repo, {});

		expect(create).toHaveBeenCalledExactlyOnceWith({ owner: "melian-agent", repo: "example", token: "test-token" });
	});
});
