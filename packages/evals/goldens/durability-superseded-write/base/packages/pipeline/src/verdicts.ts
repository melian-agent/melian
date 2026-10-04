import type { Verdict } from "@melian-agent/core";
import { type Context, type ConversationId, type DocumentReader, defineDoc } from "./harness.ts";

// The verdict of each revision, keyed by `<base>..<head>`, on the changeset's root conversation.
export const VerdictDocument = defineDoc<{ revisions: Record<string, Verdict> }>({
	kind: "melian.verdicts",
	version: 1,
	scope: "conversation",
	initial: () => ({ revisions: {} }),
});

/** The verdict recorded for `revision`, or undefined. */
export async function readVerdict(
	reader: DocumentReader,
	root: ConversationId,
	revision: string,
	context: Context,
): Promise<Verdict | undefined> {
	const state = await reader.snapshot(VerdictDocument, root, context);
	return state?.revisions[revision];
}
