import { rmSync } from "node:fs";
import { createGitHubProvider, markersIn, parseMarker } from "@melian-agent/github";
import {
	backgroundContext as context,
	createMemoryStorage,
	type Harness,
	publishReview,
	readPublished,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub, posts } from "./fixtures/fake-github.ts";
import {
	emptyName,
	gitIn,
	isolatedGitEnv,
	lensScript,
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

async function session() {
	const state = pullRequestState();
	const github = createGitHubProvider({ owner: state.owner, repo: state.repo, token: "t", fetch: fakeGitHub(state) });
	const fake = scenarioModels();
	harness = await openPublishHarness(createMemoryStorage(), fake, github);
	const review = async (resolution: "acknowledge" | "advisory" | "gone") => {
		gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", "next head");
		const calls =
			resolution === "gone"
				? []
				: [
						{
							...emptyName,
							arguments: {
								...emptyName.arguments,
								evidence: [{ file: "src/user.ts", line: resolution === "advisory" ? 19 : 7, role: "cause" }],
							},
						},
					];
		// Each head is an empty commit whose lens judges the same code anew, so the scenario reviews it cold.
		const result = await reviewScenario(repo, harness!, fake, lensScript(...calls), false, { cold: true });
		const { verdict } = await result.review;
		moveTo(state, result.changeset);
		return { changeset: result.changeset, verdict };
	};
	const publish = async (changeset: Awaited<ReturnType<typeof review>>["changeset"]) =>
		publishReview({
			harness: harness!,
			provider: github,
			changeset,
			pullRequest: await github.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: true,
		});
	return { state, github, review, publish };
}

describe("advisory publication", { timeout: 60_000 }, () => {
	it("lists an advisory at its head link without opening a thread, then gives an acknowledgement a thread", async () => {
		const { state, review, publish } = await session();
		const advisory = await review("advisory");
		const id = advisory.verdict.findings.advisory[0]!.id;
		await publish(advisory.changeset);
		expect(state.comments).toEqual([]);
		expect(state.reviews[0]!.body).toContain(
			`[\`src/user.ts:19\`](https://github.com/melian-agent/example/blob/${advisory.changeset.revision.head}/src/user.ts#L19) \`wrong-result\`: An empty name yields no initials.`,
		);
		const raised = await review("acknowledge");
		expect(raised.verdict.findings.acknowledge[0]!.id).toBe(id);
		await publish(raised.changeset);
		expect(state.comments).toHaveLength(1);
		expect(state.comments[0]).toMatchObject({ path: "src/user.ts", line: 7 });
		expect(state.reviews[1]!.body).not.toContain("An empty name yields no initials.");
		const thread = state.comments[0]!.id;
		const lowered = await review("advisory");
		await publish(lowered.changeset);
		expect(state.comments).toHaveLength(1);
		expect(state.resolvedThreads).toEqual([thread]);
		expect(state.comments[0]!.body).toContain(`Addressed in commit ${lowered.changeset.revision.head.slice(0, 12)}`);
		// The finding marker stays first, and the resolved marker follows the sentence.
		const edited = state.comments[0]!.body.split("\n");
		expect(parseMarker(edited[0]!)).toMatchObject({ kind: "finding", id });
		const sentence = edited.indexOf(`Addressed in commit ${lowered.changeset.revision.head.slice(0, 12)}.`);
		expect(parseMarker(edited[sentence + 1]!)).toMatchObject({ kind: "resolved", id });
		expect(edited.slice(sentence + 2)).toEqual([]);
		expect(markersIn(state.comments[0]!.body).map((found) => found.kind)).toEqual(["finding", "resolved"]);
		expect(state.reviews[2]!.body).toContain(`/blob/${lowered.changeset.revision.head}/src/user.ts#L19`);
		const recorded = await readPublished(
			harness!,
			(await harness!.root(context)).id,
			lowered.changeset.revision.head,
			context,
		);
		expect(recorded!.threads).toEqual({});
		const again = await review("acknowledge");
		await publish(again.changeset);
		expect(state.comments).toHaveLength(2);
		expect(state.resolvedThreads).not.toContain(state.comments[1]!.id);
	});

	it.each(["advisory", "gone"] as const)(
		"retires an owed thread when the finding returns as advisory after %s",
		async (interrupted) => {
			const { state, review, publish } = await session();
			await publish((await review("acknowledge")).changeset);
			const thread = state.comments[0]!.id;
			state.failReplies = true;
			const lowered = await review(interrupted);
			await expect(publish(lowered.changeset)).rejects.toMatchObject({ code: "publishFailed" });
			expect(state.resolvedThreads).toEqual([]);
			state.failReplies = false;
			const returned = await review("advisory");
			await publish(returned.changeset);
			expect(state.resolvedThreads).toEqual([thread]);
			expect(state.comments).toHaveLength(1);
			expect(state.comments[0]!.body).toContain(
				`Addressed in commit ${lowered.changeset.revision.head.slice(0, 12)}`,
			);
			expect(state.reviews.at(-1)!.body).toContain(`/blob/${returned.changeset.revision.head}/src/user.ts#L19`);
			const before = posts(state).length;
			await publish(returned.changeset);
			expect(posts(state)).toHaveLength(before);
		},
	);

	it.each(["advisory", "gone"] as const)(
		"restores an owed thread when the finding is raised again after %s",
		async (interrupted) => {
			const { state, review, publish } = await session();
			await publish((await review("acknowledge")).changeset);
			const thread = state.comments[0]!.id;
			state.failReplies = true;
			await expect(publish((await review(interrupted)).changeset)).rejects.toMatchObject({ code: "publishFailed" });
			state.failReplies = false;
			const raised = await review("acknowledge");
			await publish(raised.changeset);
			const roots = () =>
				state.comments.filter((comment) => comment.in_reply_to_id === undefined).map((each) => each.id);
			expect(roots()).toEqual([thread]);
			expect(state.resolvedThreads).toEqual([]);
			expect(state.comments.map((each) => each.body).join("\n")).not.toContain("Addressed in");
			const before = posts(state).length;
			await publish(raised.changeset);
			expect(posts(state)).toHaveLength(before);
			expect(roots()).toEqual([thread]);
		},
	);
});
