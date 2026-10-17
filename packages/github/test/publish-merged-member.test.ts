import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Changeset, ReviewProvider } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	createMemoryStorage,
	type Harness,
	publishReview,
	recordDismissal,
} from "@melian-agent/pipeline";
import type { LensScript } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishedDocument } from "../../pipeline/src/publish.ts";
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
	it("posts a reopened finding with the same ID afresh when its dismissal reply is owed", async () => {
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
				provider: github,
				changeset,
				pullRequest: await github.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			});
		const first = await reviewScenario(repo, harness, fake, script([b], []));
		const { verdict } = await first.review;
		const [finding] = verdict.findings.acknowledge;
		expect(finding).toBeDefined();
		moveTo(state, first.changeset);
		await publish(first.changeset);
		const [thread] = state.comments;
		await recordDismissal({
			harness,
			revision: first.changeset.revision,
			id: finding!.properties.id,
			dismissal: { by: "Melian Test", reason: "Safe for current callers.", at: "2026-10-17T00:00:00.000Z" },
			repoRoot: repo,
		});
		state.failReplies = true;
		await expect(publish(first.changeset)).rejects.toMatchObject({ code: "publishFailed" });
		state.failReplies = false;
		expect(state.comments).toHaveLength(1);
		const source = readFileSync(join(repo, "src/user.ts"), "utf8");
		writeFileSync(
			join(repo, "src/user.ts"),
			source.replace("managerName(user: User)", 'managerName(user: User, fallback = "none")'),
		);
		gitIn(repo, "commit", "--quiet", "--all", "-m", "change the trigger without changing the finding snippet");
		const reopened = await reviewScenario(repo, harness, fake, script([b], []));
		const { verdict: current } = await reopened.review;
		expect(current.dismissed).toEqual([]);
		expect(current.findings.acknowledge.map((each) => each.properties.id)).toEqual([finding!.properties.id]);
		expect(current.findings.acknowledge[0]!.properties.pastDismissals).toHaveLength(1);
		moveTo(state, reopened.changeset);

		await publish(reopened.changeset);

		const roots = state.comments.filter((comment) => comment.in_reply_to_id === undefined);
		expect(roots.map((comment) => comment.id)).toEqual([thread!.id, expect.any(Number)]);
		expect(roots[1]!.id).not.toBe(thread!.id);
		expect(roots[1]!.body).toContain("null-dereference");
		expect(state.resolvedThreads).not.toContain(roots[1]!.id);
	});

	// With `lost`, the reply goes through and the crash that would have recorded it is simulated by forgetting it.
	async function owedThread({ lost = false } = {}) {
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
		state.failReplies = !lost;
		await next(script([], [])).catch(() => undefined);
		state.failReplies = false;
		if (lost) {
			const root = await harness!.root(context);
			await root.commit(async (tx) => {
				const doc = await tx.doc(PublishedDocument, root.id);
				for (const record of Object.values(doc.revisions)) {
					record.replies = {};
					record.threadResolutions = {};
				}
			}, context);
		}
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

	it("posts the report afresh when its reply reached the provider but was never recorded", async () => {
		const { state, next, thread, roots } = await owedThread({ lost: true });
		await next(script([b], []));

		expect(roots().map((comment) => comment.id)).toHaveLength(2);
		expect(state.resolvedThreads).toContain(thread.id);
	});
});
