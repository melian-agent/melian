import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Changeset, ReviewProvider } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	createMemoryStorage,
	type Harness,
	publishReview,
	readFindings,
	recordDismissal,
	revisionKey,
} from "@melian-agent/pipeline";
import type { LensScript } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub } from "./fixtures/fake-github.ts";
import {
	gitIn,
	isolatedGitEnv,
	moveTo,
	openPublishHarness,
	pullRequestState,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
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

const report = (line: number, endLine: number, rule: string, severity: string) => ({
	name: "report_finding",
	arguments: {
		file: "src/user.ts",
		line,
		endLine,
		rule,
		severity,
		explanation: { what: `${rule}.`, why: `${rule} why.`, fix: `${rule} fix.` },
		failureScenario: `${rule} scenario.`,
		evidence: [{ file: "src/user.ts", line, endLine, role: "cause" }],
	},
});
// B, from correctness, sits on line 7 alone; A, from contracts, on lines 6-7, so one hunk caused both and A speaks.
const b = report(7, 7, "null-dereference", "P2");
const a = report(6, 7, "changed-return", "P1");
const script = (correctness: unknown[], contracts: unknown[]): LensScript =>
	({
		correctness: [...(correctness.length > 0 ? [{ calls: correctness }] : []), { text: "Done." }],
		contracts: [...(contracts.length > 0 ? [{ calls: contracts }] : []), { text: "Done." }],
	}) as LensScript;

// A push that leaves src/user.ts and its hunk alone, so only the head moves.
let pushes = 0;
function push(): void {
	pushes++;
	writeFileSync(join(repo, "src/config.ts"), `export const retries = ${pushes};\nexport const timeout = 30;\n`);
	gitIn(repo, "commit", "--quiet", "--all", "-m", `push ${pushes}`);
}

// Step 27: the publish plan carries a resolution reply still owed for a report only while the verdict holds no report
// with its ID, a merged member included.
describe("a report merged under another while its resolution is owed", () => {
	it("keeps the report's thread open, and replies nothing, while the verdict holds it as a member", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const github = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "t",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, github);
		const publish = async (changeset: Changeset) =>
			publishReview({
				harness: harness!,
				provider: github as ReviewProvider,
				changeset,
				pullRequest: await github.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			});
		const head = async (lenses: LensScript) => {
			const { changeset, review } = await reviewScenario(repo, harness!, fake, lenses);
			const { verdict } = await review;
			moveTo(state, changeset);
			return { changeset, verdict };
		};

		await publish((await head(script([b], []))).changeset);
		const [thread] = state.comments.filter((comment) => comment.in_reply_to_id === undefined);
		expect(thread!.body).toContain("null-dereference");
		push();
		// This head reports nothing, and its round fails to answer B's thread, so the answer is owed.
		state.failReplies = true;
		await publish((await head(script([], []))).changeset).catch(() => undefined);
		state.failReplies = false;
		expect(state.comments.filter((comment) => comment.in_reply_to_id === thread!.id)).toEqual([]);
		push();
		const merged = await head(script([b], [a]));
		const [speaker] = merged.verdict.findings.block;
		expect(speaker!.properties.alsoReportedAs?.map((other) => other.ruleId)).toEqual(["null-dereference"]);

		await publish(merged.changeset);

		expect(state.comments.filter((comment) => comment.in_reply_to_id === thread!.id)).toEqual([]);
		expect(state.resolvedThreads).not.toContain(thread!.id);
	});
});

// A finding returns before the reply that resolves its thread went through. It goes back to its own thread, and the
// thread is answered when the finding goes for good, whether it returns merged under another report or alone.
describe("a report that returns while its resolution is owed", () => {
	async function owedThread() {
		const fake = scenarioModels();
		const state = pullRequestState();
		const github = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "t",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, github);
		const publish = async (changeset: Changeset) =>
			publishReview({
				harness: harness!,
				provider: github as ReviewProvider,
				changeset,
				pullRequest: await github.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			});
		const next = async (lenses: LensScript) => {
			const { changeset, review } = await reviewScenario(repo, harness!, fake, lenses);
			await review;
			moveTo(state, changeset);
			return publish(changeset);
		};
		await next(script([b], []));
		const [thread] = state.comments.filter((comment) => comment.in_reply_to_id === undefined);
		push();
		state.failReplies = true;
		await next(script([], [])).catch(() => undefined);
		state.failReplies = false;
		push();
		const roots = () => state.comments.filter((comment) => comment.in_reply_to_id === undefined);
		return { state, next, thread: thread!, roots };
	}

	it("answers the original thread when the report returns alone and is then fixed", async () => {
		const { state, next, thread, roots } = await owedThread();
		await next(script([b], []));
		push();
		await next(script([], []));

		expect(roots().map((comment) => comment.id)).toEqual([thread.id]);
		expect(state.resolvedThreads).toContain(thread.id);
	});

	it("answers the original thread when the report returns merged, then alone, and is then fixed", async () => {
		const { state, next, thread, roots } = await owedThread();
		await next(script([b], [a]));
		push();
		await next(script([b], []));
		push();
		await next(script([], []));

		expect(
			roots()
				.filter((comment) => comment.body.includes("null-dereference"))
				.map((comment) => comment.id),
		).toEqual([thread.id]);
		expect(state.resolvedThreads).toContain(thread.id);
	});

	it("answers the original thread when the report returns at the head whose reply for it failed", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const github = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "t",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, github);
		const publish = async (changeset: Changeset) =>
			publishReview({
				harness: harness!,
				provider: github as ReviewProvider,
				changeset,
				pullRequest: await github.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			});
		const first = await reviewScenario(repo, harness!, fake, script([b], []));
		await first.review;
		moveTo(state, first.changeset);
		await publish(first.changeset);
		const [thread] = state.comments.filter((comment) => comment.in_reply_to_id === undefined);
		push();
		const second = await reviewScenario(repo, harness!, fake, script([], []));
		await second.review;
		moveTo(state, second.changeset);
		state.failReplies = true;
		await publish(second.changeset).catch(() => undefined);
		state.failReplies = false;
		await (await reviewScenario(repo, harness!, fake, script([b], []), true)).review;
		await publish(second.changeset);
		push();
		const last = await reviewScenario(repo, harness!, fake, script([], []));
		await last.review;
		moveTo(state, last.changeset);
		await publish(last.changeset);

		const roots = state.comments.filter((comment) => comment.in_reply_to_id === undefined);
		expect(roots.map((comment) => comment.id)).toEqual([thread!.id]);
		expect(state.resolvedThreads).toContain(thread!.id);
	});

	it("posts a reopened finding afresh when the reply to its dismissal was owed", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const github = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "t",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, github);
		const publish = async (changeset: Changeset) =>
			publishReview({
				harness: harness!,
				provider: github as ReviewProvider,
				changeset,
				pullRequest: await github.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			});
		const first = await reviewScenario(repo, harness!, fake, script([b], []));
		await first.review;
		moveTo(state, first.changeset);
		await publish(first.changeset);
		push();
		const second = await reviewScenario(repo, harness!, fake, script([b], []));
		await second.review;
		moveTo(state, second.changeset);
		const root = (await harness.root(context)).id;
		const [finding] = await readFindings(harness, root, revisionKey(second.changeset.revision), context);
		await recordDismissal({
			harness,
			revision: second.changeset.revision,
			id: finding!.properties.id,
			dismissal: { by: "Melian Test <test@melian.invalid>", reason: "Safe here.", at: "2026-10-04T00:00:00.000Z" },
			repoRoot: repo,
		});
		state.failReplies = true;
		await publish(second.changeset).catch(() => undefined);
		state.failReplies = false;
		const source = readFileSync(join(repo, "src/user.ts"), "utf8");
		writeFileSync(
			join(repo, "src/user.ts"),
			source.replace("(user.manager as User).name", "(user.manager as User).id"),
		);
		gitIn(repo, "commit", "--quiet", "--all", "-m", "change the trigger");
		const third = await reviewScenario(repo, harness, fake, script([b], []));
		await third.review;
		moveTo(state, third.changeset);
		await publish(third.changeset);

		const roots = state.comments.filter((comment) => comment.in_reply_to_id === undefined);
		expect(roots).toHaveLength(2);
	});
});
