import {
	type MembershipCandidate,
	MembershipError,
	PullRequestMembership,
	type PullRequestRoundHeads,
} from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

let repo: string;
let base: string;
let head: string;
let answer: PullRequestRoundHeads;
let candidate: MembershipCandidate;
beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "-q", "-b", "main");
	writeFiles(repo, { "a.txt": "base" });
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "-qm", "base");
	base = gitIn(repo, "rev-parse", "HEAD");
	writeFiles(repo, { "a.txt": "head" });
	gitIn(repo, "commit", "-qam", "head");
	head = gitIn(repo, "rev-parse", "HEAD");
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
	candidate = { id: "range-0123456789abcdef.r1", base, head };
});
afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

it("accepts only the exact merge base, rejecting delta and stale base rounds", async () => {
	const rules = await PullRequestMembership.open(repo, answer);
	expect(await rules.classify(candidate)).toEqual({
		...candidate,
		status: "member",
		reason: "exact pull request merge base",
		date: Number(gitIn(repo, "show", "-s", "--format=%ct", head)) * 1000,
	});
	expect(await rules.classify({ ...candidate, base: head })).toMatchObject({
		status: "foreign",
		reason: "stored base is not an exact pull request merge base",
	});
	const stale = gitIn(repo, "commit-tree", `${base}^{tree}`, "-m", "stale");
	expect(await rules.classify({ ...candidate, base: stale })).toMatchObject({ status: "foreign" });
});

it("fetches a missing candidate from origin before attributing its exact diff", async () => {
	const remote = temporaryDirectory();
	try {
		gitIn(remote, "clone", "--bare", repo, ".");
		const fetched = gitIn(remote, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "remote-only");
		gitIn(remote, "update-ref", "refs/heads/remote-only", fetched);
		gitIn(repo, "remote", "add", "origin", remote);
		const rules = await PullRequestMembership.open(repo, { ...answer, head: fetched, commits: [fetched] });
		expect(await rules.classify({ ...candidate, head: fetched })).toEqual({
			...candidate,
			head: fetched,
			status: "member",
			reason: "exact pull request merge base",
			date: Number(gitIn(remote, "show", "-s", "--format=%ct", fetched)) * 1000,
		});
		expect(gitIn(repo, "cat-file", "-t", fetched)).toBe("commit");
	} finally {
		removeDirectory(remote);
	}
});
it("rejects an unrelated Git history with no merge base", async () => {
	const unrelated = gitIn(repo, "commit-tree", `${head}^{tree}`, "-m", "unrelated");
	const rules = await PullRequestMembership.open(repo, { ...answer, base: unrelated });
	expect(await rules.classify(candidate)).toEqual({
		...candidate,
		status: "foreign",
		reason: "head has no merge base with the pull request base",
	});
});
it("uses provenance before publication and git, confined to its recorded repository and number", async () => {
	const rules = await PullRequestMembership.open(repo, answer);
	const owned: MembershipCandidate = {
		...candidate,
		head: "f".repeat(40),
		provenance: { kind: "pull-request", repository: { owner: "OWNER", name: "REPO" }, pullRequest: 7 },
	};
	expect(await rules.classify(owned)).toEqual({ ...owned, status: "member", reason: "stored pull request ownership" });
	for (const provenance of [
		{ kind: "pull-request" as const, repository: { owner: "other", name: "repo" }, pullRequest: 7 },
		{ kind: "pull-request" as const, repository: { owner: "owner", name: "other" }, pullRequest: 7 },
		{ kind: "pull-request" as const, repository: answer.repository, pullRequest: 8 },
		{ kind: "pull-request" as const },
	]) {
		expect(
			await rules.classify({ ...owned, provenance, publication: { repository: answer.repository, pullRequest: 7 } }),
		).toMatchObject({ status: "foreign", reason: "stored ownership names another pull request" });
	}
	expect(
		await rules.classify({
			...candidate,
			head: "f".repeat(40),
			provenance: { kind: "range" },
			publication: { repository: answer.repository, pullRequest: 7 },
		}),
	).toMatchObject({ status: "member" });
});
it("keeps stored ownership tri-state and rejects foreign provenance even when Git would accept the round", async () => {
	const rules = await PullRequestMembership.open(repo, { ...answer, associated: { [head]: [7] } });
	const own = { repository: { owner: "OWNER", name: "REPO" }, pullRequest: 7 };
	const foreign = { repository: answer.repository, pullRequest: 8 };
	for (const [facts, result] of [
		[{}, undefined],
		[{ provenance: { kind: "range" } }, undefined],
		[{ publication: own }, true],
		[{ provenance: { kind: "range" }, publication: own }, true],
		[{ publication: foreign }, false],
		[{ provenance: { kind: "pull-request", ...own }, publication: foreign }, true],
		[{ provenance: { kind: "pull-request", ...foreign }, publication: own }, false],
		[{ provenance: { kind: "pull-request" }, publication: own }, false],
		[{ provenance: { kind: "pull-request", repository: answer.repository } }, false],
		[{ provenance: { kind: "pull-request", pullRequest: 7 } }, false],
	] as const) {
		const input = { ...candidate, ...facts };
		expect(PullRequestMembership.storedOwnership(input, answer)).toBe(result);
		const classified = await rules.classify(input);
		expect(classified.status).toBe(result === false ? "foreign" : "member");
		expect(classified.reason).toBe(
			result === undefined
				? "exact pull request merge base"
				: result
					? "stored pull request ownership"
					: "stored ownership names another pull request",
		);
	}
	const missing = { ...candidate, head: "f".repeat(40), publication: own };
	expect(PullRequestMembership.storedOwnership(missing, answer)).toBe(true);
	expect(await rules.classify(missing)).toEqual({
		...missing,
		status: "member",
		reason: "stored pull request ownership",
	});
});
it("accepts current, commit-list, before-force-push and after-force-push heads independently", async () => {
	for (const shape of [
		{ commits: [], forcePushes: [] },
		{ head: base, commits: [head], forcePushes: [] },
		{ head: base, commits: [], forcePushes: [{ before: head, after: base }] },
		{ head: base, commits: [], forcePushes: [{ before: null, after: head }] },
	]) {
		expect(await (await PullRequestMembership.open(repo, { ...answer, ...shape })).classify(candidate)).toMatchObject(
			{ status: "member" },
		);
	}
	expect(
		await (await PullRequestMembership.open(repo, { ...answer, head: base, commits: [] })).classify(candidate),
	).toMatchObject({ status: "unattributed", reason: "GitHub no longer names this head" });
});
it("marks an exact member ambiguous when any other associated pull request shares its head", async () => {
	const rules = await PullRequestMembership.open(repo, { ...answer, associated: { [head]: [7, 12, 19] } });
	expect(await rules.classify(candidate)).toEqual({
		...candidate,
		status: "ambiguous",
		reason: "head is associated with other pull requests",
		otherPullRequests: [12, 19],
		date: Number(gitIn(repo, "show", "-s", "--format=%ct", head)) * 1000,
	});
	expect(await rules.classify({ ...candidate, base: head })).toMatchObject({ status: "foreign" });
});
it("rejects a new candidate whose commit remains absent after fetching", async () => {
	const missing = "f".repeat(40);
	const rules = await PullRequestMembership.open(repo, { ...answer, head: missing });
	expect(await rules.classify({ ...candidate, head: missing })).toMatchObject({
		status: "foreign",
		missingCommit: missing,
		reason: `commit ${missing} is missing after fetch`,
	});
});
it.each([249, 250, 251])("fails closed at GitHub's commit cap (%i)", async (count) => {
	const result = PullRequestMembership.open(repo, { ...answer, commits: Array<string>(count).fill(head) });
	if (count < 250) await expect(result).resolves.toBeInstanceOf(PullRequestMembership);
	else await expect(result).rejects.toThrow("250");
});
it("uses a merged pull request's first parent and refuses a fast-forward merge", async () => {
	const merge = gitIn(repo, "commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "merge");
	const rules = await PullRequestMembership.open(repo, { ...answer, base: head, merge });
	expect(await rules.classify(candidate)).toMatchObject({ status: "member" });
	const next = gitIn(repo, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "fast-forward");
	await expect(PullRequestMembership.open(repo, { ...answer, merge: next })).rejects.toThrow("fast-forward");
});
it("accepts all same-tree merge bases and fails closed when their trees differ", async () => {
	const a = gitIn(repo, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "a");
	for (const different of [false, true]) {
		const b = gitIn(repo, "commit-tree", `${different ? head : base}^{tree}`, "-p", base, "-m", "b");
		const left = gitIn(repo, "commit-tree", `${head}^{tree}`, "-p", a, "-p", b, "-m", "left");
		const right = gitIn(repo, "commit-tree", `${head}^{tree}`, "-p", b, "-p", a, "-m", "right");
		const rules = await PullRequestMembership.open(repo, { ...answer, base: left, head: right, commits: [right] });
		for (const mergeBase of [a, b]) {
			const result = rules.classify({ ...candidate, base: mergeBase, head: right });
			if (different) await expect(result).rejects.toBeInstanceOf(MembershipError);
			else await expect(result).resolves.toMatchObject({ status: "member" });
		}
	}
});
