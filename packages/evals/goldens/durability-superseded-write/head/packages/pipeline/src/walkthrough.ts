import type { Verdict } from "@melian-agent/core";
import { type Context, type ConversationId, defineDoc, defineTask, type Harness } from "./harness.ts";
import { ReviewIndex } from "./review-index.ts";

type WalkthroughInput = { root: ConversationId; revision: string; verdict: Verdict };

/** Writes the walkthrough of a verdict, on the light model tier. */
export type Summarise = (verdict: Verdict, context: Context) => Promise<string>;

// The walkthrough of each revision, on the root conversation, which publish renders into the ledger.
export const WalkthroughDocument = defineDoc<{ revisions: Record<string, string> }>({
	kind: "melian.walkthrough",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ revisions: {} }),
});

/** The walkthrough task: asks `summarise` for the walkthrough of the verdict it was created with, and stores it. */
export function walkthroughTask(summarise: Summarise) {
	return defineTask<WalkthroughInput, { phase: "write" }, { kind: "written" }>({
		name: "melian.walkthrough",
		version: 1,
		initial: () => ({ phase: "write" }),
		phases: {
			write: async (task, runtime, context) => {
				const { root, revision, verdict } = task.input;
				const text = await summarise(verdict, context);
				await runtime.commit(async (tx) => {
					const document = await tx.doc(WalkthroughDocument, root);
					document.revisions[revision] = text;
					return { status: "terminal", outcome: { status: "completed", result: { kind: "written" } } };
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}

/**
 * Writes the walkthrough of `verdict` for `revision` and returns it. A verdict decided again, as after a dismissal, gets
 * a new walkthrough task, which the review index names in place of the last.
 */
export async function writeWalkthrough(
	harness: Harness,
	summarise: Summarise,
	revision: string,
	verdict: Verdict,
	context: Context,
): Promise<string> {
	const root = await harness.root(context);
	const id = await root.commit(async (tx) => {
		const created = await tx.createTask(
			walkthroughTask(summarise),
			{ root: root.id, revision, verdict },
			{ ownership: { kind: "conversation" } },
		);
		const index = await tx.doc(ReviewIndex, root.id);
		index.revisions[revision] = { ...index.revisions[revision], walkthrough: created };
		return created;
	}, context);
	harness.resume();
	await harness.waitForTask(id, context);
	const written = await harness.snapshot(WalkthroughDocument, root.id, context);
	return written?.revisions[revision] ?? "";
}
