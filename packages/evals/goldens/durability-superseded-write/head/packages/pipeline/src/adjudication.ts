import { adjudicate, type Finding, type Verdict } from "@melian-agent/core";
import { type Context, type ConversationId, defineTask, type Harness } from "./harness.ts";
import { ReviewIndex } from "./review-index.ts";
import { readVerdict, VerdictDocument } from "./verdicts.ts";

type AdjudicationInput = { root: ConversationId; revision: string; findings: Finding[] };

export const AdjudicationTask = defineTask<AdjudicationInput, { phase: "decide" }, { kind: "recorded" | "superseded" }>({
	name: "melian.adjudication",
	version: 1,
	initial: () => ({ phase: "decide" }),
	phases: {
		decide: async (task, runtime, context) => {
			const { root, revision, findings } = task.input;
			const verdict = adjudicate(findings);
			await runtime.commit(async (tx) => {
				// A task a crash left behind resumes whenever the harness does, so only the task the index names may write.
				const index = await tx.doc(ReviewIndex, root);
				if (index.revisions[revision]?.adjudication !== task.id)
					return { status: "terminal", outcome: { status: "completed", result: { kind: "superseded" } } };
				const verdicts = await tx.doc(VerdictDocument, root);
				verdicts.revisions[revision] = verdict;
				return { status: "terminal", outcome: { status: "completed", result: { kind: "recorded" } } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/** Decides the verdict of `findings` for `revision`, in place of any adjudication the index names for it. */
export async function decideVerdict(
	harness: Harness,
	revision: string,
	findings: Finding[],
	context: Context,
): Promise<Verdict | undefined> {
	const root = await harness.root(context);
	const id = await root.commit(async (tx) => {
		const created = await tx.createTask(
			AdjudicationTask,
			{ root: root.id, revision, findings },
			{ ownership: { kind: "conversation" } },
		);
		const index = await tx.doc(ReviewIndex, root.id);
		index.revisions[revision] = { ...index.revisions[revision], adjudication: created };
		return created;
	}, context);
	harness.resume();
	await harness.waitForTask(id, context);
	return readVerdict(harness, root.id, revision, context);
}
