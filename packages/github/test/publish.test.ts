import { rmSync } from "node:fs";
import type { Changeset, ReviewProvider } from "@melian-agent/core";
import { createGitHubProvider, parseMarker, statusContext } from "@melian-agent/github";
import {
	backgroundContext as context,
	createMemoryStorage,
	dismissFinding,
	type Harness,
	PublishError,
	publishReview,
	ReviewError,
	readFindings,
	readPublished,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub, posts } from "./fixtures/fake-github.ts";
import {
	emptyName,
	isolatedGitEnv,
	lensScript,
	moveTo,
	nanRetries,
	openPublishHarness,
	pullRequestState,
	pushRevisionThree,
	pushRevisionTwo,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
	trimmedGreeting,
	unsafeManager,
} from "./fixtures/scenario.ts";

let repo: string;
let harness: Harness | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = scenarioRepository();
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

function providerFor(state: FakeState) {
	return createGitHubProvider({ owner: state.owner, repo: state.repo, token: "test-token", fetch: fakeGitHub(state) });
}

// Reviews revision 1 and moves a fake pull request to it.
async function reviewedRevisionOne(script = lensScript(unsafeManager, emptyName, nanRetries)) {
	const fake = scenarioModels();
	const state = pullRequestState();
	const github = providerFor(state);
	harness = await openPublishHarness(createMemoryStorage(), fake, github);
	const { changeset, review } = await reviewScenario(repo, harness, fake, script);
	await review.catch((error: unknown) => {
		if (!(error instanceof ReviewError)) throw error;
	});
	moveTo(state, changeset);
	return { fake, github, changeset, state };
}

async function publish(github: ReviewProvider, changeset: Changeset) {
	return publishReview({ harness: harness!, provider: github, changeset, pullRequest: await github.pullRequest(7) });
}

describe("publishing a review", { timeout: 30_000 }, () => {
	it("posts one commenting review, each finding on its line, its nearest changed line, or the body, all marked", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		const head = changeset.revision.head;

		const result = await publish(github, changeset);

		expect(result).toMatchObject({ posted: 3, stillOpen: 0, resolved: 0, replies: 0, recovered: 0 });
		expect(state.reviews).toHaveLength(1);
		const [review] = state.reviews;
		expect(review).toMatchObject({ commit_id: head, event: "COMMENT" });
		expect(review!.body.split("\n")[0]).toMatch(
			new RegExp(`^<!-- melian:revision=${head} verdict=[0-9a-f]{16} -->$`),
		);
		expect(review!.body).toContain("**findings, blocking**");

		const comments = state.comments.map((comment) => ({
			marker: parseMarker(comment.body.split("\n")[0]!),
			path: comment.path,
			line: comment.line,
			side: comment.side,
			start_line: comment.start_line,
			rule: /`([a-z-]+)`/.exec(comment.body)?.[1],
		}));
		expect(comments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "src/user.ts", line: 7, side: "RIGHT", rule: "null-dereference" }),
				expect.objectContaining({ path: "src/user.ts", line: 7, side: "RIGHT", rule: "wrong-result" }),
			]),
		);
		expect(comments).toHaveLength(2);
		for (const comment of comments) expect(comment.marker?.revision).toBe(head);
		const outside = state.comments.find((comment) => comment.body.includes("wrong-result"))!;
		expect(outside.body).toContain(`https://github.com/melian-agent/example/blob/${head}/src/user.ts#L19`);

		// The finding in a file the change does not touch sits in the body, under a marker of its own.
		const findings = await readFindings(harness!, (await harness!.root(context)).id, context);
		const retries = findings.find((finding) => finding.properties.path === "src/config.ts")!;
		expect(review!.body).toContain(`<!-- melian:revision=${head} finding=${retries.properties.id} -->`);
		expect(review!.body).toContain(`https://github.com/melian-agent/example/blob/${head}/src/config.ts#L1`);

		expect(state.statuses).toEqual([
			{ sha: head, state: "failure", description: "3 findings, 1 blocking", context: statusContext },
		]);
		const recorded = await readPublished(harness!, (await harness!.root(context)).id, head, context);
		expect(recorded?.review).toBe(String(review!.id));
		expect(Object.values(recorded!.threads).sort()).toEqual(
			state.comments.map((comment) => String(comment.id)).sort(),
		);
	});

	it("posts nothing when the same revision is published again", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		const before = posts(state).length;

		const again = await publish(github, changeset);

		expect(posts(state)).toHaveLength(before);
		expect(again).toMatchObject({ posted: 0, replies: 0, recovered: 0 });
		expect(state.reviews).toHaveLength(1);
	});

	it("replies in a resolved finding's thread, and reposts neither open nor dismissed findings", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		const root = (await harness!.root(context)).id;
		const first = await readFindings(harness!, root, context);
		const retries = first.find((finding) => finding.properties.path === "src/config.ts")!;
		const manager = first.find((finding) => finding.ruleId === "null-dereference")!;
		await (await harness!.root(context)).commit(
			(tx) =>
				dismissFinding(tx, root, retries.properties.id, {
					by: "author",
					reason: "RETRIES is always set in deployment.",
					at: "2026-10-03T00:00:00.000Z",
				}),
			context,
		);

		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries, trimmedGreeting));
		await second.review;
		moveTo(state, second.changeset);
		const thread = (await readPublished(harness!, root, changeset.revision.head, context))!.threads[
			manager.properties.id
		]!;
		state.calls.length = 0;

		const result = await publish(github, second.changeset);

		const head = second.changeset.revision.head;
		expect(result).toMatchObject({ posted: 1, stillOpen: 1, resolved: 1, replies: 1 });
		expect(state.reviews).toHaveLength(2);
		const posted = state.comments.filter((comment) => comment.pull_request_review_id === state.reviews[1]!.id);
		expect(posted).toHaveLength(1);
		const [greeting] = posted;
		const replies = state.comments.filter((comment) => comment.in_reply_to_id !== undefined);
		expect(replies).toHaveLength(1);
		const [reply] = replies;
		expect(greeting).toMatchObject({ path: "src/user.ts", line: 11, side: "RIGHT" });
		expect(greeting!.body).toContain("trim() changes the greeting.");
		expect(state.reviews[1]!.body).not.toContain("src/config.ts");
		expect(state.reviews[1]!.body).toContain("1 of them was posted on an earlier revision.");
		expect(reply).toMatchObject({ in_reply_to_id: Number(thread) });
		expect(reply!.body.split("\n")[0]).toBe(`<!-- melian:revision=${head} finding=${manager.properties.id} -->`);
		expect(reply!.body).toContain(`Resolved at \`${head.slice(0, 12)}\``);
		expect(state.statuses.at(-1)).toEqual({
			sha: head,
			state: "success",
			description: "2 findings, none blocking",
			context: statusContext,
		});
	});

	it("sets the status and finishes when a resolved finding's thread was deleted", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		state.comments = state.comments.filter((comment) => !comment.body.includes("null-dereference"));

		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries, trimmedGreeting));
		await second.review;
		moveTo(state, second.changeset);
		const result = await publish(github, second.changeset);

		expect(result).toMatchObject({ resolved: 1, replies: 0 });
		expect(state.statuses.at(-1)).toMatchObject({ sha: second.changeset.revision.head, state: "success" });
		const root = (await harness!.root(context)).id;
		const recorded = await readPublished(harness!, root, second.changeset.revision.head, context);
		expect(Object.values(recorded!.replies)).toEqual([null]);
		expect(await publish(github, second.changeset)).toMatchObject({ replies: 0 });
	});

	it("posts a second review when the same head is reviewed again and its verdict changes", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne({
			correctness: lensScript(unsafeManager).correctness!,
		});
		await publish(github, changeset);
		expect(state.statuses.at(-1)).toMatchObject({ state: "error" });

		const again = await reviewScenario(repo, harness!, fake, lensScript(unsafeManager, emptyName, nanRetries));
		await again.review;
		const result = await publish(github, changeset);

		expect(result).toMatchObject({ posted: 2, stillOpen: 1 });
		expect(state.reviews).toHaveLength(2);
		const rules = state.comments.map((comment) => /`([a-z-]+)`/.exec(comment.body)?.[1]);
		expect(rules.sort()).toEqual(["null-dereference", "wrong-result"]);
		expect(state.reviews[1]!.body).toContain("src/config.ts");
		expect(state.statuses.at(-1)).toMatchObject({ state: "failure", description: "3 findings, 1 blocking" });
		const before = posts(state).length;
		expect(await publish(github, changeset)).toMatchObject({ posted: 0 });
		expect(posts(state)).toHaveLength(before);
	});

	it("replies for a pushed-over revision whose replies failed when the next one is published", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries, trimmedGreeting));
		await second.review;
		moveTo(state, second.changeset);
		state.failReplies = true;
		await expect(publish(github, second.changeset)).rejects.toBeInstanceOf(PublishError);
		state.failReplies = false;

		pushRevisionThree(repo);
		const third = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries));
		await third.review;
		moveTo(state, third.changeset);
		const result = await publish(github, third.changeset);

		expect(result).toMatchObject({ resolved: 2, replies: 2 });
		const replied = state.comments.filter((comment) => comment.in_reply_to_id !== undefined);
		expect(replied.map((comment) => /`([a-z-]+)`/.exec(comment.body)?.[1]).sort()).toEqual([
			"null-dereference",
			"wrong-result",
		]);

		// A later revision owes nothing more: the carried resolution was answered once.
		pushRevisionTwo(repo);
		const fourth = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries, trimmedGreeting));
		await fourth.review;
		moveTo(state, fourth.changeset);
		expect(await publish(github, fourth.changeset)).toMatchObject({ resolved: 0, replies: 0 });
	});

	it("sets an error status naming what did not run when the review did not complete", async () => {
		const script = lensScript(unsafeManager);
		const { github, changeset, state } = await reviewedRevisionOne({ correctness: script.correctness! });

		await publish(github, changeset);

		expect(state.statuses).toEqual([
			expect.objectContaining({
				state: "error",
				description: expect.stringMatching(/^Not reviewed: lens\.contracts failed/),
			}),
		]);
		expect(state.reviews[0]!.body).toContain("**not reviewed, blocking**");
	});

	it("refuses to publish when the pull request's head is not the reviewed head", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		state.pull.head.sha = "f".repeat(40);

		const refused = await publish(github, changeset).catch((error: unknown) => error);

		expect(refused).toBeInstanceOf(PublishError);
		expect(refused).toMatchObject({ code: "staleReview", pullRequest: 7 });
		expect((refused as Error).message).toContain("run melian review #7");
		expect(posts(state)).toEqual([]);
	});
});
