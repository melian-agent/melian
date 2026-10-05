import {
	type Cause,
	dismissalReason,
	Finding,
	type FindingDismissal,
	FindingError,
	type FindingProperties,
	type FindingSource,
	type FindingStatus,
	type FindingTrigger,
	type PastDismissal,
	type ProvingHunk,
	type Severity,
	type StoredFinding,
	snippetHash,
} from "@melian-agent/core";
import { type Context, type ConversationId, defineDoc, type Harness, type Tx } from "./harness.ts";

// Type aliases, not interfaces: a document's value must satisfy Pi's JsonObject, which an interface never does.

// A dismissal that no longer stands, kept so the reason is not lost: a later revision reopened it, or a later dismissal
// replaced it. An entry from before re-dismissal kept history names only the revision that reopened it.
type StoredPastDismissal = {
	dismissedBy: string;
	dismissedReason: string;
	dismissedAt: string;
	reopenedRevision?: string;
	replacedAt?: string;
};

// A hunk that proves an affected finding's cause, as core's `ProvingHunk`.
type StoredProvingHunk = { file: string; hash: string };

// `proof` is the union of the hunks every affected sighting since the lifecycle last reopened has proved, less any
// changed since; absent from a record stored before Melian kept it, and from one never sighted as affected.
type FindingLifecycle = {
	status: FindingStatus;
	dismissedBy?: string;
	dismissedReason?: string;
	dismissedAt?: string;
	firstSeenRevision: string;
	lastSeenRevision: string;
	history: StoredPastDismissal[];
	proof?: StoredProvingHunk[];
};

/** Who dismissed a finding, why, and when, as an ISO 8601 timestamp the caller supplies so a replay writes the same. */
export type Dismissal = FindingDismissal;

// Status and dismissals are Melian's lifecycle, never a producer's, so a sighting stores none of them.
type ProducerFinding = Omit<StoredFinding, "properties"> & {
	properties: Omit<FindingProperties, "status" | "reportedBy" | "dismissal" | "pastDismissals">;
};

// Sightings are keyed by revision, `revisionKey` of a base and head, then by producer, a lens's check and version. Only
// the same producer at the same revision ever rewrites a sighting, so two lenses or two pushes never race for one record.
type FindingRecord = { lifecycle: FindingLifecycle; sightings: Record<string, Record<string, ProducerFinding>> };

// `revisions` lists the revisions reviewed, oldest first, so a resumed review of an old one cannot move a lifecycle back.
// `versions` counts, per revision, the writes that could change what a read of it returns: a sighting there, or a
// lifecycle change of a finding sighted there. Adjudication's input carries it, so a dismissal decides afresh.
type FindingsState = { revisions: string[]; items: Record<string, FindingRecord>; versions: Record<string, number> };

// Version 5 made evidence a list of locations; a sighting stored before reads with its one location as a cause.
export const FindingsDocument = defineDoc<FindingsState>({
	kind: "melian.findings",
	version: 5,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ revisions: [], items: {}, versions: {} }),
	migrate: (value, from) => {
		if (from < 4)
			throw new Error(`the findings document needs migrating from version ${from}, which Melian cannot do`);
		const state = value as FindingsState;
		const items = Object.fromEntries(
			Object.entries(state.items).map(([id, record]) => {
				const sightings = Object.fromEntries(
					Object.entries(record.sightings).map(([revision, byProducer]) => [
						revision,
						Object.fromEntries(
							Object.entries(byProducer).map(([producer, sighting]) => [producer, Finding.upgrade(sighting)]),
						),
					]),
				);
				return [id, { ...record, sightings }];
			}),
		);
		return { ...state, items };
	},
});

/**
 * The key a reviewed revision is stored under in the findings, verdict, and review index documents: its base and head
 * as `<base>..<head>`. A pull request retargeted onto a new base keeps its head but has another diff, so it is another
 * revision, reviewed afresh.
 */
export function revisionKey(revision: { readonly base: string; readonly head: string }): string {
	return `${revision.base}..${revision.head}`;
}

function producerKey(source: FindingSource): string {
	return `${source.check}@${source.version ?? ""}`;
}

// Whether `source` has sighted finding `id` at `revision`.
export function hasSighting(state: FindingsState, id: string, revision: string, source: FindingSource): boolean {
	return state.items[id]?.sightings[revision]?.[producerKey(source)] !== undefined;
}

// How many findings `source` has sighted at `revision`.
export function sightingCount(state: FindingsState, revision: string, source: FindingSource): number {
	const key = producerKey(source);
	return Object.values(state.items).filter((record) => record.sightings[revision]?.[key] !== undefined).length;
}

const severityRank: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareSources(a: FindingSource, b: FindingSource): number {
	return compareText(a.check, b.check) || compareText(a.version ?? "", b.version ?? "");
}

// The highest severity wins, and a tie goes to the producer whose name sorts first, so every reader merges alike. The
// winner keeps its own claim and takes the strongest cause any sighting gave, with the cause locations that prove it,
// and every other sighting's claim, so a P1 whose cause location overlaps the change, beside a P0 whose evidence proves
// nothing, reads as an affected P0 that still carries the P1's scenario and evidence.
function adjudicate(sightings: Readonly<Record<string, ProducerFinding>>) {
	const ranked = Object.values(sightings).sort(
		(a, b) =>
			severityRank[a.properties.severity] - severityRank[b.properties.severity] ||
			compareSources(a.properties.source, b.properties.source),
	);
	const reportedBy = ranked.map((each) => ({ ...each.properties.source })).sort(compareSources);
	const { evidence: _, failureScenario: __, otherClaims: ___, ...properties } = ranked[0]!.properties;
	// A sighting stores no lifecycle status, and merging claims reads none.
	const members = ranked.map((each) => Finding.from({ ...each, properties: { ...each.properties, status: "new" } }));
	const claims = members[0]!.mergeClaims(members);
	return { winner: { ...ranked[0]!, properties: { ...properties, ...claims } }, reportedBy };
}

/**
 * Marks `revision` as the newest the changeset has been reviewed at, moving it last if it was reviewed before. Call it
 * in the commit that starts a review, so a review of an older revision that resumes afterwards counts as older.
 * `revision` is a {@link revisionKey}, as every revision this module takes is.
 */
export async function recordRevision(tx: Tx, rootConversationId: ConversationId, revision: string): Promise<void> {
	const state = await tx.doc(FindingsDocument, rootConversationId);
	state.revisions = [...state.revisions.filter((each) => each !== revision), revision];
}

// A trigger stored before snippets were cut has no hash, but its snippet is the whole code.
function triggerCode(trigger: FindingTrigger | undefined): string {
	return trigger?.hash ?? snippetHash(trigger?.snippet ?? "");
}

// The hunks an affected sighting proved. One stored before triggers kept a proof names a single hunk by its hash.
function proofOf(cause: Cause, trigger: FindingTrigger | undefined): StoredProvingHunk[] {
	if (cause !== "affected" || trigger === undefined) return [];
	return trigger.proof?.map((hunk) => ({ ...hunk })) ?? [{ file: trigger.file, hash: triggerCode(trigger) }];
}

// The hunks in `proof`, each once, by file then hash, so a union stores the same whatever order it was built in.
function unionOf(proof: readonly StoredProvingHunk[]): StoredProvingHunk[] {
	const byKey = new Map(proof.map((hunk) => [`${hunk.file}\0${hunk.hash}`, hunk]));
	return [...byKey.keys()].sort(compareText).map((key) => ({ ...byKey.get(key)! }));
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
 * code changed materially, meaning its `trigger.hash`, or the hash of its normalised `trigger.snippet` when it has none,
 * differs from the last revision's; then it becomes `new` and the dismissal moves to `history`.
 *
 * An `affected` finding is tied instead to the hunks that proved its cause: the union of every `trigger.proof` its
 * sightings gave since it last reopened, so a lens citing one more cause adds to the proof rather than replacing it.
 * Sighted again as anything but `introduced`, a dismissed finding with such a proof reopens only when a hunk in it has
 * no hunk of equal content in the same file among `hunks`, the hunks of `revision`, never because the lens cited more
 * or fewer of them. A hunk that changed leaves the proof. `hunks` is required with a sighting that has a proof.
 *
 * Reporting the same finding twice stores the same state, so a tool that calls this is safe to replay. Throws core's
 * `FindingError` for an invalid finding, which aborts the transaction.
 */
export async function upsertFinding(
	tx: Tx,
	rootConversationId: ConversationId,
	finding: Finding,
	revision: string,
	hunks?: readonly ProvingHunk[],
): Promise<void> {
	const valid = Finding.parse(finding).toJSON();
	const { status: _, reportedBy: __, dismissal: ___, pastDismissals: ____, ...properties } = valid.properties;
	const producer: ProducerFinding = { ...valid, properties };
	const proved = proofOf(properties.cause, properties.trigger);
	if (proved.length > 0 && hunks === undefined) {
		throw new Error(`recording affected finding ${properties.id} needs the hunks of revision ${revision}`);
	}
	const state = await tx.doc(FindingsDocument, rootConversationId);
	if (!state.revisions.includes(revision)) state.revisions.push(revision);
	bump(state, [revision]);
	const key = producerKey(properties.source);
	const previous = state.items[properties.id];
	if (previous === undefined) {
		const lifecycle: FindingLifecycle = {
			status: "new",
			firstSeenRevision: revision,
			lastSeenRevision: revision,
			history: [],
			...(proved.length === 0 ? {} : { proof: unionOf(proved) }),
		};
		state.items[properties.id] = { lifecycle, sightings: { [revision]: { [key]: producer } } };
		return;
	}
	const sightings = { ...previous.sightings, [revision]: { ...previous.sightings[revision], [key]: producer } };
	const last = previous.lifecycle.lastSeenRevision;
	if (state.revisions.indexOf(revision) < state.revisions.indexOf(last)) {
		state.items[properties.id] = { lifecycle: previous.lifecycle, sightings };
		return;
	}
	const { dismissedBy, dismissedReason, dismissedAt, ...kept } = previous.lifecycle;
	const lastSeen = previous.sightings[last];
	const stored =
		kept.proof ??
		unionOf(Object.values(lastSeen ?? {}).flatMap((each) => proofOf(each.properties.cause, each.properties.trigger)));
	const standing =
		hunks === undefined
			? stored
			: stored.filter((each) => hunks.some((hunk) => hunk.file === each.file && hunk.hash === each.hash));
	// A lens that cites no proving cause this time makes the finding pre-existing, which is no change to the code.
	const proven = stored.length > 0 && properties.cause !== "introduced";
	const reopened =
		kept.status === "dismissed" &&
		lastSeen !== undefined &&
		(proven
			? standing.length < stored.length
			: triggerCode(adjudicate(lastSeen).winner.properties.trigger) !== triggerCode(properties.trigger));
	const proof = unionOf([...(reopened ? [] : standing), ...proved]);
	const tied = proof.length > 0 || kept.proof !== undefined ? { proof } : {};
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
				...tied,
			}
		: { ...previous.lifecycle, lastSeenRevision: revision, ...tied };
	state.items[properties.id] = { lifecycle, sightings };
}

/**
 * Makes `findings` the whole of what `check` sights at `revision`, a {@link revisionKey}: removes the check's earlier sightings there, of any
 * version, then upserts each. A finding left with no sighting at any revision is removed too, unless it was dismissed,
 * so its dismissal survives if it returns. Call it in the commit that records the check's outcome, with no findings for
 * a check that failed, so a failed rerun leaves nothing of an earlier run behind.
 */
export async function replaceCheckFindings(
	tx: Tx,
	rootConversationId: ConversationId,
	check: string,
	revision: string,
	findings: readonly Finding[],
): Promise<void> {
	const state = await tx.doc(FindingsDocument, rootConversationId);
	const { items } = state;
	let removed = false;
	for (const [id, record] of Object.entries(items)) {
		const atRevision = record.sightings[revision];
		if (atRevision === undefined) continue;
		const left = Object.fromEntries(
			Object.entries(atRevision).filter(([, sighting]) => sighting.properties.source.check !== check),
		);
		if (Object.keys(left).length === Object.keys(atRevision).length) continue;
		removed = true;
		const sightings = { ...record.sightings, [revision]: left };
		if (Object.keys(left).length === 0) delete sightings[revision];
		if (Object.keys(sightings).length === 0 && record.lifecycle.status !== "dismissed") delete items[id];
		else items[id] = { ...record, sightings };
	}
	if (removed) bump(state, [revision]);
	for (const finding of findings) await upsertFinding(tx, rootConversationId, finding, revision);
}

/**
 * Marks a finding dismissed, and returns the dismissal it replaced, if it was dismissed already. A replaced dismissal
 * moves to the finding's history, so its reason is not lost; the same dismisser giving the same reason again changes
 * nothing. The reason is stored without surrounding whitespace.
 * Throws core's `FindingError`: `unknownFinding` if no finding has the ID, and `invalidDismissal` for a blank `by` or
 * `at`, or a reason core's `dismissalReason` refuses.
 */
export async function dismissFinding(
	tx: Tx,
	rootConversationId: ConversationId,
	id: string,
	{ by, reason, at }: Dismissal,
): Promise<Dismissal | undefined> {
	const why = dismissalReason(reason);
	for (const [field, value] of [
		["by", by],
		["at", at],
	] as const) {
		if (value.trim() === "") {
			throw new FindingError("invalidDismissal", `a dismissal needs ${field === "by" ? "a dismisser" : "a time"}`, {
				path: `/properties/dismissal/${field}`,
			});
		}
	}
	const state = await tx.doc(FindingsDocument, rootConversationId);
	const { items } = state;
	const record = items[id];
	if (record === undefined) {
		throw new FindingError("unknownFinding", `no finding has ID ${id}`, { path: "/properties/id" });
	}
	const { status, dismissedBy, dismissedReason, dismissedAt, history } = record.lifecycle;
	// The same dismisser giving the same reason again changes nothing, so a retried dismiss adds no history.
	if (status === "dismissed" && dismissedBy === by && dismissedReason === why) return undefined;
	const replaced =
		status === "dismissed"
			? { by: dismissedBy ?? "", reason: dismissedReason ?? "", at: dismissedAt ?? "" }
			: undefined;
	const lifecycle: FindingLifecycle = {
		...record.lifecycle,
		status: "dismissed",
		dismissedBy: by,
		dismissedReason: why,
		dismissedAt: at,
		history:
			replaced === undefined
				? history
				: [
						...history,
						{
							dismissedBy: replaced.by,
							dismissedReason: replaced.reason,
							dismissedAt: replaced.at,
							replacedAt: at,
						},
					],
	};
	items[id] = { ...record, lifecycle };
	bump(state, Object.keys(record.sightings));
	return replaced;
}

function bump(state: FindingsState, revisions: readonly string[]): void {
	state.versions = {
		...state.versions,
		...Object.fromEntries(revisions.map((revision) => [revision, (state.versions[revision] ?? 0) + 1])),
	};
}

// How many writes have changed what a read of `revision` returns, so a repeat review can tell a finished adjudication
// that read the same findings from one that read older ones.
export async function findingsVersion(
	reader: Pick<Harness, "snapshot">,
	rootConversationId: ConversationId,
	revision: string,
	context: Context,
): Promise<number> {
	return (await reader.snapshot(FindingsDocument, rootConversationId, context))?.versions[revision] ?? 0;
}

// The lifecycle's dismissal, while it stands, and the dismissals before it, as a finding carries them.
function dismissalsOf(lifecycle: FindingLifecycle): Pick<FindingProperties, "dismissal" | "pastDismissals"> {
	const { status, dismissedBy, dismissedReason, dismissedAt, history } = lifecycle;
	const past = history.map(
		({ dismissedBy: by, dismissedReason: reason, dismissedAt: at, reopenedRevision, replacedAt }): PastDismissal => ({
			by,
			reason,
			at,
			...(reopenedRevision === undefined ? {} : { reopenedRevision }),
			...(replacedAt === undefined ? {} : { replacedAt }),
		}),
	);
	return {
		...(status === "dismissed"
			? { dismissal: { by: dismissedBy ?? "", reason: dismissedReason ?? "", at: dismissedAt ?? "" } }
			: {}),
		...(past.length === 0 ? {} : { pastDismissals: past }),
	};
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
 * The findings sighted at `revision`, a {@link revisionKey}, one per ID in ID order, each with its lifecycle status. Where several producers
 * sighted one ID, the highest severity wins and a tie goes to the producer whose check sorts first, and
 * `properties.reportedBy` lists every producer that sighted it. Empty when nothing was reported at `revision`. Each is a
 * copy: the harness caches the committed document, so changing a returned finding must not reach it.
 */
export async function readFindings(
	reader: Pick<Harness, "snapshot">,
	rootConversationId: ConversationId,
	revision: string,
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
				Object.entries(sightings[revision] ?? {}).filter(([key, sighting]) => counts(key, sighting)),
			);
			if (Object.keys(atHead).length === 0) return [];
			const { winner, reportedBy } = adjudicate(atHead);
			const properties = { ...winner.properties, status: lifecycle.status, ...dismissalsOf(lifecycle), reportedBy };
			return [Finding.from(structuredClone({ ...winner, properties }))];
		});
}
