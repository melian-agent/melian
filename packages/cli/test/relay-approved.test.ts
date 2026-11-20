import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Changeset, PullRequest } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, writeFiles } from "../../pipeline/test/fixtures/repo.ts";
import { CliError } from "../src/repository.ts";
import { checkApproved } from "../src/target.ts";

const outcome = "Melian relays nothing";
const cleanup: string[] = [];

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repository(): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-relay-approved-")));
	cleanup.push(repo);
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	return repo;
}

let counter = 0;

// Commits a new file on `branch`, first resetting it to `from` when given, and returns the commit.
function commitOn(repo: string, branch: string, options: { from?: string } = {}): string {
	const exists = gitIn(repo, "branch", "--list", branch) !== "";
	if (options.from !== undefined) gitIn(repo, "checkout", "--quiet", "-B", branch, options.from);
	else if (exists) gitIn(repo, "checkout", "--quiet", branch);
	else gitIn(repo, "checkout", "--quiet", "-b", branch);
	counter += 1;
	writeFiles(repo, { [`file-${counter}.txt`]: `${counter}\n` });
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", `commit ${counter}`);
	return gitIn(repo, "rev-parse", "HEAD");
}

// The pull request as the provider reports it now, and the changeset fetched for it, whose base is the merge base of
// the base tip and the head.
function now(
	repo: string,
	baseTip: string,
	head: string,
	ref = "main",
): { pullRequest: PullRequest; fetched: Changeset } {
	const pullRequest = {
		number: 7,
		base: { ref, sha: baseTip, defaultBranch: "main" },
		head: { ref: "feature", sha: head },
	};
	const fetched = { repoRoot: repo, revision: { base: gitIn(repo, "merge-base", baseTip, head), head } };
	return { pullRequest: pullRequest as unknown as PullRequest, fetched: fetched as unknown as Changeset };
}

async function relays(repo: string, baseTip: string, head: string, approved: { base: string; head: string }) {
	const { pullRequest, fetched } = now(repo, baseTip, head);
	await expect(checkApproved(pullRequest, fetched, approved, outcome)).resolves.toBeUndefined();
}

async function refuses(
	repo: string,
	baseTip: string,
	head: string,
	approved: { base: string; head: string },
	ref = "main",
) {
	const { pullRequest, fetched } = now(repo, baseTip, head, ref);
	const result = checkApproved(pullRequest, fetched, approved, outcome);
	await expect(result).rejects.toBeInstanceOf(CliError);
	await expect(result).rejects.toThrow(new RegExp(`${outcome}$`));
}

// main: root, B. feature from B: H1, H. The gate approved base B and head H.
function approvedPullRequest() {
	const repo = repository();
	const root = commitOn(repo, "main");
	const base = commitOn(repo, "main");
	const first = commitOn(repo, "feature", { from: base });
	const head = commitOn(repo, "feature");
	return { repo, root, base, first, head, approved: { base, head } };
}

describe("checkApproved", () => {
	it("relays when nothing moved", async () => {
		const { repo, base, head, approved } = approvedPullRequest();
		await relays(repo, base, head, approved);
	});

	it("relays when main moved forward and the head did not", async () => {
		const { repo, base, head, approved } = approvedPullRequest();
		const moved = commitOn(repo, "main", { from: base });
		await relays(repo, moved, head, approved);
	});

	it("refuses when the head moved", async () => {
		const { repo, base, approved } = approvedPullRequest();
		const moved = commitOn(repo, "feature");
		await refuses(repo, base, moved, approved);
	});

	// An orphan shares no merge base with main, so the fetch fails before the check; this commit shares only the root.
	it("refuses when the head was force-moved to an unrelated commit", async () => {
		const { repo, root, base, approved } = approvedPullRequest();
		const unrelated = commitOn(repo, "feature", { from: root });
		await refuses(repo, base, unrelated, approved);
	});

	it("refuses when main was rewritten so the approved base is gone from its history", async () => {
		const { repo, root, head, approved } = approvedPullRequest();
		const rewritten = commitOn(repo, "main", { from: root });
		await refuses(repo, rewritten, head, approved);
	});

	// The workflow reviews only a pull request into the default branch, so a retargeted one names a round it would refuse.
	it("refuses when the base was retargeted to a branch that contains the approved base", async () => {
		const { repo, base, head, approved } = approvedPullRequest();
		const other = commitOn(repo, "other", { from: base });
		await refuses(repo, other, head, approved, "other");
		const { pullRequest, fetched } = now(repo, other, head, "other");
		await expect(checkApproved(pullRequest, fetched, approved, outcome)).rejects.toThrow(
			"merges into other, not the default branch main,",
		);
	});

	it("refuses when the provider does not say which branch is the default", async () => {
		const { repo, base, head, approved } = approvedPullRequest();
		const { pullRequest, fetched } = now(repo, base, head);
		const unsaid = { ...pullRequest, base: { ref: "main", sha: base } };
		await expect(checkApproved(unsaid, fetched, approved, outcome)).rejects.toThrow(new RegExp(`${outcome}$`));
	});

	it("refuses when the base was retargeted to a branch that does not contain the approved base", async () => {
		const { repo, root, head, approved } = approvedPullRequest();
		const other = commitOn(repo, "other", { from: root });
		await refuses(repo, other, head, approved, "other");
	});

	it("refuses when main merged the head's first commit, so the merge base moved", async () => {
		const { repo, base, first, head, approved } = approvedPullRequest();
		gitIn(repo, "checkout", "--quiet", "main");
		gitIn(repo, "reset", "--quiet", "--hard", base);
		gitIn(repo, "merge", "--quiet", "--no-ff", "-m", "take the first commit", first);
		const merged = gitIn(repo, "rev-parse", "HEAD");
		expect(gitIn(repo, "merge-base", merged, head)).toBe(first);
		await refuses(repo, merged, head, approved);
	});

	it("refuses when the head was rebased onto the new main", async () => {
		const { repo, base, approved } = approvedPullRequest();
		const moved = commitOn(repo, "main", { from: base });
		gitIn(repo, "checkout", "--quiet", "feature");
		gitIn(repo, "rebase", "--quiet", moved);
		const rebased = gitIn(repo, "rev-parse", "HEAD");
		await refuses(repo, moved, rebased, approved);
	});

	it("refuses an approved base on no branch, still stored, that is not an ancestor of the base tip", async () => {
		const { repo, root, base, head } = approvedPullRequest();
		const dangling = commitOn(repo, "gone", { from: root });
		gitIn(repo, "checkout", "--quiet", "main");
		gitIn(repo, "branch", "--quiet", "-D", "gone");
		expect(gitIn(repo, "cat-file", "-t", dangling)).toBe("commit");
		await refuses(repo, base, head, { base: dangling, head });
	});

	it("refuses an approved base absent from the repository", async () => {
		const { repo, base, head } = approvedPullRequest();
		await refuses(repo, base, head, { base: "0123456789abcdef0123456789abcdef01234567", head });
	});

	it("relays an approved base that is an older commit of main, between the merge base and the base tip", async () => {
		const repo = repository();
		commitOn(repo, "main");
		const fork = commitOn(repo, "main");
		const older = commitOn(repo, "main");
		const tip = commitOn(repo, "main");
		const head = commitOn(repo, "feature", { from: fork });
		expect(gitIn(repo, "merge-base", tip, head)).toBe(fork);
		await relays(repo, tip, head, { base: older, head });
	});

	it("refuses an approved base older than the merge base", async () => {
		const repo = repository();
		const older = commitOn(repo, "main");
		const fork = commitOn(repo, "main");
		const tip = commitOn(repo, "main");
		const head = commitOn(repo, "feature", { from: fork });
		expect(gitIn(repo, "merge-base", tip, head)).toBe(fork);
		await refuses(repo, tip, head, { base: older, head });
	});
});

describe("each part of the guard decides alone", () => {
	it.each([
		["a character before it", (id: string) => `g${id.slice(1)}0`],
		["a character after it", (id: string) => `${id}0`],
	])("refuses an approved base with %s", async (_, change) => {
		const { repo, base, head, approved } = approvedPullRequest();
		const { pullRequest, fetched } = now(repo, base, head);
		await expect(
			checkApproved(pullRequest, fetched, { ...approved, base: change(approved.base) }, outcome),
		).rejects.toThrow("must be whole commit IDs");
	});

	it("refuses when only the pull request's head moved", async () => {
		const { repo, base, head, approved } = approvedPullRequest();
		const { pullRequest, fetched } = now(repo, base, head);
		const moved = { ...pullRequest, head: { ...pullRequest.head, sha: "e".repeat(40) } };
		await expect(checkApproved(moved, fetched, approved, outcome)).rejects.toThrow("not the approved head");
	});

	it("refuses when only the fetched head differs", async () => {
		const { repo, base, head, approved } = approvedPullRequest();
		const { pullRequest, fetched } = now(repo, base, head);
		const other = { ...fetched, revision: { ...fetched.revision, head: "e".repeat(40) } } as unknown as Changeset;
		await expect(checkApproved(pullRequest, other, approved, outcome)).rejects.toThrow("not the approved head");
	});
});
