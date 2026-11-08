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
	stricter,
	type Verification,
	VerificationRecord,
} from "@melian-agent/core";
import { type Context, type ConversationId, type DocumentReader, defineDoc, type Harness, type Tx } from "./harness.ts";

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
	dismissedTrigger?: { hash: string; proof: StoredProvingHunk[] };
	// The severity the verdict showed when the dismissal was made; absent from one made before Melian kept it, which
	// therefore never carries to a restatement.
	dismissedSeverity?: Severity;
	firstSeenRevision: string;
	lastSeenRevision: string;
	history: StoredPastDismissal[];
	proof?: StoredProvingHunk[];
};

/** Who dismissed a finding, why, and when, as an ISO 8601 timestamp the caller supplies so a replay writes the same. */
export type Dismissal = FindingDismissal;

// Status and dismissals are Melian's lifecycle, never a producer's, so a sighting stores none of them.
export type StoredSighting = ProducerFinding;
type ProducerFinding = Omit<StoredFinding, "properties"> & {
	properties: Omit<FindingProperties, "status" | "reportedBy" | "dismissal" | "pastDismissals">;
};

// Sightings are keyed by revision, `Revision.key` of a base and head, then by producer, a lens's check and version. Only
// the same producer at the same revision ever rewrites a sighting, so two lenses or two pushes never race for one record.
type FindingRecord = {
	lifecycle: FindingLifecycle;
	sightings: Record<string, Record<string, ProducerFinding>>;
	verifications?: Record<string, Record<string, Record<string, Verification>>>;
};

// `revisions` lists the revisions reviewed, oldest first, so a resumed review of an old one cannot move a lifecycle back.
// `versions` counts, per revision, the writes that could change what a read of it returns: a sighting there, or a
// lifecycle change of a finding sighted there. Adjudication's input carries it, so a dismissal decides afresh.
// A restatement's link to a root: a finding at one revision inherits the root's dismissal, or names it as a likely
// match. It holds while the root's own dismissal, made at `dismissedAt`, stands.
type StoredInheritance = { from: string; kind: "inherited" | "proposed"; dismissedAt: string };

// `inherited` holds, per revision, each restatement's link, which every review round replaces whole.
type FindingsState = {
	revisions: string[];
	items: Record<string, FindingRecord>;
	versions: Record<string, number>;
	inherited?: Record<string, Record<string, StoredInheritance>>;
};

// Version 11 lets a dismissal record the severity it was made at, and a revision hold the restatements that inherit a
// dismissal or name one as a likely match; a version 10 document holds neither and reads unchanged.
// Version 10 permits each merged claim to retain its reported severity. Version 9 ties dismissals to their accepted
// trigger and proof; version 8 dismissals keep their former reopen rules.
// Version 8 lets a guardrail sighting name the configured rules it matched, or its notice class, outside its ID; a
// version 7 sighting names neither, reads unchanged, and resolves under its whole guardrail.
// Version 7 lets a verification record hold the verifier's answers, the evidence read back, and a lowered severity; a
// version 6 record has none and reads unchanged. Version 6 added the optional per-sighting verification
// records. Version 5 made evidence a list of locations; a sighting stored before reads with its one location as a cause.
export const FindingsDocument = defineDoc<FindingsState>({
	kind: "melian.findings",
	version: 11,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ revisions: [], items: {}, versions: {} }),
	migrate: (value, from) => {
		if (from >= 8) return value as FindingsState;
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

function producerKey(source: FindingSource): string {
	return `${source.check}@${source.version ?? ""}`;
}

// Whether `source` has sighted finding `id` at `revision`.
export function hasSighting(state: FindingsState, id: string, revision: string, source: FindingSource): boolean {
	return state.items[id]?.sightings[revision]?.[producerKey(source)] !== undefined;
}

// A finding as one producer sighted it, as much as escalation reads.
export type SightedFinding = {
	readonly id: string;
	readonly ruleId: string;
	readonly severity: Severity;
	readonly path: string;
	readonly line: number;
	readonly endLine: number;
	readonly message: string;
};

// Each finding `source` has sighted at `revision`, in ID order.
export function sightedBy(state: FindingsState, revision: string, source: FindingSource): SightedFinding[] {
	const key = producerKey(source);
	return Object.keys(state.items)
		.sort()
		.flatMap((id) => {
			const sighting = state.items[id]!.sightings[revision]?.[key];
			if (sighting === undefined) return [];
			const { severity, path } = sighting.properties;
			const region = sighting.locations[0]?.physicalLocation.region;
			const line = region?.startLine ?? 1;
			const endLine = region?.endLine ?? line;
			return [{ id, ruleId: sighting.ruleId, severity, path, line, endLine, message: sighting.message.text }];
		});
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

// The highest severity wins, after any lowering a verifier's record applied, and a tie goes to the producer whose name
// sorts first, so every reader merges alike. The winner names the highest severity any producer reported as its
// original when that differs. The
// winner keeps its own claim and takes the strongest cause any sighting gave, with the cause locations that prove it,
// and every other sighting's claim, so a P1 whose cause location overlaps the change, beside a P0 whose evidence proves
// nothing, reads as an affected P0 that still carries the P1's scenario and evidence.
function adjudicate(sightings: Readonly<Record<string, ProducerFinding>>, judged = false) {
	// A sighting stores no lifecycle status, and merging claims reads none.
	const refuted = (each: ProducerFinding) =>
		judged && Finding.from({ ...each, properties: { ...each.properties, status: "new" } }).refuted();
	// Judged, a refuted sighting never wins while another stands, so it lends the finding neither its severity nor its
	// prose. As reported, no verdict picks the winner, so a repeat review's candidates are the ones verified.
	const ranked = Object.values(sightings).sort(
		(a, b) =>
			Number(refuted(a)) - Number(refuted(b)) ||
			severityRank[a.properties.severity] - severityRank[b.properties.severity] ||
			compareSources(a.properties.source, b.properties.source),
	);
	const reportedBy = ranked.map((each) => ({ ...each.properties.source })).sort(compareSources);
	const { evidence: _, failureScenario: __, otherClaims: ___, ...properties } = ranked[0]!.properties;
	const members = ranked.map((each) => Finding.from({ ...each, properties: { ...each.properties, status: "new" } }));
	const claims = members[0]!.mergeClaims(members);
	// Every sighting counts, refuted or not: the merge orders by it, and a verdict must not regroup.
	const original = members.map((member) => member.original()).reduce(stricter);
	// The winner is the highest after lowering, so its own original, when it has one, is never above this one.
	const lowered = original === properties.severity ? {} : { originalSeverity: original };
	// The finding sits where the sighting the lenses ranked first put it, so no verdict moves its lines and regroups it.
	const [located] = [...members].sort(
		(a, b) =>
			severityRank[a.original()] - severityRank[b.original()] ||
			compareSources(a.properties.source, b.properties.source),
	);
	const { locations } = located!.toJSON();
	return { winner: { ...ranked[0]!, locations, properties: { ...properties, ...lowered, ...claims } }, reportedBy };
}

// Whether a review that selected `producers` counts a sighting, stored under `key`; every sighting when absent.
function selected(producers: readonly Producer[] | undefined) {
	const wanted =
		producers === undefined
			? undefined
			: new Map(producers.map((source) => [producerKey(source), source.ids] as const));
	return (key: string, sighting: ProducerFinding) => {
		if (wanted === undefined) return true;
		return [key, producerKey({ check: sighting.properties.source.check })].some((producer) => {
			if (!wanted.has(producer)) return false;
			const ids = wanted.get(producer);
			return ids === undefined || ids.includes(sighting.properties.id);
		});
	};
}

/**
 * Where the finding `id` sits at `revision` as grouping reads it, among the sightings of `producers`, the review's
 * selection: the site of the sighting the lenses ranked first, or `undefined` when none sighted it there or it has no
 * snippet.
 */
export function siteAt(
	state: FindingsState,
	id: string,
	revision: string,
	producers?: readonly Producer[],
): string | undefined {
	const counts = selected(producers);
	const sightings = Object.fromEntries(
		Object.entries(state.items[id]?.sightings[revision] ?? {}).filter(([key, sighting]) => counts(key, sighting)),
	);
	if (Object.keys(sightings).length === 0) return undefined;
	const { winner } = adjudicate(sightings);
	return Finding.from({ ...winner, properties: { ...winner.properties, status: "new" } }).site();
}

/**
 * Marks `revision` as the newest the changeset has been reviewed at, moving it last if it was reviewed before. Call it
 * in the commit that starts a review, so a review of an older revision that resumes afterwards counts as older.
 * `revision` is a {@link Revision.key}, as every revision this module takes is.
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

function reopenedAt(lifecycle: FindingLifecycle, revision: string): FindingLifecycle {
	const { dismissedBy, dismissedReason, dismissedAt, dismissedTrigger: _, dismissedSeverity: __, ...kept } = lifecycle;
	return {
		...kept,
		status: "new",
		history: [
			...kept.history,
			{
				dismissedBy: dismissedBy ?? "",
				dismissedReason: dismissedReason ?? "",
				dismissedAt: dismissedAt ?? "",
				reopenedRevision: revision,
			},
		],
	};
}

function dismissalChanged(
	lifecycle: FindingLifecycle,
	properties: ProducerFinding["properties"],
	hunks: readonly ProvingHunk[] | undefined,
): boolean {
	const accepted = lifecycle.dismissedTrigger!;
	const proof = unionOf([...accepted.proof, ...(lifecycle.proof ?? [])]);
	return proof.length > 0 && properties.cause !== "introduced"
		? hunks !== undefined &&
				proof.some((each) => !hunks.some((hunk) => hunk.file === each.file && hunk.hash === each.hash))
		: accepted.hash !== triggerCode(properties.trigger);
}

// Attached tasks need no new reports, but their sightings must still meet the content the dismissal accepted.
export async function reopenDismissals(
	tx: Tx,
	root: ConversationId,
	revision: string,
	hunks: readonly ProvingHunk[],
): Promise<void> {
	const state = await tx.doc(FindingsDocument, root);
	for (const [id, record] of Object.entries(state.items)) {
		if (record.lifecycle.status !== "dismissed" || record.lifecycle.dismissedTrigger === undefined) continue;
		for (const sighting of Object.values(record.sightings[revision] ?? {})) {
			if (dismissalChanged(record.lifecycle, sighting.properties, hunks)) {
				record.lifecycle = {
					...reopenedAt(record.lifecycle, revision),
					proof: unionOf(proofOf(sighting.properties.cause, sighting.properties.trigger)),
				};
				bump(state, affectedBy(state, id, record));
				break;
			}
		}
	}
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
 * revision. New dismissals compare every sighting with the trigger they accepted, regardless of revision order.
 * Different content becomes `new` and moves the dismissal to `history`. Legacy dismissals retain their last-seen
 * comparison and ignore older revisions. Hashes compare whole content, falling back to normalised snippets.
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
	// A lowering is the verifier's to record and adjudication's to hold, so a producer's own claim of either is dropped.
	const {
		status: _,
		reportedBy: __,
		dismissal: ___,
		pastDismissals: ____,
		originalSeverity: _____,
		resolvedAtOriginal: ______,
		likelyDismissedAs: _______,
		...properties
	} = valid.properties;
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
	const verifications =
		previous.verifications === undefined
			? undefined
			: { ...previous.verifications, [revision]: { ...previous.verifications[revision] } };
	if (verifications?.[revision] !== undefined) delete verifications[revision]![key];
	const verified = verifications === undefined ? {} : { verifications };
	const last = previous.lifecycle.lastSeenRevision;
	const older = state.revisions.indexOf(revision) < state.revisions.indexOf(last);
	if (older && previous.lifecycle.dismissedTrigger === undefined) {
		state.items[properties.id] = { lifecycle: previous.lifecycle, sightings, ...verified };
		return;
	}
	const { dismissedTrigger, ...kept } = previous.lifecycle;
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
		(dismissedTrigger !== undefined
			? dismissalChanged(previous.lifecycle, properties, hunks)
			: lastSeen !== undefined &&
				(proven
					? standing.length < stored.length
					: triggerCode(adjudicate(lastSeen).winner.properties.trigger) !== triggerCode(properties.trigger)));
	if (reopened) bump(state, affectedBy(state, properties.id, { sightings }));
	const lastSeenRevision = older ? last : revision;
	const proof = unionOf([...(reopened ? [] : standing), ...proved]);
	const tied = proof.length > 0 || kept.proof !== undefined ? { proof } : {};
	const lifecycle: FindingLifecycle = {
		...(reopened ? reopenedAt(previous.lifecycle, revision) : previous.lifecycle),
		lastSeenRevision,
		...tied,
	};
	state.items[properties.id] = { lifecycle, sightings, ...verified };
}

/**
 * Makes `findings` the whole of what `check` sights at `revision`, a {@link Revision.key}: removes the check's earlier sightings there, of any
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
	const reported = new Set(findings.map((finding) => `${finding.id}\0${producerKey(finding.properties.source)}`));
	for (const finding of findings) await upsertFinding(tx, rootConversationId, finding, revision);
	const { items } = state;
	let removed = false;
	for (const [id, record] of Object.entries(items)) {
		const atRevision = record.sightings[revision];
		if (atRevision === undefined) continue;
		const left = Object.fromEntries(
			Object.entries(atRevision).filter(
				([key, sighting]) => sighting.properties.source.check !== check || reported.has(`${id}\0${key}`),
			),
		);
		if (Object.keys(left).length === Object.keys(atRevision).length) continue;
		removed = true;
		const sightings = { ...record.sightings, [revision]: left };
		if (Object.keys(left).length === 0) delete sightings[revision];
		if (Object.keys(sightings).length === 0 && record.lifecycle.status !== "dismissed") delete items[id];
		else items[id] = { ...record, sightings };
	}
	if (removed) bump(state, [revision]);
}

/**
 * Marks a finding dismissed, and returns the dismissal it replaced, if it was dismissed already. A replaced dismissal
 * moves to the finding's history, so its reason is not lost; the same dismisser giving the same reason again changes
 * nothing when the accepted content also matches. The reason is stored without surrounding whitespace.
 * `revision` selects the accepted trigger, defaulting to the last sighting for direct callers.
 * Throws core's `FindingError`: `unknownFinding` if no finding has the ID, and `invalidDismissal` for a blank `by` or
 * `at`, or a reason core's `dismissalReason` refuses.
 */
export async function dismissFinding(
	tx: Tx,
	rootConversationId: ConversationId,
	id: string,
	{ by, reason, at }: Dismissal,
	revision?: string,
	severity?: Severity,
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
	const atRevision = record.sightings[revision ?? record.lifecycle.lastSeenRevision]!;
	const trigger = adjudicate(atRevision).winner.properties.trigger;
	const proof = unionOf([
		...(record.lifecycle.proof ?? []),
		...Object.values(atRevision).flatMap((each) => proofOf(each.properties.cause, each.properties.trigger)),
	]);
	const dismissedTrigger = { hash: triggerCode(trigger), proof };
	// Repeating the same dismissal of the same content adds no history; a severity it now records is kept.
	if (
		status === "dismissed" &&
		dismissedBy === by &&
		dismissedReason === why &&
		JSON.stringify(record.lifecycle.dismissedTrigger) === JSON.stringify(dismissedTrigger)
	) {
		if (severity === undefined || record.lifecycle.dismissedSeverity === severity) return undefined;
		items[id] = { ...record, lifecycle: { ...record.lifecycle, dismissedSeverity: severity } };
		bump(state, affectedBy(state, id, record));
		return undefined;
	}
	const replaced =
		status === "dismissed"
			? { by: dismissedBy ?? "", reason: dismissedReason ?? "", at: dismissedAt ?? "" }
			: undefined;
	const { dismissedSeverity: _, ...previous } = record.lifecycle;
	const lifecycle: FindingLifecycle = {
		...previous,
		dismissedTrigger,
		...(severity === undefined ? {} : { dismissedSeverity: severity }),
		proof,
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
	bump(state, affectedBy(state, id, record));
	return replaced;
}

// Drops every sighting `sources` made at `revision`, in the commit that starts their replacement run, so a verdict reads
// only the run the review index names. Lifecycle records stay, so a dismissal survives the rerun of a finding.
export async function clearSightings(
	tx: Tx,
	rootConversationId: ConversationId,
	revision: string,
	sources: readonly FindingSource[],
): Promise<void> {
	const state = await tx.doc(FindingsDocument, rootConversationId);
	const keys = new Set(sources.map(producerKey));
	let cleared = false;
	for (const [id, record] of Object.entries(state.items)) {
		const atRevision = record.sightings[revision];
		if (atRevision === undefined || !Object.keys(atRevision).some((key) => keys.has(key))) continue;
		const kept = Object.fromEntries(Object.entries(atRevision).filter(([key]) => !keys.has(key)));
		const sightings = { ...record.sightings, [revision]: kept };
		if (Object.keys(kept).length === 0) delete sightings[revision];
		const verifications = {
			...record.verifications,
			[revision]: Object.fromEntries(
				Object.entries(record.verifications?.[revision] ?? {}).filter(([key]) => !keys.has(key)),
			),
		};
		state.items[id] = { ...record, sightings, ...(record.verifications === undefined ? {} : { verifications }) };
		cleared = true;
	}
	if (cleared) bump(state, [revision]);
}

// The revisions a lifecycle change of finding `id` changes a read of: those that sighted it, and those whose
// restatements it is the root of, which lapse or return with it.
function affectedBy(state: FindingsState, id: string, record: Pick<FindingRecord, "sightings">): string[] {
	const inheritors = Object.entries(state.inherited ?? {})
		.filter(([, links]) => Object.values(links).some((link) => link.from === id))
		.map(([revision]) => revision);
	return [...new Set([...Object.keys(record.sightings), ...inheritors])];
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

/** A producer whose sightings a read counts: all of them, or only the findings `ids` names. */
export type Producer = FindingSource & { readonly ids?: readonly string[] };

/** Which sightings {@link readFindings} merges. */
export interface ReadFindingsOptions {
	/**
	 * Only these producers' sightings, such as the lenses and versions selected for the review being read. A lens that
	 * configuration has since disabled or retiered then leaves nothing behind. A producer without a version stands for
	 * every version of its check, and one with `ids` counts only those findings, as a quick run whose escalated run
	 * neither restated nor refuted them. Every producer when absent.
	 */
	readonly producers?: readonly Producer[];
	/**
	 * Read each sighting at the severity its lens reported, with its verification attached and not applied.
	 * Verification picks its candidates from this read, so a lowering it stored never changes what it judges next.
	 */
	readonly asReported?: boolean;
}

/**
 * The findings sighted at `revision`, a {@link Revision.key}, one per ID in ID order, each with its lifecycle status. Where several producers
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
	const state = await reader.snapshot(FindingsDocument, rootConversationId, context);
	const items = state?.items ?? {};
	const inherited = state?.inherited?.[revision] ?? {};
	const counts = selected(options.producers);
	return Object.keys(items)
		.sort()
		.flatMap((id) => {
			const { lifecycle, sightings, verifications } = items[id]!;
			const link = options.asReported === true ? undefined : standing(items, inherited[id], lifecycle);
			const atHead = Object.fromEntries(
				Object.entries(sightings[revision] ?? {})
					.filter(([key, sighting]) => counts(key, sighting))
					.map(([key, sighting]) => {
						const verification = Object.values(verifications?.[revision]?.[key] ?? {}).at(-1);
						if (verification === undefined) return [key, sighting];
						if (options.asReported === true)
							return [key, { ...sighting, properties: { ...sighting.properties, verification } }];
						return [key, judged(sighting, verification)];
					}),
			);
			if (Object.keys(atHead).length === 0) return [];
			const { winner, reportedBy } = adjudicate(atHead, options.asReported !== true);
			const properties = {
				...winner.properties,
				status: link?.kind === "inherited" ? ("dismissed" as const) : lifecycle.status,
				...dismissalsOf(lifecycle),
				...linked(link, items),
				reportedBy,
			};
			return [Finding.from(structuredClone({ ...winner, properties }))];
		});
}

// The link of a finding to its root while it holds: the root's own dismissal still stands as it was made, and the
// finding has no dismissal of its own, which always speaks first.
function standing(
	items: Readonly<Record<string, FindingRecord>>,
	link: StoredInheritance | undefined,
	lifecycle: FindingLifecycle,
): StoredInheritance | undefined {
	if (link === undefined || lifecycle.status === "dismissed") return undefined;
	// A reopen drops the root's `dismissedAt` and a new dismissal replaces it, so either lapses the link.
	return items[link.from]?.lifecycle.dismissedAt === link.dismissedAt ? link : undefined;
}

// An inherited dismissal carries the root's reason and time and never its dismisser; a proposal names the root.
function linked(
	link: StoredInheritance | undefined,
	items: Readonly<Record<string, FindingRecord>>,
): Pick<FindingProperties, "dismissal" | "likelyDismissedAs"> {
	if (link === undefined) return {};
	if (link.kind === "proposed") return { likelyDismissedAs: { id: link.from } };
	const root = items[link.from]!.lifecycle;
	return {
		dismissal: {
			by: inheritedDismisser,
			reason: root.dismissedReason!,
			at: link.dismissedAt,
			inheritedFrom: link.from,
		},
	};
}

/** Who an inherited dismissal names as its dismisser: Melian, never the person who dismissed the root. */
export const inheritedDismisser = "melian";

/** A restatement's link to its root, as {@link replaceInheritances} records it. */
export type Inheritance = StoredInheritance;

/**
 * Makes `links` the whole of `revision`'s restatement links, by finding ID, and bumps the revision's findings version
 * when they changed. Returns whether they did.
 */
export async function replaceInheritances(
	tx: Tx,
	root: ConversationId,
	revision: string,
	links: Readonly<Record<string, Inheritance>>,
): Promise<boolean> {
	const state = await tx.doc(FindingsDocument, root);
	const before = state.inherited?.[revision] ?? {};
	const sorted = Object.fromEntries(
		Object.keys(links)
			.sort()
			.map((id) => [id, { from: links[id]!.from, kind: links[id]!.kind, dismissedAt: links[id]!.dismissedAt }]),
	);
	if (JSON.stringify(before) === JSON.stringify(sorted)) return false;
	const { [revision]: _, ...rest } = state.inherited ?? {};
	state.inherited = Object.keys(sorted).length === 0 ? rest : { ...rest, [revision]: sorted };
	bump(state, [revision]);
	return true;
}

// A sighting as its verifier judged it: at the lowered severity its record holds, by core's `verifiedAs`. The stored
// sighting keeps the lens's own.
function judged(sighting: ProducerFinding, verification: Verification): ProducerFinding {
	const finding = Finding.from({ ...sighting, properties: { ...sighting.properties, status: "new" } });
	const { properties, ...rest } = finding.verifiedAs(verification).toJSON();
	const { status: _, ...kept } = properties;
	return { ...rest, properties: kept };
}

// The sighting `source` stored for finding `id` at `revision`, as the lens reported it.
export function sightingIn(
	state: FindingsState,
	revision: string,
	id: string,
	source: FindingSource,
): StoredSighting | undefined {
	return state.items[id]?.sightings[revision]?.[producerKey(source)];
}

// The IDs of the findings first sighted at a revision other than `revision`: a later revision carries them.
export async function seenBefore(
	reader: Pick<Harness, "snapshot">,
	root: ConversationId,
	revision: string,
	context: Context,
): Promise<string[]> {
	const items = (await reader.snapshot(FindingsDocument, root, context))?.items ?? {};
	return Object.keys(items)
		.sort()
		.filter((id) => items[id]!.lifecycle.firstSeenRevision !== revision);
}

export async function clearVerifications(tx: Tx, root: ConversationId, revision: string): Promise<void> {
	const state = await tx.doc(FindingsDocument, root);
	let cleared = false;
	for (const record of Object.values(state.items)) {
		if (record.verifications?.[revision] === undefined) continue;
		delete record.verifications[revision];
		cleared = true;
	}
	if (cleared) bump(state, [revision]);
}

// Returns the record the claim holds once `verification` has met any stored one, which may be the stored one.
export async function upsertVerification(
	tx: Tx,
	root: ConversationId,
	revision: string,
	id: string,
	source: FindingSource,
	verification: Verification,
): Promise<Verification> {
	const state = await tx.doc(FindingsDocument, root);
	const record = state.items[id];
	const producer = producerKey(source);
	if (record?.sightings[revision]?.[producer] === undefined) throw new Error("the claim no longer has a sighting");
	const before = record.verifications?.[revision]?.[producer] ?? {};
	const previous = before[verification.version];
	// Runs in the report's commit, replay included, so a later equal report never weakens a stored one.
	const kept = new VerificationRecord(previous).after(verification);
	if (JSON.stringify(previous) === JSON.stringify(kept)) return kept;
	const { [verification.version]: _, ...rest } = before;
	record.verifications = {
		...record.verifications,
		[revision]: {
			...record.verifications?.[revision],
			[producer]: { ...rest, [verification.version]: kept },
		},
	};
	bump(state, [revision]);
	return kept;
}

export async function sightingVerification(
	reader: DocumentReader,
	root: ConversationId,
	revision: string,
	id: string,
	source: FindingSource,
	version: string,
	context: Context,
): Promise<Verification | undefined> {
	return (await reader.snapshot(FindingsDocument, root, context))?.items[id]?.verifications?.[revision]?.[
		producerKey(source)
	]?.[version];
}

// Whether two sightings of one rule in one file overlap, as a restatement of a defect worded afresh does: a run that
// cites other lines of it hashes another snippet, and so another ID.
export function overlapsSite(
	a: Pick<SightedFinding, "path" | "ruleId" | "line" | "endLine">,
	b: Pick<SightedFinding, "path" | "ruleId" | "line" | "endLine">,
): boolean {
	return a.path === b.path && a.ruleId === b.ruleId && a.line <= b.endLine && b.line <= a.endLine;
}

/**
 * A dismissal a restatement may inherit: a maintainer's, which recorded the severity it was made at and the content it
 * accepted, with the finding as its last sighting showed it.
 */
export type DismissedRoot = {
	readonly id: string;
	readonly ruleId: string;
	readonly path: string;
	readonly cause: Cause;
	readonly line: number;
	readonly endLine: number;
	// The revision that last sighted it, whose head its region is read at.
	readonly revision: string;
	readonly dismissedAt: string;
	readonly severity: Severity;
	// The accepted trigger's hash and proof, and that proof with every proof sighted since, which its reopen rule reads.
	readonly hash: string;
	readonly accepted: readonly ProvingHunk[];
	readonly proof: readonly ProvingHunk[];
	readonly failureScenario?: string;
	readonly evidence?: FindingProperties["evidence"];
};

// Every finding a maintainer dismissed with a recorded severity and accepted content, in ID order. An inherited
// dismissal lives only in a revision's links, never in a lifecycle, so none of these is one.
export function dismissedRoots(state: FindingsState): DismissedRoot[] {
	return Object.keys(state.items)
		.sort()
		.flatMap((id) => {
			const { lifecycle, sightings } = state.items[id]!;
			const { status, dismissedSeverity, dismissedTrigger, dismissedAt, lastSeenRevision } = lifecycle;
			// A cleared run can leave the last-seen revision with no sighting, and then no region to map.
			const last = sightings[lastSeenRevision];
			if (status !== "dismissed" || dismissedSeverity === undefined || last === undefined) return [];
			const { winner } = adjudicate(last);
			const finding = Finding.from({ ...winner, properties: { ...winner.properties, status: "new" } });
			const [line, endLine] = finding.lines();
			const { failureScenario, evidence } = finding.properties;
			return [
				{
					id,
					ruleId: finding.ruleId,
					path: finding.properties.path,
					cause: finding.properties.cause,
					line,
					endLine,
					revision: lastSeenRevision,
					// `dismissFinding` records a severity only beside the time and the accepted trigger.
					dismissedAt: dismissedAt!,
					severity: dismissedSeverity,
					hash: dismissedTrigger!.hash,
					accepted: unionOf(dismissedTrigger!.proof),
					proof: unionOf([...dismissedTrigger!.proof, ...(lifecycle.proof ?? [])]),
					...(failureScenario === undefined ? {} : { failureScenario }),
					...(evidence === undefined ? {} : { evidence: structuredClone(evidence) }),
				},
			];
		});
}

// The hunks the sightings of `ids` at `revision` proved, each once.
export function proofAt(state: FindingsState, ids: readonly string[], revision: string): ProvingHunk[] {
	return unionOf(
		ids.flatMap((id) =>
			Object.values(state.items[id]?.sightings[revision] ?? {}).flatMap((each) =>
				proofOf(each.properties.cause, each.properties.trigger),
			),
		),
	);
}

/** One candidate's restatement, as {@link recordInheritances} reads it. */
export type Restating = {
	// Every finding ID merged into the defect, each of which takes the link.
	readonly members: readonly string[];
	// The lens claims merged into it, each of which must be judged the same.
	readonly claims: readonly { readonly id: string; readonly source: FindingSource; readonly ruleId: string }[];
	// The roots the verifier was asked about.
	readonly dismissed: readonly string[];
};

// Claims the trust floor protects: the verifier alone must not silence them, so a match only proposes.
function floored(claim: Restating["claims"][number]): boolean {
	return (
		claim.source.check === "lens.trust-boundary" ||
		claim.source.check === "lens.tests" ||
		claim.ruleId === "untested-behaviour"
	);
}

/**
 * Replaces `revision`'s whole set of restatement links from the judgements `version` of the verifier stored there. A
 * root is a match only when every claim's record answers `same` for it. A match whose highest reported severity, before
 * any lowering, exceeds the root's recorded severity, or that holds a trust-floor claim, proposes rather than inherits.
 * Among matches the latest dismissal wins, and every member of the defect takes its link. Returns whether the links
 * changed, which bumps the revision's findings version.
 */
export async function recordInheritances(
	tx: Tx,
	root: ConversationId,
	revision: string,
	restating: readonly Restating[],
	version: string,
): Promise<boolean> {
	const state = await tx.doc(FindingsDocument, root);
	const links: Record<string, Inheritance> = {};
	for (const { members, claims, dismissed } of restating) {
		if (claims.length === 0) continue;
		const matches = dismissed.flatMap((from) => {
			const lifecycle = state.items[from]?.lifecycle;
			if (lifecycle?.status !== "dismissed" || lifecycle.dismissedSeverity === undefined) return [];
			if (lifecycle.dismissedAt === undefined) return [];
			const same = claims.every(
				(claim) =>
					state.items[claim.id]?.verifications?.[revision]?.[producerKey(claim.source)]?.[version]?.matches?.[
						from
					] === "same",
			);
			if (!same) return [];
			// The highest any lens reported, before a verifier lowered it: a stored sighting keeps the lens's own.
			const reported = claims
				.flatMap((claim) => sightingIn(state, revision, claim.id, claim.source)?.properties.severity ?? [])
				.reduce<Severity>(stricter, "nit");
			const fenced = severityRank[reported] < severityRank[lifecycle.dismissedSeverity];
			const kind: Inheritance["kind"] = fenced || claims.some(floored) ? "proposed" : "inherited";
			return [{ from, kind, dismissedAt: lifecycle.dismissedAt }];
		});
		const [latest] = matches.sort((a, b) => compareText(b.dismissedAt, a.dismissedAt) || compareText(a.from, b.from));
		if (latest === undefined) continue;
		for (const member of members) links[member] = latest;
	}
	return replaceInheritances(tx, root, revision, links);
}
