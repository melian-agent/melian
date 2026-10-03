import { type Finding, parseFinding } from "@melian-agent/core";
import { type Context, type ConversationId, defineDoc, type Harness, type Tx } from "./harness.ts";

/**
 * The findings reported in a conversation, keyed by stable ID. Rewindable and forked as of the fork point, so a fork
 * taken at a revision's entry sees that revision's findings and nothing reported later.
 */
export const FindingsDocument = defineDoc<{ items: Record<string, Finding> }>({
	kind: "melian.findings",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ items: {} }),
});

/**
 * Stores a finding under its ID in the conversation's findings document, replacing any finding with that ID.
 *
 * Writing the same finding twice stores it once, so a tool that calls this is safe to replay. Throws core's
 * `FindingError` for an invalid finding, which aborts the transaction.
 */
export async function upsertFinding(tx: Tx, conversationId: ConversationId, finding: Finding): Promise<void> {
	const valid = parseFinding(finding);
	(await tx.doc(FindingsDocument, conversationId)).items[valid.properties.id] = valid;
}

/** The committed findings of a conversation, in ID order. Empty when nothing has been reported. */
export async function readFindings(
	reader: Pick<Harness, "snapshot">,
	conversationId: ConversationId,
	context: Context,
): Promise<Finding[]> {
	const document = await reader.snapshot(FindingsDocument, conversationId, context);
	return Object.keys(document?.items ?? {})
		.sort()
		.map((id) => document!.items[id]!);
}
