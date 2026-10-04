import { renderReview, type ReviewProvider } from "@melian-agent/core";
import { type Context, type ConversationId, defineDoc, defineTask, type Harness } from "./harness.ts";
import { readVerdict } from "./verdicts.ts";

type PublishInput = { root: ConversationId; pullRequest: number; head: string; revision: string };

// The review posted at each head, recorded in the commit straight after the post.
export const PublishedDocument = defineDoc<{ heads: Record<string, { revision: string; review: number }> }>({
	kind: "melian.published",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ heads: {} }),
});

// Not replay-safe: a post and the commit recording it are two steps, and GitHub takes no idempotency key. Before
// posting, the task asks the pull request for Melian's signed marker for this head and revision, so a rerun after a
// crash between the two records the review it finds instead of posting it again.
export function publishTask(provider: ReviewProvider) {
	return defineTask<PublishInput, { phase: "publish" }, { review: number }>({
		name: "melian.publish",
		version: 1,
		initial: () => ({ phase: "publish" }),
		phases: {
			publish: async (task, runtime, context) => {
				const { root, pullRequest, head, revision } = task.input;
				const verdict = await readVerdict(runtime, root, revision, context);
				if (verdict === undefined) throw new Error(`no verdict is recorded for ${revision}`);
				const review =
					(await provider.findReview(pullRequest, head, revision)) ??
					(await provider.postReview(pullRequest, head, revision, renderReview(verdict)));
				await runtime.commit(async (tx) => {
					const published = await tx.doc(PublishedDocument, root);
					published.heads[head] = { revision, review };
					return { status: "terminal", outcome: { status: "completed", result: { review } } };
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}

export type PublishOptions = {
	harness: Harness;
	provider: ReviewProvider;
	pullRequest: number;
	/** The merge base the pull request diffs from now, which the host reads with git. */
	base: string;
	head: string;
};

/**
 * Posts the verdict recorded for the pull request's base and head as a review, and returns the review's ID. Refuses
 * when the pull request has moved to another head since the review.
 */
export async function publishReview(options: PublishOptions, context: Context): Promise<number> {
	const { harness, provider, pullRequest, base, head } = options;
	const current = await provider.pullRequest(pullRequest);
	if (current.head !== head) throw new Error(`pull request #${pullRequest} is at ${current.head}; review it again`);
	// Finish any publication a crash interrupted before starting another, so two tasks never post to one pull request
	// at once.
	harness.resume();
	for (const each of (await harness.inspect(context)).tasks) {
		if (each.record.kind === "melian.publish") await harness.waitForTask(each.record.id, context);
	}
	const root = await harness.root(context);
	const input: PublishInput = { root: root.id, pullRequest, head, revision: `${base}..${head}` };
	const id = await root.commit(
		(tx) => tx.createTask(publishTask(provider), input, { ownership: { kind: "conversation" } }),
		context,
	);
	const { outcome } = (await harness.waitForTask(id, context)).state;
	if (outcome.status !== "completed") throw new Error(`publishing #${pullRequest} ended ${outcome.status}`);
	return outcome.result.review;
}
