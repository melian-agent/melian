import {
	type Finding,
	FindingError,
	type FindingProperties,
	type FindingStatus,
	type FindingTrigger,
	normaliseSnippet,
	parseFinding,
} from "@melian-agent/core";
import { type Context, type ConversationId, defineDoc, type Harness, type Tx } from "./harness.ts";

// Type aliases, not interfaces: a document's value must satisfy Pi's JsonObject, which an interface never does.

// A dismissal that a later revision reopened, kept so the reason is not lost.
type PastDismissal = {
	dismissedBy: string;
	dismissedReason: string;
	dismissedAt: string;
	reopenedRevision: string;
};

type FindingLifecycle = {
	status: FindingStatus;
	dismissedBy?: string;
	dismissedReason?: string;
	dismissedAt?: string;
	firstSeenRevision: string;
	lastSeenRevision: string;
	history: PastDismissal[];
};

/** Who dismissed a finding, why, and when, as an ISO 8601 timestamp the caller supplies so a replay writes the same. */
export interface Dismissal {
	readonly by: string;
	readonly reason: string;
	readonly at: string;
}

type ProducerFinding = Omit<Finding, "properties"> & { properties: Omit<FindingProperties, "status"> };

type FindingRecord = { producer: ProducerFinding; lifecycle: FindingLifecycle };

export const FindingsDocument = defineDoc<{ items: Record<string, FindingRecord> }>({
	kind: "melian.findings",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ items: {} }),
});

function triggerCode(trigger: FindingTrigger | undefined): string {
	return normaliseSnippet(trigger?.snippet ?? "");
}

/**
 * Records a finding as its producer reported it at `revision`, keeping Melian's lifecycle record for its ID.
 *
 * The producer's record replaces any earlier one. The lifecycle starts as `new` when the ID is first seen, and
 * `lastSeenRevision` always moves to `revision`. A dismissed finding stays dismissed unless its trigger's code changed
 * materially, meaning its normalised `trigger.snippet` differs; then it becomes `new` and the dismissal moves to
 * `history`. Reporting the same finding twice stores the same state, so a tool that calls this is safe to replay.
 * Throws core's `FindingError` for an invalid finding, which aborts the transaction.
 */
export async function upsertFinding(
	tx: Tx,
	conversationId: ConversationId,
	finding: Finding,
	revision: string,
): Promise<void> {
	const { status: _, ...properties } = parseFinding(finding).properties;
	const producer: ProducerFinding = { ...finding, properties };
	const { items } = await tx.doc(FindingsDocument, conversationId);
	const previous = items[properties.id];
	if (previous === undefined) {
		const lifecycle: FindingLifecycle = {
			status: "new",
			firstSeenRevision: revision,
			lastSeenRevision: revision,
			history: [],
		};
		items[properties.id] = { producer, lifecycle };
		return;
	}
	const { dismissedBy, dismissedReason, dismissedAt, ...kept } = previous.lifecycle;
	const reopened =
		kept.status === "dismissed" &&
		triggerCode(previous.producer.properties.trigger) !== triggerCode(properties.trigger);
	const lifecycle: FindingLifecycle = reopened
		? {
				...kept,
				status: "new",
				lastSeenRevision: revision,
				history: [
					...kept.history,
					{
						dismissedBy: dismissedBy ?? "",
						dismissedReason: dismissedReason ?? "",
						dismissedAt: dismissedAt ?? "",
						reopenedRevision: revision,
					},
				],
			}
		: { ...previous.lifecycle, lastSeenRevision: revision };
	items[properties.id] = { producer, lifecycle };
}

/** Marks a finding dismissed. Throws core's `FindingError` `unknownFinding` if no finding has the ID. */
export async function dismissFinding(
	tx: Tx,
	conversationId: ConversationId,
	id: string,
	{ by, reason, at }: Dismissal,
): Promise<void> {
	const { items } = await tx.doc(FindingsDocument, conversationId);
	const record = items[id];
	if (record === undefined) {
		throw new FindingError("unknownFinding", `no finding has ID ${id}`, { path: "/properties/id" });
	}
	const lifecycle: FindingLifecycle = {
		...record.lifecycle,
		status: "dismissed",
		dismissedBy: by,
		dismissedReason: reason,
		dismissedAt: at,
	};
	items[id] = { ...record, lifecycle };
}

/**
 * The committed findings of a conversation, in ID order, each with its lifecycle status. Empty when nothing has been
 * reported.
 */
export async function readFindings(
	reader: Pick<Harness, "snapshot">,
	conversationId: ConversationId,
	context: Context,
): Promise<Finding[]> {
	const document = await reader.snapshot(FindingsDocument, conversationId, context);
	return Object.keys(document?.items ?? {})
		.sort()
		.map((id) => {
			const { producer, lifecycle } = document!.items[id]!;
			return { ...producer, properties: { ...producer.properties, status: lifecycle.status } };
		});
}
