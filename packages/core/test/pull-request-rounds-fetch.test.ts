import { type MembershipCandidate, PullRequestMembership, type PullRequestRoundHeads } from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

let repo: string;
let remote: string;
let answer: PullRequestRoundHeads;
let candidate: MembershipCandidate;
beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	remote = temporaryDirectory();
	gitIn(repo, "init", "-q", "-b", "main");
	writeFiles(repo, { a: "base" });
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "-qm", "base");
	const base = gitIn(repo, "rev-parse", "HEAD");
	writeFiles(repo, { a: "head" });
	gitIn(repo, "commit", "-qam", "head");
	const head = gitIn(repo, "rev-parse", "HEAD");
	gitIn(remote, "clone", "--quiet", "--bare", repo, ".");
	gitIn(repo, "remote", "add", "origin", remote);
	answer = {
		repository: { owner: "owner", name: "repo" },
		number: 7,
		base,
		head,
		merge: null,
		commits: [head],
		forcePushes: [],
		associated: {},
	};
	candidate = { id: "range-0123456789abcdef.k0123456789abcdef", base, head };
});
afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
	removeDirectory(remote);
});
it("fetches a merged pull request's missing merge commit before reading its first parent", async () => {
	const merge = gitIn(
		remote,
		"commit-tree",
		`${answer.head}^{tree}`,
		"-p",
		answer.base,
		"-p",
		answer.head,
		"-m",
		"merged remotely",
	);
	gitIn(remote, "update-ref", "refs/heads/main", merge);
	const rules = await PullRequestMembership.open(repo, { ...answer, merge });
	expect(await rules.classify(candidate)).toMatchObject({ status: "member" });
	expect(gitIn(repo, "cat-file", "-t", merge)).toBe("commit");
});
it("dates an ownership member's legacy round without making Git a membership test", async () => {
	const rules = await PullRequestMembership.open(repo, answer);
	const owned = {
		...candidate,
		provenance: { kind: "pull-request" as const, repository: answer.repository, pullRequest: 7 },
	};
	expect(await rules.classify(owned)).toEqual({
		...owned,
		status: "member",
		reason: "stored pull request ownership",
		date: Number(gitIn(repo, "show", "-s", "--format=%ct", answer.head)) * 1000,
	});
});

it("keeps proven ownership when Git cannot run to supply a legacy date", async () => {
	const rules = await PullRequestMembership.open(repo, answer);
	const owned = {
		...candidate,
		provenance: { kind: "pull-request" as const, repository: answer.repository, pullRequest: 7 },
	};
	vi.stubEnv("PATH", "/nonexistent");
	expect(await rules.classify(owned)).toEqual({ ...owned, status: "member", reason: "stored pull request ownership" });
});

it("checks prior-head availability locally, after a successful object fetch and after an unsuccessful fetch", async () => {
	const rules = await PullRequestMembership.open(repo, answer);
	expect(await rules.headAvailable(answer.head)).toBe(true);
	const fetched = gitIn(
		remote,
		"commit-tree",
		`${answer.head}^{tree}`,
		"-p",
		answer.head,
		"-m",
		"availability remote-only",
	);
	gitIn(remote, "update-ref", "refs/heads/available", fetched);
	expect(await rules.headAvailable(fetched)).toBe(true);
	expect(await rules.headAvailable("f".repeat(40))).toBe(false);
});
