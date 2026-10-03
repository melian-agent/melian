import {
	type Finding,
	FindingError,
	type FindingProperties,
	type FindingSource,
	type FindingStatus,
	type FindingTrigger,
	normaliseSnippet,
	parseFinding,
	type Severity,
	strongestCause,
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

type ProducerFinding = Omit<Finding, "properties"> & {
	properties: Omit<FindingProperties, "status" | "reportedBy">;
};

// Sightings are keyed by head commit, then by producer, a lens's check and version. Only the same producer at the same
// head ever rewrites a sighting, so two lenses or two pushes never race for one record.
type FindingRecord = { lifecycle: FindingLifecycle; sightings: Record<string, Record<string, ProducerFinding>> };

// `heads` lists the revisions reviewed, oldest first, so a resumed review of an old head cannot move a lifecycle back.
type FindingsState = { heads: string[]; items: Record<string, FindingRecord> };

export const FindingsDocument = defineDoc<FindingsState>({
	kind: "melian.findings",
	version: 2,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ heads: [], items: {} }),
});

function producerKey(source: FindingSource): string {
	return `${source.check}@${source.version ?? ""}`;
}

// Whether `source` has sighted finding `id` at `head`.
export function hasSighting(state: FindingsState, id: string, head: string, source: FindingSource): boolean {
	return state.items[id]?.sightings[head]?.[producerKey(source)] !== undefined;
}

// How many findings `source` has sighted at `head`.
export function sightingCount(state: FindingsState, head: string, source: FindingSource): number {
	const key = producerKey(source);
	return Object.values(state.items).filter((record) => record.sightings[head]?.[key] !== undefined).length;
}

const severityRank: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareSources(a: FindingSource, b: FindingSource): number {
	return compareText(a.check, b.check) || compareText(a.version ?? "", b.version ?? "");
}

// The highest severity wins, and a tie goes to the producer whose name sorts first, so every reader merges alike. The
// winner takes the strongest cause any sighting gave, with its evidence, so an evidenced P1 beside a P0 without
// evidence reads as an affected P0 rather than a pre-existing one.
function adjudicate(sightings: Readonly<Record<string, ProducerFinding>>) {
	const ranked = Object.values(sightings).sort(
		(a, b) =>
			severityRank[a.properties.severity] - severityRank[b.properties.severity] ||
			compareSources(a.properties.source, b.properties.source),
	);
	const reportedBy = ranked.map((each) => ({ ...each.properties.source })).sort(compareSources);
	const { evidence: _, ...properties } = ranked[0]!.properties;
	const cause = strongestCause(ranked);
	return { winner: { ...ranked[0]!, properties: { ...properties, ...cause } }, reportedBy };
}

/**
 * Marks `revision` as the newest the changeset has been reviewed at, moving it last if it was reviewed before. Call it
 * in the commit that starts a review, so a review of an older head that resumes afterwards counts as older.
 */
export async function recordRevision(tx: Tx, rootConversationId: ConversationId, revision: string): Promise<void> {
	const state = await tx.doc(FindingsDocument, rootConversationId);
	state.heads = [...state.heads.filter((head) => head !== revision), revision];
}

function triggerCode(trigger: FindingTrigger | undefined): string {
	return normaliseSnippet(trigger?.snippet ?? "");
}

/**
 * Records a sighting: the finding as its producer, named by `properties.source`, reported it at `revision`. Keeps
 * Melian's lifecycle record for its ID.
 *
 * Findings belong to the changeset's root conversation, never a lens's child conversation, so a fork of the root at any
 * revision carries them. Pass the root's ID, even from a tool running in a lens.
 *
 * A sighting replaces only the same producer's sighting of the same ID at the same revision, so a replay or a
 * correction rewrites its own report and never another producer's or another revision's. The lifecycle starts as `new`
 * when the ID is first seen, and `lastSeenRevision` moves to `revision` unless {@link recordRevision} marked a newer
 * revision. A dismissed finding stays dismissed unless a sighting at that revision or a newer one has a trigger whose
 * code changed materially, meaning its normalised `trigger.snippet` differs from the last revision's; then it becomes
 * `new` and the dismissal moves to `history`. Reporting the same finding twice stores the same state, so a tool that
 * calls this is safe to replay. Throws core's `FindingError` for an invalid finding, which aborts the transaction.
 */
export async function upsertFinding(
	tx: Tx,
	rootConversationId: ConversationId,
	finding: Finding,
	revision: string,
): Promise<void> {
	const valid = parseFinding(finding);
	const { status: _, reportedBy: __, ...properties } = valid.properties;
	const producer: ProducerFinding = { ...valid, properties };
	const state = await tx.doc(FindingsDocument, rootConversationId);
	if (!state.heads.includes(revision)) state.heads.push(revision);
	const key = producerKey(properties.source);
	const previous = state.items[properties.id];
	if (previous === undefined) {
		const lifecycle: FindingLifecycle = {
			status: "new",
			firstSeenRevision: revision,
			lastSeenRevision: revision,
			history: [],
		};
		state.items[properties.id] = { lifecycle, sightings: { [revision]: { [key]: producer } } };
		return;
	}
	const sightings = { ...previous.sightings, [revision]: { ...previous.sightings[revision], [key]: producer } };
	const last = previous.lifecycle.lastSeenRevision;
	if (state.heads.indexOf(revision) < state.heads.indexOf(last)) {
		state.items[properties.id] = { lifecycle: previous.lifecycle, sightings };
		return;
	}
	const { dismissedBy, dismissedReason, dismissedAt, ...kept } = previous.lifecycle;
	const lastSeen = previous.sightings[last];
	const reopened =
		kept.status === "dismissed" &&
		lastSeen !== undefined &&
		triggerCode(adjudicate(lastSeen).winner.properties.trigger) !== triggerCode(properties.trigger);
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
	state.items[properties.id] = { lifecycle, sightings };
}

/** Marks a finding dismissed. Throws core's `FindingError` `unknownFinding` if no finding has the ID. */
export async function dismissFinding(
	tx: Tx,
	rootConversationId: ConversationId,
	id: string,
	{ by, reason, at }: Dismissal,
): Promise<void> {
	const { items } = await tx.doc(FindingsDocument, rootConversationId);
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

/** Which sightings {@link readFindings} merges. */
export interface ReadFindingsOptions {
	/**
	 * Only these producers' sightings, such as the lenses and versions selected for the review being read. A lens that
	 * configuration has since disabled or retiered then leaves nothing behind. A producer without a version stands for
	 * every version of its check. Every producer when absent.
	 */
	readonly producers?: readonly FindingSource[];
}

/**
 * The findings sighted at `head`, one per ID in ID order, each with its lifecycle status. Where several producers
 * sighted one ID, the highest severity wins and a tie goes to the producer whose check sorts first, and
 * `properties.reportedBy` lists every producer that sighted it. Empty when nothing was reported at `head`. Each is a
 * copy: the harness caches the committed document, so changing a returned finding must not reach it.
 */
export async function readFindings(
	reader: Pick<Harness, "snapshot">,
	rootConversationId: ConversationId,
	head: string,
	context: Context,
	options: ReadFindingsOptions = {},
): Promise<readonly Finding[]> {
	const items = (await reader.snapshot(FindingsDocument, rootConversationId, context))?.items ?? {};
	const wanted = options.producers === undefined ? undefined : new Set(options.producers.map(producerKey));
	// A producer named without a version counts every version of its check, such as a static tool's record that names none.
	const anyVersion = new Set(
		(options.producers ?? []).filter((source) => source.version === undefined).map((source) => source.check),
	);
	const counts = (key: string, sighting: ProducerFinding) =>
		wanted === undefined || wanted.has(key) || anyVersion.has(sighting.properties.source.check);
	return Object.keys(items)
		.sort()
		.flatMap((id) => {
			const { lifecycle, sightings } = items[id]!;
			const atHead = Object.fromEntries(
				Object.entries(sightings[head] ?? {}).filter(([key, sighting]) => counts(key, sighting)),
			);
			if (Object.keys(atHead).length === 0) return [];
			const { winner, reportedBy } = adjudicate(atHead);
			return [
				structuredClone({ ...winner, properties: { ...winner.properties, status: lifecycle.status, reportedBy } }),
			];
		});
}
