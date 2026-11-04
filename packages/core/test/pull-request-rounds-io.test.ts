import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PullRequestMembership } from "@melian-agent/core";
import { afterEach, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) removeDirectory(directory);
});

it("uses available merge, range and owned-head objects without fetching them", async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const repo = temporaryDirectory();
	directories.push(repo);
	gitIn(repo, "init", "-q", "-b", "main");
	writeFiles(repo, { a: "base" });
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "-qm", "base");
	const base = gitIn(repo, "rev-parse", "HEAD");
	writeFiles(repo, { a: "head" });
	gitIn(repo, "commit", "-qam", "head");
	const head = gitIn(repo, "rev-parse", "HEAD");
	const merge = gitIn(repo, "commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "merge");
	const trace = join(repo, "git.trace");
	vi.stubEnv("GIT_TRACE2_EVENT", trace);
	const rules = await PullRequestMembership.open(repo, {
		repository: { owner: "owner", name: "repo" },
		number: 7,
		base,
		head,
		merge,
		commits: [head],
		forcePushes: [],
		associated: {},
	});
	expect((await rules.classify({ id: "range-0123456789abcdef.r1", base, head })).status).toBe("member");
	expect(await rules.headAvailable(head)).toBe(true);
	const events = readFileSync(trace, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { event: string; argv?: string[] });
	const commands = events.filter(({ event }) => event === "start").map(({ argv }) => argv!);
	expect(commands.some((argv) => argv[1] === "cat-file")).toBe(true);
	expect(commands.filter((argv) => argv[1] === "fetch")).toEqual([]);
});
