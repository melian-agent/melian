import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, pullRequestChangesetId, type ReviewProvider, Revision } from "@melian-agent/core";
import { createGitHubProvider, marker, parseMarker, statusContext } from "@melian-agent/github";
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
	recordDismissal,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishedDocument } from "../../pipeline/src/publish.ts";
import { type FakeState, fakeGitHub, posts } from "./fixtures/fake-github.ts";
import {
	emptyName,
	gitIn,
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
	stackOnEditedParent,
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
	vi.restoreAllMocks();
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

async function publish(github: ReviewProvider, changeset: Changeset, trustedWriters = true) {
	const pullRequest = await github.pullRequest(7);
	return publishReview({
		harness: harness!,
		provider: github,
		changeset,
		pullRequest,
		base: changeset.revision.base,
		trustedWriters,
	});
}

it.each([undefined, null, 0, "false"])(
	"refuses publication without explicit writer trust before any write: %s",
	async (trustedWriters) => {
		const { github, changeset, state } = await reviewedRevisionOne(lensScript());
		const options = {
			harness: harness!,
			provider: github,
			changeset,
			pullRequest: await github.pullRequest(7),
			base: changeset.revision.base,
			...(trustedWriters === undefined ? {} : { trustedWriters }),
		};
		const refused = Reflect.apply(publishReview, undefined, [options]) as Promise<unknown>;
		await expect(refused).rejects.toMatchObject({ code: "notPublishable", pullRequest: 7 });
		await expect(refused).rejects.toThrow("requires an explicit root writer-trust policy");
		expect(posts(state)).toEqual([]);
	},
);

describe("reading markers back", () => {
	const head = "a".repeat(40);
	const fingerprint = "0123456789abcdef";
	const wanted = { fingerprint, round: 1 };
	const finding = "fedcba9876543210";
	const secret = "11".repeat(32);
	const none = { threads: {}, replies: {} };
	const review = (id: number, login: string, opening: string) => ({
		id,
		user: { login },
		body: `${opening}\nLooks fine.`,
		commit_id: head,
		event: "COMMENT",
	});
	const comment = (id: number, login: string, opening: string, inReplyTo?: number) => ({
		id,
		user: { login },
		body: `${opening}\nA finding.`,
		path: "src/user.ts",
		line: 7,
		side: "RIGHT",
		pull_request_review_id: 1,
		...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }),
	});

	it("counts a marker the changeset's secret signed when it cannot tell who it posts as", async () => {
		const state = pullRequestState();
		state.failUser = true;
		state.reviews.push(review(1, state.login, marker(head, "verdict", fingerprint, secret, { round: 1 })));
		state.comments.push(comment(2, state.login, marker(head, "finding", finding, secret)));
		state.comments.push(comment(3, state.login, marker(head, "resolved", finding, secret), 2));
		const version = "00112233aabbccdd";
		state.comments.push(
			comment(4, state.login, marker(head, "resolved", finding, secret, { dismissal: version }), 2),
		);

		const github = providerFor(state);
		// A reply is found by its finding, its thread, and the dismissal it gave, so a second reason is a reply of its own.
		expect(await github.findPublished(7, head, wanted, secret)).toEqual({
			review: "1",
			threads: { [finding]: "2" },
			replies: { [`${finding} 2`]: "3", [`${finding} 2 ${version}`]: "4" },
		});
		await github.findPublished(7, head, wanted, secret);
		// One refused /user for the provider, not one for every marker.
		expect(state.calls.filter((call) => call.path === "/user")).toHaveLength(1);
	});

	it("counts no marker whose signature does not verify, however right its text", async () => {
		const state = pullRequestState();
		state.failUser = true;
		const unsigned = `<!-- melian:revision=${head} verdict=${fingerprint} -->`;
		const wrong = `<!-- melian:revision=${head} verdict=${fingerprint} sig=${"0".repeat(32)} -->`;
		const otherStorage = marker(head, "verdict", fingerprint, "22".repeat(32), { round: 1 });
		state.reviews.push(review(1, state.login, unsigned), review(2, state.login, wrong));
		state.reviews.push(review(3, state.login, otherStorage));
		state.comments.push(comment(4, state.login, marker(head, "finding", finding, "22".repeat(32))));
		// A thread's marker copied into a reply is not a reply's.
		state.comments.push(comment(5, state.login, marker(head, "finding", finding, secret), 4));

		expect(await providerFor(state).findPublished(7, head, wanted, secret)).toEqual(none);
	});

	it("also requires the token's own user when it knows who that is", async () => {
		const state = pullRequestState();
		const signed = marker(head, "verdict", fingerprint, secret, { round: 1 });
		state.reviews.push(review(1, "pull-request-author", signed));
		expect(await providerFor(state).findPublished(7, head, wanted, secret)).toEqual(none);
		state.reviews.push(review(2, state.login, signed));
		expect(await providerFor(state).findPublished(7, head, wanted, secret)).toMatchObject({ review: "2" });
	});

	it("takes the first post carrying a marker, since a copy can only follow Melian's", async () => {
		const state = pullRequestState();
		state.failUser = true;
		const signed = marker(head, "finding", finding, secret);
		state.reviews.push(review(1, state.login, marker(head, "verdict", fingerprint, secret, { round: 1 })));
		state.comments.push(comment(1, state.login, signed), comment(2, "pull-request-author", signed));
		expect(await providerFor(state).findPublished(7, head, wanted, secret)).toMatchObject({
			threads: { [finding]: "1" },
		});
	});
});

describe("publishing a review", { timeout: 30_000 }, () => {
	it("records the publisher and a read-only author's permission without blocking publication", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		const result = await publish(github, changeset);
		expect(result.status.state).toBe("failure");
		const record = await readPublished(harness!, (await harness!.root(context)).id, changeset.revision.head, context);
		expect(record?.publishedBy).toEqual({
			login: "melian-user",
			permission: "write",
			authorPermission: "read",
			trustedWriters: true,
		});
		expect(state.ledgers[0]!.body).toContain("Published by `melian-user` (`write`); writers trusted: yes");
		expect(state.ledgers[0]!.body).toContain("Pull request author permission: `read`");
		const body = state.ledgers[0]!.body;
		state.calls = [];
		await publish(github, changeset);
		expect(posts(state)).toEqual([]);
		expect(state.ledgers[0]!.body).toBe(body);
	});

	it("reuses viewer permission when the publisher is the author", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		state.author = state.login;
		await publish(github, changeset);
		const record = await readPublished(harness!, (await harness!.root(context)).id, changeset.revision.head, context);
		expect(record?.publishedBy).toEqual({
			login: "melian-user",
			permission: "write",
			authorPermission: "write",
			trustedWriters: true,
		});
		expect(state.calls.filter(({ path }) => path.endsWith("/permission")).map(({ path }) => path)).toEqual([
			`/repos/${state.owner}/${state.repo}/collaborators/melian-user/permission`,
		]);
	});

	it("does not look up a permission for an absent author", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		const { author: _, ...pullRequest } = await github.pullRequest(7);
		vi.spyOn(github, "pullRequest").mockResolvedValueOnce(pullRequest);
		await publish(github, changeset);
		const record = await readPublished(harness!, (await harness!.root(context)).id, changeset.revision.head, context);
		expect(record?.publishedBy).toEqual({ login: "melian-user", permission: "write", trustedWriters: true });
		expect(state.calls.filter(({ path }) => path.endsWith("/permission")).map(({ path }) => path)).toEqual([
			`/repos/${state.owner}/${state.repo}/collaborators/melian-user/permission`,
		]);
	});

	it.each(["viewer", "permission"])("publishes with an unknown %s when its lookup is refused", async (refused) => {
		const { github, changeset, state } = await reviewedRevisionOne();
		state.failUser = refused === "viewer";
		state.failPermission = refused === "permission";
		await publish(github, changeset);
		const record = await readPublished(harness!, (await harness!.root(context)).id, changeset.revision.head, context);
		expect(record?.publishedBy).toEqual(
			refused === "viewer"
				? {
						trustedWriters: true,
						authorPermission: "read",
					}
				: { trustedWriters: true, login: "melian-user" },
		);
		expect(state.reviews).toHaveLength(1);
		expect(state.ledgers).toHaveLength(1);
	});

	it.each([false, true])("leaves the status to a trusted host with writers off (blocking: %s)", async (blocking) => {
		const { github, changeset, state } = await reviewedRevisionOne(
			blocking ? lensScript(unsafeManager) : lensScript(),
		);
		const result = await publish(github, changeset, false);
		expect(result.status).toEqual({
			state: "error",
			description: "not reviewed here: writers are not trusted; a trusted host sets this status",
		});
		expect(state.statuses.every(({ state }) => state === "error")).toBe(true);
		expect(state.reviews).toHaveLength(1);
		expect(state.ledgers[0]!.body).toContain("writers trusted: no");
		const record = await readPublished(harness!, (await harness!.root(context)).id, changeset.revision.head, context);
		expect(record?.publishedBy.trustedWriters).toBe(false);
		state.calls = [];
		await publish(github, changeset, false);
		expect(posts(state)).toEqual([]);
		await publish(github, changeset, true);
		expect(state.statuses.at(-1)?.state).toBe(blocking ? "failure" : "success");
		expect(state.reviews).toHaveLength(1);
		expect(state.ledgers).toHaveLength(1);
		expect(state.ledgers[0]!.body).toContain("writers trusted: yes");
		const published = await harness!.snapshot(PublishedDocument, (await harness!.root(context)).id, context);
		const latest = published?.ledgerRounds?.at(-1);
		expect(latest).toHaveProperty("publishedBy.trustedWriters", true);
	});

	it("posts one marked review with actionable threads and advisories in its body", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		const head = changeset.revision.head;

		const result = await publish(github, changeset);

		expect(result).toMatchObject({ posted: 3, stillOpen: 0, resolved: 0, replies: 0, recovered: 0 });
		expect(state.reviews).toHaveLength(1);
		const [review] = state.reviews;
		expect(review).toMatchObject({ commit_id: head, event: "COMMENT" });
		expect(review!.body.split("\n")[0]).toMatch(
			new RegExp(`^<!-- melian:revision=${head} verdict=[0-9a-f]{16} round=1 sig=[0-9a-f]{32} -->$`),
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
			]),
		);
		expect(comments).toHaveLength(1);
		for (const comment of comments) expect(comment.marker?.revision).toBe(head);
		expect(review!.body).toContain(`https://github.com/melian-agent/example/blob/${head}/src/user.ts#L19`);

		// The finding in a file the change does not touch sits in the body, under a marker of its own.
		const findings = await readFindings(
			harness!,
			(await harness!.root(context)).id,
			Revision.key(changeset.revision),
			context,
		);
		const retries = findings.find((finding) => finding.properties.path === "src/config.ts")!;
		expect(review!.body).toMatch(
			new RegExp(`\\n<!-- melian:revision=${head} finding=${retries.properties.id} sig=[0-9a-f]{32} -->\\n`),
		);
		expect(review!.body).toContain(`https://github.com/melian-agent/example/blob/${head}/src/config.ts#L1`);

		expect(state.statuses).toEqual([
			{
				sha: head,
				state: "failure",
				description: `3 findings, 1 blocking, 0 unresolved acknowledgements; base ${changeset.revision.base}`,
				context: statusContext,
				creator: { login: state.login, type: "User" },
			},
			{
				sha: head,
				state: "failure",
				description: `3 findings, 1 blocking, 0 unresolved acknowledgements; base ${changeset.revision.base}`,
				context: statusContext,
				creator: { login: state.login, type: "User" },
				target_url: state.ledgers[0]!.html_url,
			},
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

	it("edits and resolves an addressed finding's thread, names a dismissed one in the body, and reposts neither", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		const root = (await harness!.root(context)).id;
		const first = await readFindings(harness!, root, Revision.key(changeset.revision), context);
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
		expect(result).toMatchObject({ posted: 1, stillOpen: 1, resolved: 1, dismissed: 1, replies: 1 });
		expect(state.reviews).toHaveLength(2);
		const posted = state.comments.filter((comment) => comment.pull_request_review_id === state.reviews[1]!.id);
		expect(posted).toHaveLength(1);
		const [greeting] = posted;
		expect(state.comments.filter((comment) => comment.in_reply_to_id !== undefined)).toEqual([]);
		const reply = state.comments.find((comment) => String(comment.id) === thread)!;
		expect(greeting).toMatchObject({ path: "src/user.ts", line: 11, side: "RIGHT" });
		expect(greeting!.body).toContain("trim\\(\\) changes the greeting.");
		// The dismissed finding was posted in the body, so it has no thread, and the next body says why it went.
		expect(state.reviews[1]!.body).toContain(
			"Dismissed since the last review:\n\n- `unhandled-error` in `src/config.ts` line 1: RETRIES is always set in deployment.",
		);
		expect(state.reviews[1]!.body).not.toContain("RETRIES may be unset.");
		expect(state.reviews[1]!.body).toContain("1 of them was posted on an earlier revision.");
		expect(state.resolvedThreads).toContain(Number(thread));
		expect(parseMarker(reply!.body.split("\n").at(-1)!)).toMatchObject({
			revision: head,
			kind: "resolved",
			id: manager.properties.id,
		});
		expect(reply!.body).toContain(`Addressed in commit ${head.slice(0, 12)}`);
		expect(state.statuses.at(-1)).toEqual({
			target_url: state.ledgers[0]!.html_url,
			sha: head,
			state: "failure",
			description: `2 findings, 0 blocking, 1 unresolved acknowledgement; base ${second.changeset.revision.base}`,
			context: statusContext,
			creator: { login: state.login, type: "User" },
		});
		// Counts cover the run: publishing the head again resolves nothing more.
		expect(await publish(github, second.changeset)).toMatchObject({
			posted: 0,
			resolved: 0,
			dismissed: 0,
			replies: 0,
		});
	});

	it("keeps a carried finding open in its thread, and says which lines the round reviewed and which rounds cover the diff", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne(lensScript(unsafeManager));
		await publish(github, changeset);
		const root = (await harness!.root(context)).id;
		const [manager] = await readFindings(harness!, root, Revision.key(changeset.revision), context);
		const thread = (await readPublished(harness!, root, changeset.revision.head, context))!.threads[
			manager!.properties.id
		]!;
		writeFileSync(
			join(repo, "src/config.ts"),
			"export const retries = Number(process.env.RETRIES);\nexport const timeout = 60;\n",
		);
		gitIn(repo, "commit", "--quiet", "--all", "-m", "revision 2");
		const second = await reviewScenario(repo, harness!, fake, lensScript());
		await second.review.catch((error: unknown) => {
			if (!(error instanceof ReviewError)) throw error;
		});
		moveTo(state, second.changeset);

		const result = await publish(github, second.changeset);

		expect(result).toMatchObject({ posted: 0, stillOpen: 1, resolved: 0 });
		const published = await harness!.snapshot(PublishedDocument, root, context);
		expect(published?.revisions[second.changeset.revision.head]?.open[manager!.properties.id]?.thread).toBe(thread);
		expect(state.resolvedThreads).not.toContain(Number(thread));
		const body = state.reviews.at(-1)!.body;
		expect(body).toContain("1 of them was posted on an earlier revision.");
		expect(body).toContain(
			// The delta prompt delivers the earlier hunk as context, and a delivered line counts as reviewed.
			"Coverage: complete, from rounds r1, r2.\n\nRound r2's lenses reviewed 4 of 4 changed lines:\n\n- `src/config.ts` line 2\n- `src/user.ts` line 7\n- `src/config.ts` (base) line 2\n- `src/user.ts` (base) line 7",
		);
		expect(state.ledgers[0]!.body).toContain("Coverage: complete, from rounds r1, r2.");
		expect(state.statuses.at(-1)).toMatchObject({
			state: "failure",
			description: `1 finding, 1 blocking, 0 unresolved acknowledgements; base ${second.changeset.revision.base}`,
		});
		expect(published?.ledgerRounds?.at(-1)).toMatchObject({ coverage: { complete: true, round: "r2" } });
	});

	it("answers a dismissed finding's thread with the reason, and counts it out of the status", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		const root = (await harness!.root(context)).id;
		const manager = (await readFindings(harness!, root, Revision.key(changeset.revision), context)).find(
			(finding) => finding.ruleId === "null-dereference",
		)!;
		const thread = (await readPublished(harness!, root, changeset.revision.head, context))!.threads[
			manager.properties.id
		]!;
		const reason = "Every user here has a manager; see @octocat's #12.";
		const recorded = await recordDismissal({
			harness: harness!,
			revision: changeset.revision,
			id: manager.properties.id,
			dismissal: { by: "Melian Test <test@melian.invalid>", reason, at: "2026-10-04T00:00:00.000Z" },
			repoRoot: repo,
		});
		expect(recorded.verdict).toMatchObject({ status: "findings", blocking: false });
		state.calls.length = 0;

		const result = await publish(github, changeset);

		const head = changeset.revision.head;
		expect(result).toMatchObject({ posted: 0, stillOpen: 2, resolved: 0, dismissed: 1, replies: 1 });
		expect(state.statuses.at(-1)).toEqual({
			target_url: state.ledgers[0]!.html_url,
			sha: head,
			state: "success",
			description: `2 findings, none blocking; base ${changeset.revision.base}`,
			context: statusContext,
			creator: { login: state.login, type: "User" },
		});
		const replies = state.comments.filter((comment) => comment.in_reply_to_id !== undefined);
		expect(replies).toHaveLength(1);
		const [reply] = replies;
		expect(reply).toMatchObject({ in_reply_to_id: Number(thread) });
		expect(parseMarker(reply!.body.split("\n")[0]!)).toMatchObject({
			revision: head,
			kind: "resolved",
			id: manager.properties.id,
		});
		expect(reply!.body.split("\n")[1]).toBe(
			`Dismissed at \`${head.slice(0, 12)}\`: Every user here has a manager; see @\u2060octocat's \\#\u206012.`,
		);
		expect(reply!.body).not.toContain("test@melian.invalid");
		// The new verdict takes a review of its own, which posts no comment and repeats no finding.
		expect(state.reviews).toHaveLength(2);
		expect(state.comments.filter((comment) => comment.pull_request_review_id === state.reviews[1]!.id)).toEqual([]);
		expect(state.reviews[1]!.body).toContain("Dismissals attested by this publication:");
		expect(await publish(github, changeset)).toMatchObject({ posted: 0, dismissed: 0, replies: 0 });
	});

	it("answers a reason changed by a second dismissal with a reply of its own, and posts no review for it", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		const root = (await harness!.root(context)).id;
		const manager = (await readFindings(harness!, root, Revision.key(changeset.revision), context)).find(
			(finding) => finding.ruleId === "null-dereference",
		)!;
		const thread = (await readPublished(harness!, root, changeset.revision.head, context))!.threads[
			manager.properties.id
		]!;
		const dismiss = (reason: string, at: string) =>
			recordDismissal({
				harness: harness!,
				revision: changeset.revision,
				id: manager.properties.id,
				dismissal: { by: "Melian Test <test@melian.invalid>", reason, at },
				repoRoot: repo,
			});
		await dismiss("Every user here has a manager.", "2026-10-04T00:00:00.000Z");
		await publish(github, changeset);
		const reviews = state.reviews.length;
		const statuses = state.statuses.length;
		await dismiss("The caller checks the manager first.", "2026-10-04T01:00:00.000Z");

		const result = await publish(github, changeset);

		expect(result).toMatchObject({ posted: 0, resolved: 0, dismissed: 1, replies: 1 });
		expect(state.reviews).toHaveLength(reviews);
		expect(state.statuses).toHaveLength(statuses);
		const short = changeset.revision.head.slice(0, 12);
		const answers = state.comments.filter((comment) => comment.in_reply_to_id === Number(thread));
		expect(answers.map((comment) => comment.body.split("\n")[1])).toEqual([
			`Dismissed at \`${short}\`: Every user here has a manager.`,
			`Dismissed at \`${short}\`: The caller checks the manager first.`,
		]);
		expect(await publish(github, changeset)).toMatchObject({ posted: 0, dismissed: 0, replies: 0 });
		expect(state.comments.filter((comment) => comment.in_reply_to_id === Number(thread))).toHaveLength(2);
	});

	it("keeps each merged report's own dismissal, answering only the thread whose report was dismissed since", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const github = providerFor(state);
		harness = await openPublishHarness(createMemoryStorage(), fake, github);
		const root = (await harness.root(context)).id;
		const changedReturn = {
			...unsafeManager,
			arguments: { ...unsafeManager.arguments, rule: "changed-return", severity: "P2" },
		};
		const by = "Melian Test <test@melian.invalid>";
		// Reviews the head with each lens reporting `calls`, publishes, and returns the changeset and each thread by rule.
		const reviewPublish = async (correctness: (typeof unsafeManager)[], contracts: (typeof unsafeManager)[]) => {
			const script = {
				correctness: [{ calls: correctness }, { text: "Done." }],
				contracts: [{ calls: contracts }, { text: "Done." }],
			};
			const { changeset, review } = await reviewScenario(repo, harness!, fake, script);
			await review;
			moveTo(state, changeset);
			await publish(github, changeset);
			const findings = await readFindings(harness!, root, Revision.key(changeset.revision), context);
			const idOf = (rule: string) => findings.find((finding) => finding.ruleId === rule)!.properties.id;
			const { threads } = (await readPublished(harness!, root, changeset.revision.head, context))!;
			return { changeset, idOf, threadOf: (rule: string) => threads[idOf(rule)]! };
		};
		const dismiss = (changeset: Changeset, id: string, reason: string, at: string) =>
			recordDismissal({
				harness: harness!,
				revision: changeset.revision,
				id,
				dismissal: { by, reason, at },
				repoRoot: repo,
			});
		const first = await reviewPublish([], [changedReturn]);
		const contractsId = first.idOf("changed-return");
		await dismiss(first.changeset, contractsId, "Contracts never promised a manager.", "2026-10-04T00:00:00.000Z");
		await publish(github, first.changeset);
		writeFileSync(join(repo, "src/other.ts"), "export const other = 1;\n");
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "revision 2");
		const second = await reviewPublish([unsafeManager], [changedReturn]);
		const correctnessId = second.idOf("null-dereference");
		expect(second.idOf("changed-return")).toBe(contractsId);

		await dismiss(second.changeset, correctnessId, "Every user here has a manager.", "2026-10-04T01:00:00.000Z");
		await publish(github, second.changeset);

		const answers = (thread: string) =>
			state.comments
				.filter((comment) => comment.in_reply_to_id === Number(thread))
				.map((comment) => comment.body.split("\n")[1]);
		const [before, after] = [first, second].map((each) => each.changeset.revision.head.slice(0, 12));
		expect(answers(first.threadOf("changed-return"))).toEqual([
			`Dismissed at \`${before}\`: Contracts never promised a manager.`,
		]);
		expect(answers(second.threadOf("null-dereference"))).toEqual([
			`Dismissed at \`${after}\`: Every user here has a manager.`,
		]);
	});

	it("answers a finding dismissed again in the new thread it was reposted in at the same head after a retarget", async () => {
		stackOnEditedParent(repo);
		const fake = scenarioModels();
		const state = pullRequestState();
		const github = providerFor(state);
		harness = await openPublishHarness(createMemoryStorage(), fake, github);
		const root = (await harness.root(context)).id;
		const script = lensScript(unsafeManager, emptyName, nanRetries);
		// Reviews the head against `range` as the pull request's base, publishes, then dismisses the manager finding and
		// publishes again, returning the finding's thread.
		const reviewDismissPublish = async (range: string, reason: string) => {
			const { changeset, review } = await reviewScenario(repo, harness!, fake, script, false, { range });
			await review;
			moveTo(state, changeset);
			await publish(github, changeset);
			const manager = (await readFindings(harness!, root, Revision.key(changeset.revision), context)).find(
				(finding) => finding.ruleId === "null-dereference",
			)!;
			const thread = (await readPublished(harness!, root, changeset.revision.head, context))!.threads[
				manager.properties.id
			]!;
			await recordDismissal({
				harness: harness!,
				revision: changeset.revision,
				id: manager.properties.id,
				dismissal: { by: "Melian Test <test@melian.invalid>", reason, at: new Date().toISOString() },
				repoRoot: repo,
			});
			await publish(github, changeset);
			return { thread, manager, head: changeset.revision.head };
		};

		const first = await reviewDismissPublish("parent...feature", "The parent guarantees a manager.");
		const second = await reviewDismissPublish("main...feature", "Every user here has a manager.");

		expect(second.head).toBe(first.head);
		expect(second.manager.properties.id).toBe(first.manager.properties.id);
		expect(second.manager.properties.pastDismissals).toHaveLength(1);
		expect(second.thread).not.toBe(first.thread);
		const answer = (thread: string) =>
			state.comments
				.filter((comment) => comment.in_reply_to_id === Number(thread))
				.map((comment) => comment.body.split("\n")[1]);
		const short = first.head.slice(0, 12);
		expect(answer(first.thread)).toEqual([`Dismissed at \`${short}\`: The parent guarantees a manager.`]);
		expect(answer(second.thread)).toEqual([`Dismissed at \`${short}\`: Every user here has a manager.`]);
	});

	it("edits an unrecorded signed ledger when the recorded one was deleted, and creates none", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		const [original] = state.ledgers;
		const copy = { ...original!, id: state.nextId++ };
		state.ledgers = [copy];

		await publish(github, changeset);

		expect(state.ledgers).toEqual([copy]);
		expect(state.statuses.at(-1)).toMatchObject({ target_url: copy.html_url });
	});

	it.each([
		{ label: "bot", creator: { login: "some-app[bot]", type: "Bot" } },
		{ label: "non-writer", creator: { login: "former-writer", type: "User" } },
		{ label: "bot with matching login", creator: { login: "melian-user", type: "Bot" } },
		{ label: "deleted creator", creator: null },
	])("repairs an identical $label status over a settled publication", async ({ creator }) => {
		const { github, changeset, state } = await reviewedRevisionOne(lensScript());
		await publish(github, changeset);
		state.permissions = { "former-writer": "read", [state.login]: "write" };
		state.statuses.push({ ...state.statuses.at(-1)!, creator });
		state.calls = [];
		await publish(github, changeset);
		expect(posts(state)).toEqual([
			expect.objectContaining({ path: `/repos/melian-agent/example/statuses/${changeset.revision.head}` }),
		]);
		const latest = await github.mergeGroupReview(changeset.revision.head, new AbortController().signal);
		expect(latest).toMatchObject({
			state: "success",
			creator: { login: state.login, type: "User" },
			description: `Passed; base ${changeset.revision.base}`,
			target_url: state.ledgers[0]!.html_url,
		});
		expect(await github.mergeGroupPermission(latest!.creator!.login, new AbortController().signal)).toBe("write");
	});

	it("keeps installation-token status deduplication after a review teaches its author", async () => {
		const { github, changeset, state } = await reviewedRevisionOne(lensScript());
		state.failUser = true;
		state.login = "installation[bot]";
		state.actorType = "Bot";
		await publish(github, changeset);
		state.calls = [];
		await publish(github, changeset);
		expect(posts(state)).toEqual([]);
		expect(state.statuses.at(-1)!.creator).toEqual({ login: state.login, type: "Bot" });
	});

	it.each(["missing", "another base"])(
		"refreshes a settled publication whose status has %s reviewed base",
		async (kind) => {
			const { github, changeset, state } = await reviewedRevisionOne(lensScript());
			await publish(github, changeset);
			state.statuses.at(-1)!.description = kind === "missing" ? "Passed" : `Passed; base ${"f".repeat(40)}`;
			state.calls = [];
			await publish(github, changeset);
			expect(posts(state)).toEqual([
				expect.objectContaining({
					path: `/repos/melian-agent/example/statuses/${changeset.revision.head}`,
					body: {
						state: "success",
						context: "melian/review",
						description: `Passed; base ${changeset.revision.base}`,
						target_url: state.ledgers[0]!.html_url,
					},
				}),
			]);
		},
	);

	it("repairs an unrecorded ledger-refusal status after publication succeeds", async () => {
		const { github, changeset, state } = await reviewedRevisionOne(
			lensScript(emptyName, nanRetries, trimmedGreeting),
		);
		await publish(github, changeset);
		const root = (await harness!.root(context)).id;
		const head = changeset.revision.head;
		const recorded = await readPublished(harness!, root, head, context);
		expect(recorded?.status?.state).toBe("success");
		state.statuses.push({
			sha: head,
			state: "error",
			description: "ledger unavailable; restore storage or delete the ledger comment by hand",
			context: statusContext,
			creator: { login: state.login, type: "User" },
			target_url: state.ledgers[0]!.html_url,
		});
		expect((await readPublished(harness!, root, head, context))?.status).toEqual(recorded?.status);

		await publish(github, changeset);

		expect(state.statuses.at(-1)).toMatchObject({
			sha: head,
			state: "success",
			description: `${recorded!.status!.description}; base ${changeset.revision.base}`,
			target_url: state.ledgers[0]!.html_url,
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
		expect(state.statuses.at(-1)).toMatchObject({ sha: second.changeset.revision.head, state: "failure" });
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

		const again = await reviewScenario(repo, harness!, fake, lensScript(unsafeManager, emptyName, nanRetries), true);
		await again.review;
		const result = await publish(github, changeset);

		expect(result).toMatchObject({ posted: 2, stillOpen: 1 });
		expect(state.reviews).toHaveLength(2);
		const rules = state.comments.map((comment) => /`([a-z-]+)`/.exec(comment.body)?.[1]);
		expect(rules.sort()).toEqual(["null-dereference"]);
		expect(state.reviews[1]!.body).toContain("`wrong-result`");
		expect(state.reviews[1]!.body).toContain("src/config.ts");
		expect(state.statuses.at(-1)).toMatchObject({
			state: "failure",
			description: `3 findings, 1 blocking, 0 unresolved acknowledgements; base ${changeset.revision.base}`,
		});
		const before = posts(state).length;
		expect(await publish(github, changeset)).toMatchObject({ posted: 0 });
		expect(posts(state)).toHaveLength(before);
	});

	it("posts a review for a verdict that recurs at a head, rather than find the earlier one by its marker", async () => {
		const script = lensScript(unsafeManager, emptyName, nanRetries);
		const { fake, github, changeset, state } = await reviewedRevisionOne(script);
		await publish(github, changeset);
		const failedTsc = [
			{ name: "guardrails", status: "ran" as const },
			{ name: "static.biome", status: "ran" as const },
			{ name: "static.tsc", status: "failed" as const, reason: "tsc crashed" },
		];
		await (await reviewScenario(repo, harness!, fake, script, false, { checks: failedTsc })).review;
		await publish(github, changeset);
		expect(state.statuses.at(-1)).toMatchObject({ state: "error" });

		await (await reviewScenario(repo, harness!, fake, script)).review;
		const result = await publish(github, changeset);

		// The third review's verdict is the first's again; only its round tells them apart.
		expect(result).toMatchObject({ recovered: 0 });
		expect(state.reviews).toHaveLength(3);
		const rounds = state.reviews.map((review) => parseMarker(review.body.split("\n")[0]!)?.round);
		expect(rounds).toEqual([1, 2, 3]);
		expect(parseMarker(state.reviews[2]!.body.split("\n")[0]!)?.id).toBe(
			parseMarker(state.reviews[0]!.body.split("\n")[0]!)?.id,
		);
		expect(state.statuses.at(-1)).toMatchObject({
			state: "failure",
			description: `3 findings, 1 blocking, 0 unresolved acknowledgements; base ${changeset.revision.base}`,
		});
	});

	it("posts a refused round under its own verdict, then a round for the verdict the head has now", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne({
			correctness: lensScript(unsafeManager).correctness!,
		});
		state.failReviews = true;
		await expect(publish(github, changeset)).rejects.toBeInstanceOf(PublishError);
		state.failReviews = false;
		const again = await reviewScenario(repo, harness!, fake, lensScript(unsafeManager, emptyName, nanRetries), true);
		await again.review;

		const result = await publish(github, changeset);

		expect(result).toMatchObject({ posted: 3, stillOpen: 1, abandoned: [] });
		expect(state.reviews).toHaveLength(2);
		expect(state.reviews[0]!.body).toContain("**not reviewed, blocking**");
		expect(state.reviews[1]!.body).toContain("**findings, blocking**");
		expect(state.statuses.at(-1)).toMatchObject({
			state: "failure",
			description: `3 findings, 1 blocking, 0 unresolved acknowledgements; base ${changeset.revision.base}`,
		});
	});

	it.each([true, false])(
		"abandons a round the provider refuses three times, and plans a new one on the next publish (writers trusted: %s)",
		async (trustedWriters) => {
			const { github, changeset, state } = await reviewedRevisionOne();
			state.failReviews = true;
			const refusals = [];
			for (let attempt = 0; attempt < 3; attempt++) {
				refusals.push(await publish(github, changeset, trustedWriters).catch((error: unknown) => error));
				// The head carries a status from the first attempt, though no review could be posted.
				if (attempt === 0)
					expect(state.statuses).toEqual([
						expect.objectContaining({ state: trustedWriters ? "failure" : "error" }),
					]);
			}
			expect(state.statuses.at(-1)).toMatchObject({
				sha: changeset.revision.head,
				state: "error",
				description: trustedWriters
					? `Melian could not post its review; see the publish record; base ${changeset.revision.base}`
					: `not reviewed here: writers are not trusted; a trusted host sets this status; base ${changeset.revision.base}`,
			});
			expect(state.statuses.at(-1)!.description).toMatch(new RegExp(`; base ${changeset.revision.base}$`));
			if (!trustedWriters) {
				expect(state.statuses).toHaveLength(2);
				expect(
					state.statuses.every(
						({ state: value, description }) =>
							value === "error" &&
							description ===
								`not reviewed here: writers are not trusted; a trusted host sets this status; base ${changeset.revision.base}`,
					),
				).toBe(true);
			}
			state.failReviews = false;

			const result = await publish(github, changeset, trustedWriters);

			for (const refused of refusals) expect(refused).toBeInstanceOf(PublishError);
			expect((refusals[1] as Error).message).not.toContain("abandoned");
			expect((refusals[2] as Error).message).toContain("3 times, so Melian abandoned it");
			expect(result).toMatchObject({ posted: 3 });
			expect(result.abandoned).toEqual([
				{ fingerprint: expect.any(String), refusals: 3, error: expect.any(String) },
			]);
			expect(state.reviews).toHaveLength(1);
			expect(state.statuses.at(-1)).toMatchObject({
				state: trustedWriters ? "failure" : "error",
				description: trustedWriters
					? `3 findings, 1 blocking, 0 unresolved acknowledgements; base ${changeset.revision.base}`
					: `not reviewed here: writers are not trusted; a trusted host sets this status; base ${changeset.revision.base}`,
			});
		},
	);

	it("names a refused error status when it abandons a round", async () => {
		const { github, changeset, state } = await reviewedRevisionOne(lensScript());
		state.failReviews = true;
		const setStatus = github.setStatus.bind(github);
		vi.spyOn(github, "setStatus").mockImplementation(async (revision, status, ...rest) => {
			if (status.state === "error") throw new Error("status endpoint unavailable");
			return setStatus(revision, status, ...rest);
		});
		for (let attempt = 0; attempt < 2; attempt++) await expect(publish(github, changeset)).rejects.toThrow();

		const abandoned = publish(github, changeset);

		await expect(abandoned).rejects.toBeInstanceOf(PublishError);
		await expect(abandoned).rejects.toThrow(
			"so Melian abandoned it and could not set the status to error (status endpoint unavailable); the next publish",
		);
		expect(state.statuses.at(-1)).toMatchObject({ state: "success" });
	});

	it("resolves the thread again at the same head when an accepted edit's resolution failed", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries, trimmedGreeting));
		await second.review;
		moveTo(state, second.changeset);
		state.failResolve = true;
		await expect(publish(github, second.changeset)).rejects.toBeInstanceOf(PublishError);
		expect(state.resolvedThreads).toEqual([]);
		state.failResolve = false;

		const result = await publish(github, second.changeset);

		expect(result).toMatchObject({ replies: 1 });
		expect(state.resolvedThreads).toHaveLength(1);
	});

	it("reads finding threads afresh for each publish", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		const reads = () =>
			state.calls.filter((call) => (call.body as { query?: string } | undefined)?.query?.includes("reviewThreads"))
				.length;
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries, trimmedGreeting));
		await second.review;
		moveTo(state, second.changeset);
		await publish(github, second.changeset);
		const afterSecond = reads();
		expect(afterSecond).toBeGreaterThan(0);

		pushRevisionThree(repo);
		const third = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries));
		await third.review;
		moveTo(state, third.changeset);
		expect(await publish(github, third.changeset)).toMatchObject({ resolved: 1 });

		expect(reads()).toBeGreaterThan(afterSecond);
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
		const replied = state.comments.filter((comment) => state.resolvedThreads.includes(comment.id));
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

	it("answers a dismissed finding's thread at the next head when its reply failed and the next head removed the code", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		const root = (await harness!.root(context)).id;
		const manager = (await readFindings(harness!, root, Revision.key(changeset.revision), context)).find(
			(finding) => finding.ruleId === "null-dereference",
		)!;
		const thread = (await readPublished(harness!, root, changeset.revision.head, context))!.threads[
			manager.properties.id
		]!;
		const reason = "Every user here has a manager.";
		await recordDismissal({
			harness: harness!,
			revision: changeset.revision,
			id: manager.properties.id,
			dismissal: { by: "Melian Test <test@melian.invalid>", reason, at: "2026-10-04T00:00:00.000Z" },
			repoRoot: repo,
		});
		state.failReplies = true;
		await expect(publish(github, changeset)).rejects.toBeInstanceOf(PublishError);
		state.failReplies = false;

		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries, trimmedGreeting));
		await second.review;
		moveTo(state, second.changeset);
		const result = await publish(github, second.changeset);

		expect(result).toMatchObject({ dismissed: 1, replies: 1 });
		const answers = state.comments.filter((comment) => comment.in_reply_to_id === Number(thread));
		expect(answers.map((comment) => comment.body.split("\n")[1])).toEqual([
			`Dismissed at \`${second.changeset.revision.head.slice(0, 12)}\`: ${reason}`,
		]);
	});

	it("posts every finding in the body when GitHub refuses the inline comments", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		// GitHub cannot place any comment, as on a diff that moved under the review.
		state.lines = {};

		const result = await publish(github, changeset);

		expect(result).toMatchObject({ posted: 3 });
		expect(posts(state).filter((call) => call.path.endsWith("/reviews"))).toHaveLength(2);
		expect(state.reviews).toHaveLength(1);
		expect(state.comments).toEqual([]);
		const body = state.reviews[0]!.body;
		expect(body).toContain("GitHub refused this review's inline comments, so every finding is listed here.");
		expect(body.match(/^<!-- melian:revision=[0-9a-f]+ finding=/gm)).toHaveLength(3);
		expect(state.statuses.at(-1)).toMatchObject({ state: "failure" });
	});

	it("plans against the last head whose review was posted, past a head whose round failed", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries, trimmedGreeting));
		await second.review;
		moveTo(state, second.changeset);
		state.failReviews = true;
		await expect(publish(github, second.changeset)).rejects.toBeInstanceOf(PublishError);
		state.failReviews = false;

		pushRevisionThree(repo);
		const third = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries));
		await third.review;
		moveTo(state, third.changeset);
		const result = await publish(github, third.changeset);

		expect(result).toMatchObject({ posted: 0, stillOpen: 2, resolved: 1, replies: 1 });
		expect(state.reviews).toHaveLength(2);
		const threads = state.comments.filter((comment) => comment.in_reply_to_id === undefined);
		expect(threads).toHaveLength(1);
	});

	it("does not repost open findings after a head's round was abandoned", async () => {
		const { fake, github, changeset, state } = await reviewedRevisionOne();
		await publish(github, changeset);
		pushRevisionTwo(repo);
		const second = await reviewScenario(repo, harness!, fake, lensScript(emptyName, nanRetries, trimmedGreeting));
		await second.review;
		moveTo(state, second.changeset);
		state.failReviews = true;
		for (let attempt = 0; attempt < 3; attempt++) await publish(github, second.changeset).catch(() => {});
		state.failReviews = false;

		const result = await publish(github, second.changeset);

		expect(result).toMatchObject({ posted: 1, stillOpen: 2, resolved: 1, replies: 1 });
		const posted = state.comments.filter((comment) => comment.pull_request_review_id === state.reviews[1]!.id);
		expect(posted.map((comment) => comment.line)).toEqual([11]);
	});

	it("sets an error status naming what did not run when the review did not complete", async () => {
		const script = lensScript(unsafeManager);
		const { github, changeset, state } = await reviewedRevisionOne({ correctness: script.correctness! });

		await publish(github, changeset);

		expect(state.statuses).toHaveLength(2);
		expect(state.statuses.at(-1)).toEqual(
			expect.objectContaining({
				state: "error",
				description: expect.stringMatching(/^Not reviewed: lens\.contracts failed/),
			}),
		);
		expect(state.reviews[0]!.body).toContain("**not reviewed, blocking**");
	});

	it("refuses to publish when the pull request's head is not the reviewed head", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		state.pull.head.sha = "f".repeat(40);

		const refused = await publish(github, changeset).catch((error: unknown) => error);

		expect(refused).toBeInstanceOf(PublishError);
		expect(refused).toMatchObject({ code: "staleReview", pullRequest: 7 });
		expect((refused as Error).message).toContain('run melian review "#7"');
		expect(posts(state)).toEqual([]);
	});

	it("refuses to publish a range review of the refs Melian fetched for the pull request, from the checkout", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const github = providerFor(state);
		harness = await openPublishHarness(createMemoryStorage(), fake, github);
		gitIn(repo, "update-ref", "refs/melian/pull/7/base", "main");
		gitIn(repo, "update-ref", "refs/melian/pull/7/head", "feature");
		// The head is checked out, so a range review of it reads policy from the working tree, as the CLI's does.
		const { changeset, review } = await reviewScenario(
			repo,
			harness,
			fake,
			lensScript(unsafeManager, emptyName, nanRetries),
			false,
			{ range: "refs/melian/pull/7/base...refs/melian/pull/7/head", origin: "range", policy: "worktree" },
		);
		await review.catch(() => {});
		moveTo(state, changeset);

		const refused = await publish(github, changeset).catch((error: unknown) => error);

		expect(refused).toMatchObject({ code: "notPublishable", pullRequest: 7 });
		expect((refused as Error).message).toContain("it reviewed a range, not the pull request");
		expect(posts(state)).toEqual([]);
		// Either spelling of the refs is a range, whose storage is never the pull request's.
		const short = await Changeset.resolve(repo, "melian/pull/7/base...melian/pull/7/head");
		const pull = pullRequestChangesetId("github", { owner: "melian-agent", name: "example" }, 7);
		expect(short.id).toBe(changeset.id);
		expect(pull).not.toBe(changeset.id);
		expect(pull).toMatch(/^pull-[0-9a-f]{16}$/);
	});

	it("refuses to publish a pull request's review whose policy came from the working tree", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const github = providerFor(state);
		harness = await openPublishHarness(createMemoryStorage(), fake, github);
		const { changeset, review } = await reviewScenario(repo, harness, fake, lensScript(unsafeManager), false, {
			policy: "worktree",
		});
		await review.catch(() => {});
		moveTo(state, changeset);

		const refused = await publish(github, changeset).catch((error: unknown) => error);

		expect(refused).toMatchObject({ code: "notPublishable" });
		expect((refused as Error).message).toContain("its policy came from worktree");
		expect(posts(state)).toEqual([]);
	});

	it("stops before posting when the pull request's head moves after publish validated it", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		const pullRequest = await github.pullRequest(7);
		state.pull.head.sha = "f".repeat(40);

		const refused = await publishReview({
			trustedWriters: true,
			harness: harness!,
			provider: github,
			changeset,
			pullRequest,
			base: changeset.revision.base,
		}).catch((error: unknown) => error);

		expect(refused).toMatchObject({ code: "staleTarget", pullRequest: 7 });
		expect((refused as Error).message).toContain(`its head moved to ${"f".repeat(12)}`);
		expect(posts(state)).toEqual([]);
	});

	it("refuses to publish when the pull request diffs from another base, as after a retarget", async () => {
		const { github, changeset, state } = await reviewedRevisionOne();
		const pullRequest = await github.pullRequest(7);
		const retargeted = "e".repeat(40);

		const refused = await publishReview({
			trustedWriters: true,
			harness: harness!,
			provider: github,
			changeset,
			pullRequest,
			base: retargeted,
		}).catch((error: unknown) => error);

		expect(refused).toBeInstanceOf(PublishError);
		expect(refused).toMatchObject({ code: "staleReview", pullRequest: 7 });
		expect((refused as Error).message).toContain(`now diffs from ${retargeted.slice(0, 12)} on main`);
		expect((refused as Error).message).toContain('retargeted; run melian review "#7" again');
		expect(posts(state)).toEqual([]);
	});
});

describe("cross-head answer discovery", () => {
	const secret = "11".repeat(32);
	const old = "a".repeat(40);
	const head = "b".repeat(40);
	const wanted = { fingerprint: "0123456789abcdef", round: 1 };
	const root = (id: number, finding = "fedcba9876543210") => ({
		id,
		user: { login: "melian-user" },
		body: marker(old, "finding", finding, secret),
		path: "src/user.ts",
		line: 7,
		side: "RIGHT",
		pull_request_review_id: 1,
	});
	// The review the roots at `old` belong to, which `wanted` names.
	const review = {
		id: 1,
		user: { login: "melian-user" },
		body: marker(old, "verdict", wanted.fingerprint, secret, { round: 1 }),
		commit_id: old,
		event: "COMMENT",
	};

	it("finds only signed, root-anchored answers across heads when user lookup fails", async () => {
		const state = pullRequestState();
		state.failUser = true;
		state.restPageSize = 1;
		const first = root(1);
		first.body += `\n${marker(old, "resolved", "fedcba9876543210", secret)}`;
		state.comments.push(first, root(2, "0123456789abcdef"));
		const answer = marker(old, "resolved", "0123456789abcdef", secret, { dismissal: "00112233aabbccdd" });
		state.comments.push(
			{ ...root(3), body: answer, in_reply_to_id: 2, user: { login: "human" } },
			{ ...root(4), body: marker(old, "resolved", "0123456789abcdef", "22".repeat(32)), in_reply_to_id: 2 },
			{ ...root(5), body: marker(old, "resolved", "fedcba9876543210", secret), in_reply_to_id: 2 },
			{ ...root(6), body: answer, in_reply_to_id: 2 },
			{ ...root(7), body: marker(old, "resolved", "fedcba9876543210", secret), in_reply_to_id: 99 },
		);
		const result = await providerFor(state).findPublished(7, head, wanted, secret);
		expect(result).toEqual({
			threads: {},
			replies: { "fedcba9876543210 1": "1", "0123456789abcdef 2 00112233aabbccdd": "6" },
		});
	});

	it("never recovers a reply as a root, even when its root is gone", async () => {
		const state = pullRequestState();
		state.reviews.push(review);
		state.comments.push({ ...root(2), in_reply_to_id: 1 });
		expect((await providerFor(state).findPublished(7, old, wanted, secret)).threads).toEqual({});
	});

	it("recovers only the requested head's roots from the recovered review", async () => {
		const state = pullRequestState();
		state.reviews.push(review);
		state.comments.push(root(1), {
			...root(2, "0123456789abcdef"),
			body: marker(head, "finding", "0123456789abcdef", secret),
		});
		expect((await providerFor(state).findPublished(7, old, wanted, secret)).threads).toEqual({
			fedcba9876543210: "1",
		});
	});

	it("rejects a copied signed reply from a human at the requested head without /user", async () => {
		const state = pullRequestState();
		state.failUser = true;
		const finding = "fedcba9876543210";
		state.reviews.push(review);
		state.comments.push(root(1), {
			...root(2),
			body: marker(old, "resolved", finding, secret),
			in_reply_to_id: 1,
			user: { login: "human" },
		});
		expect(await providerFor(state).findPublished(7, old, wanted, secret)).toEqual({
			review: "1",
			threads: { [finding]: "1" },
			replies: {},
		});
	});

	it("reads open and human-resolved state lazily and resets it between attempts", async () => {
		const state = pullRequestState();
		state.comments.push(root(1));
		const github = providerFor(state);
		expect(state.calls).toEqual([]);
		expect(await github.isThreadOpen(7, "1")).toBe(true);
		expect(await github.isThreadOpen(7, "1")).toBe(true);
		state.resolvedThreads.push(1);
		github.beginPublish();
		expect(await github.isThreadOpen(7, "1")).toBe(false);
		state.resolvedThreads = [];
		github.beginPublish();
		expect(await github.isThreadOpen(7, "1")).toBe(true);
		expect(state.calls.filter((call) => call.path === "/graphql")).toHaveLength(3);
	});

	it("refuses reuse and resolution while a REST root has no GraphQL state", async () => {
		const state = pullRequestState();
		state.comments.push(root(1));
		state.hiddenThreads = [1];
		state.resolvedThreads = [1];
		const github = providerFor(state);
		await expect(github.isThreadOpen(7, "1")).rejects.toMatchObject({ code: "failed" });
		expect(state.calls.some((call) => call.path.endsWith("/pulls/comments/1"))).toBe(true);
		await expect(github.resolveThread(7, "1")).rejects.toMatchObject({ code: "failed" });
		expect(state.resolvedThreads).toEqual([1]);
		state.hiddenThreads = [];
		state.resolvedThreads = [];
		github.beginPublish();
		expect(await github.resolveThread(7, "1")).toBe(true);
		expect(state.resolvedThreads).toEqual([1]);
	});

	it("propagates an unavailable REST root lookup rather than treating it as deleted", async () => {
		const state = pullRequestState();
		state.comments.push(root(1));
		state.hiddenThreads = [1];
		state.commentReadStatus = 403;
		await expect(providerFor(state).isThreadOpen(7, "1")).rejects.toMatchObject({ code: "forbidden" });
	});

	it.each(["verdict", "resolved"] as const)("does not treat a signed %s marker as a finding root", async (kind) => {
		const state = pullRequestState();
		state.failUser = true;
		state.reviews.push(review);
		state.comments.push({ ...root(1), body: marker(old, kind, "fedcba9876543210", secret) });
		expect(await providerFor(state).findPublished(7, old, wanted, secret)).toEqual({
			review: "1",
			threads: {},
			replies: {},
		});
	});

	it("does not recover a root another secret signed from the recovered review", async () => {
		const state = pullRequestState();
		state.failUser = true;
		state.reviews.push(review);
		state.comments.push({ ...root(1), body: marker(old, "finding", "fedcba9876543210", "22".repeat(32)) });
		expect(await providerFor(state).findPublished(7, old, wanted, secret)).toEqual({
			review: "1",
			threads: {},
			replies: {},
		});
	});

	it("does not recover a signed root whose author was deleted", async () => {
		const state = pullRequestState();
		state.failUser = true;
		state.reviews.push(review);
		state.comments.push({ ...root(1), user: null });
		expect(await providerFor(state).findPublished(7, old, wanted, secret)).toEqual({
			review: "1",
			threads: {},
			replies: {},
		});
	});

	it("filters signed roots and their answers from a foreign known author", async () => {
		const state = pullRequestState();
		state.reviews.push(review);
		state.comments.push(
			{ ...root(1), user: { login: "human" } },
			{
				...root(2),
				body: marker(old, "resolved", "fedcba9876543210", secret),
				in_reply_to_id: 1,
				user: { login: "human" },
			},
		);
		expect(await providerFor(state).findPublished(7, old, wanted, secret)).toEqual({
			review: "1",
			threads: {},
			replies: {},
		});
	});

	it("recognises deletion only after GraphQL and REST both lack the root", async () => {
		const state = pullRequestState();
		const github = providerFor(state);
		expect(await github.isThreadOpen(7, "1")).toBe(false);
		expect(await github.resolveThread(7, "1")).toBe(false);
		expect(state.calls.filter((call) => call.path.endsWith("/pulls/comments/1"))).toHaveLength(2);
	});

	it("fails rather than returning the first comment page when the second page fails", async () => {
		const state = pullRequestState();
		state.restPageSize = 1;
		state.failCommentPage = 2;
		state.comments.push(root(1), root(2));
		await expect(providerFor(state).findPublished(7, head, wanted, secret)).rejects.toMatchObject({ code: "failed" });
	});

	it.each([
		{ name: "null body", body: null, page: 1 },
		{ name: "object body", body: { nodes: [] }, page: 1 },
		{ name: "empty later page", body: [], page: 2 },
		{ name: "conflict", body: { message: "Conflict" }, page: 1, status: 409 },
	])("fails closed on a $name comment page", async (response) => {
		const state = pullRequestState();
		state.restPageSize = 1;
		state.comments.push(root(1), root(2));
		state.commentPageResponse = response;
		await expect(providerFor(state).findPublished(7, old, wanted, secret)).rejects.toMatchObject({
			code: "failed",
			...(response.status === undefined ? { message: expect.stringContaining("incomplete publication page") } : {}),
		});
	});

	it.each([
		["missing nodes", { pageInfo: { hasNextPage: false, endCursor: null } }],
		["missing pageInfo", { nodes: [] }],
		[
			"missing resolved state",
			{
				nodes: [{ id: "thread-1", comments: { nodes: [{ databaseId: 1 }] } }],
				pageInfo: { hasNextPage: false, endCursor: null },
			},
		],
		[
			"missing node ID",
			{
				nodes: [{ isResolved: false, comments: { nodes: [{ databaseId: 1 }] } }],
				pageInfo: { hasNextPage: false, endCursor: null },
			},
		],
		["null node", { nodes: [null], pageInfo: { hasNextPage: false, endCursor: null } }],
		[
			"missing comments",
			{ nodes: [{ id: "thread-1", isResolved: false }], pageInfo: { hasNextPage: false, endCursor: null } },
		],
		[
			"two comments",
			{
				nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [{ databaseId: 1 }, { databaseId: 2 }] } }],
				pageInfo: { hasNextPage: false, endCursor: null },
			},
		],
		[
			"empty comments",
			{
				nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [] } }],
				pageInfo: { hasNextPage: false, endCursor: null },
			},
		],
		[
			"missing database ID",
			{
				nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [{}] } }],
				pageInfo: { hasNextPage: false, endCursor: null },
			},
		],
		[
			"null root comment",
			{
				nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [null] } }],
				pageInfo: { hasNextPage: false, endCursor: null },
			},
		],
		["empty cursor", { nodes: [], pageInfo: { hasNextPage: true, endCursor: "" } }],
	])("rejects a partial GraphQL page: %s", async (name, response) => {
		const state = pullRequestState();
		state.comments.push(root(1));
		state.threadPageResponse = response;
		await expect(providerFor(state).resolveThread(7, "1")).rejects.toMatchObject({
			code: "failed",
			message: expect.stringContaining(name === "empty cursor" ? "invalid" : "incomplete"),
		});
		expect(state.resolvedThreads).toEqual([]);
		expect(state.calls.filter((call) => call.path === "/graphql")).toHaveLength(1);
	});

	it.each([
		["a null repository", { repository: null }],
		["a null pull request", { repository: { pullRequest: null } }],
		["no review threads", { repository: { pullRequest: {} } }],
	])("rejects a GraphQL thread answer with %s", async (_, data) => {
		const state = pullRequestState();
		state.comments.push(root(1));
		state.threadResponseData = data;
		await expect(providerFor(state).resolveThread(7, "1")).rejects.toMatchObject({
			code: "failed",
			message: expect.stringContaining("incomplete finding-thread page"),
		});
		expect(state.resolvedThreads).toEqual([]);
	});

	it("ignores a dismissal marker pasted into a root and a signed root with no author", async () => {
		const state = pullRequestState();
		state.failUser = true;
		const first = root(1);
		first.body += `\n${marker(old, "resolved", "fedcba9876543210", secret, { dismissal: "00112233aabbccdd" })}`;
		state.reviews.push(review);
		state.comments.push(first, { ...root(2), user: null });
		expect(await providerFor(state).findPublished(7, old, wanted, secret)).toEqual({
			review: "1",
			threads: { fedcba9876543210: "1" },
			replies: {},
		});
	});

	it.each([50, 51])("bounds the comment listing at 50 pages with %i pages", async (pages) => {
		const state = pullRequestState();
		state.restPageSize = 1;
		state.reviews.push(review);
		state.comments.push(
			...Array.from({ length: pages }, (_, index) => root(index + 1, index.toString(16).padStart(16, "0"))),
		);
		const result = providerFor(state).findPublished(7, old, wanted, secret);
		if (pages === 50) expect(Object.keys((await result).threads)).toHaveLength(50);
		else await expect(result).rejects.toMatchObject({ code: "failed" });
	});

	it.each(["errors", "partial", "missing-cursor", "repeated-cursor"] as const)(
		"refuses a %s thread read before resolution",
		async (failure) => {
			const state = pullRequestState();
			state.comments.push(root(1));
			state.threadReadFailure = failure;
			await expect(providerFor(state).resolveThread(7, "1")).rejects.toMatchObject({ code: "failed" });
			expect(state.resolvedThreads).toEqual([]);
			expect(state.calls.filter((call) => call.path === "/graphql")).toHaveLength(
				failure === "repeated-cursor" ? 2 : 1,
			);
		},
	);

	it("does not mistake a refused thread read for a deleted reply target", async () => {
		const state = pullRequestState();
		state.comments.push(root(1));
		state.threadReadStatus = 404;
		await expect(
			providerFor(state).replyResolved(
				7,
				{
					id: "fedcba9876543210",
					thread: "1",
					revision: old,
					ruleId: "rule",
					path: "src/user.ts",
					line: 7,
					dismissal: { by: "Test", reason: "Safe.", at: "2026-10-18T00:00:00.000Z" },
				},
				head,
				secret,
			),
		).rejects.toMatchObject({ code: "notFound" });
		expect(state.comments).toHaveLength(1);
	});

	it.each([50, 51])("bounds the GraphQL listing at 50 pages with %i pages", async (pages) => {
		const state = pullRequestState();
		state.threadPageSize = 1;
		state.comments.push(...Array.from({ length: pages }, (_, index) => root(index + 1)));
		const result = providerFor(state).resolveThread(7, String(pages));
		if (pages === 50) {
			expect(await result).toBe(true);
			expect(state.resolvedThreads).toEqual([50]);
		} else {
			await expect(result).rejects.toMatchObject({ code: "failed" });
			expect(state.resolvedThreads).toEqual([]);
		}
	});
});
