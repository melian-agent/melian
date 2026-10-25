import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type Changeset,
	CoverageRecord,
	dismissalVersion,
	Finding,
	type FindingDismissal,
	type LedgerHistory,
	LedgerRefusal,
	type LedgerRound,
	type Placement,
	type PostedLedger,
	type PostedReview,
	type PublishedBy,
	type PublishedCoverage,
	type PublishedMarkers,
	type PullRequest,
	type ReviewProvider,
	type ReviewStatus,
	Revision,
	replyKey,
	type StoredFinding,
	type StoredVerdict,
	Verdict,
} from "@melian-agent/core";
import { VerdictDocument, type VerdictProvenance } from "./adjudication.ts";
import { CoverageDocument, GapDismissalDocument } from "./coverage-ledger.ts";
import { PublishError } from "./errors.ts";
import { FindingsDocument } from "./findings.ts";
import {
	backgroundContext,
	type Context,
	type ConversationId,
	createRegistry,
	type DocumentReader,
	defineDoc,
	defineExtension,
	defineTask,
	type Harness,
	openHarness,
	type Storage,
	type TaskId,
	type Tx,
} from "./harness.ts";
import { modelsOf, type ReviewModels } from "./models.ts";
import { ReviewIndex } from "./review-index.ts";
import { legacyKey, RoundsDocument, RoundWriter } from "./rounds.ts";
import { TaskTiming } from "./task-timing.ts";

// Type aliases with mutable arrays, not core's interfaces: a document's value must satisfy Pi's JsonObject.
// `dismissal` is set on a finding resolved because someone dismissed it, so its reply says why.
type PublishedEntry = {
	ruleId: string;
	path: string;
	line: number;
	revision: string;
	thread?: string;
	dismissal?: { by: string; reason: string; at: string };
	addressedIn?: string;
};

type ResolvedEntry = PublishedEntry & { id: string };

// What one round of a revision will post, committed before posting so a rerun posts exactly this: the verdict it
// renders as well as its findings, since the head's verdict can change before a failed round is posted again.
type PendingRound = {
	// The `Revision.key` of the review the round publishes: a retarget keeps the head and changes it.
	revision: string;
	// The round's number at the head, from the head's `rounds`, which only grows. Its review's marker carries it.
	round: number;
	fingerprint: string;
	verdict: StoredVerdict;
	post: { finding: StoredFinding; placement: Placement }[];
	stillOpen: number;
	open: Record<string, PublishedEntry>;
	resolved: Record<string, ResolvedEntry>;
	// How many times the provider refused to post it.
	refusals: number;
	ledger?: LedgerRound;
};

// A round the provider refused `maxRefusals` times. It is dropped so the next publish of the head plans afresh.
type AbandonedRound = { fingerprint: string; refusals: number; error: string };

const maxRefusals = 3;

type StoredRevision = {
	publishedBy?: PublishedBy;
	// One review per verdict published at this head: a second review of the same head can change the verdict.
	reviews: string[];
	// The fingerprint of the verdict the last review posted, and the `Revision.key` of the review that verdict is of. A
	// retarget keeps the head, so a fingerprint alone matches an identical verdict of another base. An older Melian
	// recorded no revision.
	verdict?: string;
	verdictRevision?: string;
	// How many rounds were ever planned at this head, so each round has a number of its own.
	rounds?: number;
	pending?: PendingRound;
	abandoned?: AbandonedRound[];
	open: Record<string, PublishedEntry>;
	resolved: Record<string, ResolvedEntry>;
	// Each reply by `replyKey` of the finding, its thread, and the dismissal it gave, if any; null when the thread was
	// gone and there was nothing to reply to.
	replies: Record<string, string | null>;
	threadResolutions?: Record<string, true>;
	status?: { state: ReviewStatus["state"]; description: string };
	ledgerUrl?: string;
};

// The ledger shows this many rounds, newest last; older ones fall off so the stored history stays bounded.
const maxLedgerRounds = 50;

type StoredPublishedState = {
	order: string[];
	revisions: Record<string, StoredRevision>;
	ledgerRounds?: (LedgerRound | LedgerHistory)[];
};

function unpublished(): StoredRevision {
	return { reviews: [], open: {}, resolved: {}, replies: {} };
}

// The key a reply to `entry`, resolved or dismissed, is recorded under.
function replyKeyOf(id: string, entry: PublishedEntry & { thread: string }): string {
	return replyKey(id, entry.thread, entry.dismissal === undefined ? undefined : dismissalVersion(entry.dismissal));
}

// A round left pending before evidence became a list, with each finding in the current shape.
function upgradePending(pending: PendingRound): PendingRound {
	const post = pending.post.map((each) => ({ ...each, finding: Finding.upgrade(each.finding) }));
	return { ...pending, verdict: Verdict.upgrade(pending.verdict), post };
}

// A reply recorded by its finding's ID alone, keyed as the reply to the entry its head resolved.
function rekeyReplies(record: StoredRevision): StoredRevision {
	const replies = Object.fromEntries(
		Object.entries(record.replies).map(([id, reply]) => {
			const entry = record.resolved[id];
			return [entry?.thread === undefined ? id : replyKeyOf(id, { ...entry, thread: entry.thread }), reply];
		}),
	);
	return { ...record, replies };
}

function resolutionKey(entry: ResolvedEntry): string {
	return entry.thread === undefined ? entry.id : replyKeyOf(entry.id, { ...entry, thread: entry.thread });
}

function upgradeResolutions(entries: Record<string, PublishedEntry>): Record<string, ResolvedEntry> {
	return Object.fromEntries(
		Object.entries(entries).map(([id, entry]) => {
			const resolved = { ...entry, id };
			return [resolutionKey(resolved), resolved];
		}),
	);
}

class PublishedState {
	readonly stored: StoredPublishedState;

	constructor(stored: StoredPublishedState) {
		this.stored = stored;
	}

	retire(open: Record<string, PublishedEntry>): void {
		const assigned = new Set(Object.values(open).map((entry) => entry.thread));
		for (const record of Object.values(this.stored.revisions)) {
			for (const [id, entry] of Object.entries(record.resolved)) {
				if (entry.thread !== undefined && assigned.has(entry.thread)) delete record.resolved[id];
			}
		}
	}

	static upgrade(value: unknown, from: number): StoredPublishedState {
		const state = value as StoredPublishedState;
		const revisions = Object.fromEntries(
			Object.entries(state.revisions).map(([head, record]): [string, StoredRevision] => {
				const { pending } = record;
				const upgraded =
					pending === undefined || from >= 2 ? record : { ...record, pending: upgradePending(pending) };
				return [
					head,
					{
						...(from >= 3 ? upgraded : rekeyReplies(upgraded)),
						resolved: upgradeResolutions(upgraded.resolved),
						...(upgraded.pending === undefined
							? {}
							: {
									pending: {
										...upgraded.pending,
										resolved: upgradeResolutions(upgraded.pending.resolved),
									},
								}),
						publishedBy: upgraded.publishedBy ?? { trustedWriters: true },
					},
				];
			}),
		);
		const ledgerRounds = state.ledgerRounds?.map((round, index, rounds) =>
			index === rounds.length - 1 || !("verdict" in round)
				? "verdict" in round
					? { ...round, publishedBy: round.publishedBy ?? { trustedWriters: true } }
					: round
				: { base: round.base, head: round.head, round: round.round, status: round.verdict.status },
		);
		return new PublishedState({
			...state,
			revisions,
			...(ledgerRounds === undefined ? {} : { ledgerRounds }),
		}).toJSON();
	}

	toJSON(): StoredPublishedState {
		return this.stored;
	}
}

// Keeps its latest value and forks as it stands: a post is a fact about the pull request, and a fork that forgot one
// would post it twice.
export const PublishedDocument = defineDoc<StoredPublishedState>({
	kind: "melian.published",
	version: 10,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => new PublishedState({ order: [], revisions: {} }).toJSON(),
	// Version 2 made a finding's evidence a list of locations, so a round left pending before it renders. Version 3 keys
	// each reply by `replyKey`. Version 4 adds ledger snapshots; version 5 retains only one-line older rounds.
	// Version 6 adds optional standards paths per lens; version 7 records the publisher. Version 8 permits trust-floor
	// diagnostics; version 9 keys resolutions by thread. Version 10 adds each ledger round's coverage, which an earlier
	// round lacks and renders without.
	migrate: (value, from) => PublishedState.upgrade(value, from),
});

export const LedgerDocument = defineDoc<{ comment?: PostedLedger }>({
	kind: "melian.ledger",
	version: 2,
	migrate: (value) => value,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
});

// The changeset's publisher secret, which signs every marker Melian posts for it: 32 random bytes as hex, generated once
// and kept as long as the storage. A marker counts only when it verifies, whoever the provider says posted it, so
// recovery does not depend on the token knowing who it is.
// It also holds the target the latest publish validated, which a resumed task compares with its own.
type StoredPublisherState = { secret?: string; target?: PublishTarget; publishedBy?: PublishedBy };

class PublisherState {
	readonly stored: StoredPublisherState;

	constructor(stored: StoredPublisherState) {
		this.stored = stored;
	}

	static upgrade(value: unknown, from: number): StoredPublisherState {
		const stored = value as { secret?: string; target?: PublishTarget; trustedWriters?: boolean };
		const { trustedWriters, ...publisher } = stored;
		const upgraded =
			from === 1 ? { ...publisher, publishedBy: { trustedWriters: trustedWriters ?? true } } : publisher;
		return new PublisherState(upgraded).toJSON();
	}

	toJSON(): StoredPublisherState {
		return this.stored;
	}
}

export const PublisherDocument = defineDoc<StoredPublisherState>({
	kind: "melian.publisher",
	version: 3,
	migrate: (value, from) => PublisherState.upgrade(value, from),
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => new PublisherState({}).toJSON(),
});

// What the published round says of coverage, from the record its round wrote and the dismissals at its revision; a
// round that wrote none, such as one an earlier build decided, says nothing.
async function coverageOf(
	reader: Pick<DocumentReader, "snapshot">,
	root: ConversationId,
	round: string,
	revision: string,
	context: Context,
): Promise<PublishedCoverage | undefined> {
	const stored = (await reader.snapshot(CoverageDocument, root, context))?.records[round];
	if (stored === undefined) return undefined;
	const dismissed = (await reader.snapshot(GapDismissalDocument, root, context))?.items[revision] ?? [];
	return CoverageRecord.from(stored, dismissed).published();
}

// Whether the last review posted at `head`, as `record` holds it, posted this revision's verdict, by its fingerprint.
// A record an older Melian wrote names no revision; it counts only when no other revision reviewed
// at the head has a verdict with the same fingerprint, so an identical verdict after a retarget is never taken for the
// one posted under the old base.
async function postedVerdictOf(
	record: StoredRevision | undefined,
	revision: string,
	head: string,
	fingerprint: string,
	reader: Pick<DocumentReader, "snapshot">,
	root: ConversationId,
	context: Context,
): Promise<boolean> {
	if (record?.verdict !== fingerprint) return false;
	if (record.verdictRevision !== undefined) return record.verdictRevision === revision;
	const verdicts = (await reader.snapshot(VerdictDocument, root, context))?.verdicts ?? {};
	return !Object.entries(verdicts).some(([other, verdict]) => {
		if (other === revision || Revision.parseKey(other)?.head !== head) return false;
		return Verdict.from(verdict).fingerprint() === fingerprint;
	});
}

// Every reply recorded at any head, by `replyKey`.
function repliedKeys(state: StoredPublishedState): Set<string> {
	return new Set(Object.values(state.revisions).flatMap(({ replies }) => Object.keys(replies)));
}

// Resolutions still owed, including those a prior round recorded at this head.
// The caller carries each as its reply would read now, and skips one whose reply is recorded already.
function unanswered(state: StoredPublishedState): Record<string, ResolvedEntry & { thread: string }> {
	const answered = repliedKeys(state);
	const owed: Record<string, ResolvedEntry & { thread: string }> = {};
	for (const each of state.order) {
		for (const entry of Object.values(state.revisions[each]!.resolved)) {
			if (entry.thread === undefined) continue;
			const threaded = { ...entry, thread: entry.thread };
			const key = replyKeyOf(entry.id, threaded);
			if (!answered.has(key)) owed[key] = threaded;
		}
	}
	return owed;
}

// Dismissed findings whose thread last heard another reason. The fingerprint leaves dismissals out, so no round plans
// them, and each is resolved again at `head` with the dismissal it has now. A finding's thread is the one the newest
// head naming it holds; a finding still open there, or answered without a dismissal, is a round's to answer.
function redismissed(
	state: StoredPublishedState,
	head: string,
	dismissals: Readonly<Record<string, FindingDismissal>>,
): Record<string, ResolvedEntry> {
	const answered = repliedKeys(state);
	const planned = state.revisions[head]?.resolved ?? {};
	const again: Record<string, ResolvedEntry> = {};
	for (const [id, dismissal] of Object.entries(dismissals)) {
		const latest = state.order.findLast((each) => {
			const record = state.revisions[each]!;
			return Object.hasOwn(record.open, id) || Object.values(record.resolved).some((entry) => entry.id === id);
		});
		const record = latest === undefined ? undefined : state.revisions[latest]!;
		const entry =
			record === undefined || Object.hasOwn(record.open, id)
				? undefined
				: Object.values(record.resolved)
						.filter((entry) => entry.id === id)
						// GitHub's comment IDs only grow, so the larger root is the later thread at the same head.
						.sort(
							(left, right) =>
								state.order.indexOf(left.revision) - state.order.indexOf(right.revision) ||
								Number(left.thread ?? 0) - Number(right.thread ?? 0),
						)
						.at(-1);
		if (entry?.thread === undefined || entry.dismissal === undefined) continue;
		const now = { ...structuredClone(entry), thread: entry.thread, dismissal: { ...dismissal } };
		const key = replyKeyOf(id, now);
		const known = planned[key];
		const planning = known?.thread !== undefined && replyKeyOf(id, { ...known, thread: known.thread }) === key;
		if (!answered.has(key) && !planning) again[key] = now;
	}
	return again;
}

// The round to post for `verdict` at `head`: against the head's own open findings if a review of it was posted, else
// against those of the latest head that has one, with any resolution an earlier head still owes.
function planRound(
	state: StoredPublishedState,
	head: string,
	revision: string,
	verdict: Verdict,
	lines: Record<string, [number, number][]>,
	settled: ReadonlySet<string>,
): PendingRound {
	// Only a head with a recorded post has an open set. One whose rounds all failed or were abandoned holds an empty
	// placeholder, and planning against it reposted every open finding and never replied to the fixed ones.
	const postedAt = (each: string) => (state.revisions[each]?.reviews.length ?? 0) > 0;
	const own = postedAt(head) ? state.revisions[head] : undefined;
	const previous = state.order.filter((each) => each !== head && postedAt(each)).at(-1);
	const base = { ...(own?.open ?? (previous === undefined ? {} : state.revisions[previous]!.open)) };
	const owed = unanswered(state);
	// A finding the verdict holds again, while the reply that resolved its thread is owed, goes back to that thread
	// rather than starting a second one the first would outlive. The caller leaves out a reply the provider already shows.
	const returned = verdict.held();
	for (const finding of verdict.findings.advisory) {
		for (const id of finding.reportIds()) returned.delete(id);
	}
	// A dismissal's thread is not restored: a finding that returns after its dismissal reopened is posted afresh.
	for (const { addressedIn: _, ...entry } of Object.values(owed)) {
		const { id } = entry;
		if (
			entry.dismissal === undefined &&
			returned.has(id) &&
			!settled.has(entry.thread) &&
			(!Object.hasOwn(base, id) || base[id]!.thread === undefined)
		)
			base[id] = entry;
	}
	const plan = verdict.publication(base, lines, head);
	const resolved: Record<string, ResolvedEntry> = Object.fromEntries(
		plan.resolved.map((entry) => [
			resolutionKey(entry),
			{ ...structuredClone(entry), ...(entry.dismissal === undefined ? { addressedIn: head } : {}) },
		]),
	);
	if (own === undefined) {
		const held = new Set([...returned, ...verdict.dismissed.map((finding) => finding.properties.id)]);

		// A resolution still owed is carried as its reply would read now: with the dismissal of the finding that holds its
		// ID dismissed, itself or merged, and otherwise as it was owed, while no non-advisory finding with the ID is held.
		// A dismissal note owed for code a later head removed is still owed. One whose reply, as it would read now, is
		// recorded is answered.
		const answered = repliedKeys(state);
		for (const entry of Object.values(owed).reverse()) {
			const { id } = entry;
			const now = Object.hasOwn(plan.dismissals, id) ? plan.dismissals[id] : undefined;
			const carried =
				now !== undefined
					? { ...structuredClone(entry), dismissal: { ...now } }
					: held.has(id)
						? undefined
						: structuredClone(entry);
			if (carried !== undefined && !answered.has(replyKeyOf(id, carried)))
				resolved[resolutionKey(carried)] ??= carried;
		}
	}
	for (const entry of Object.values(owed)) {
		if (settled.has(entry.thread)) resolved[resolutionKey(entry)] ??= structuredClone(entry);
	}
	return {
		revision,
		round: (state.revisions[head]?.rounds ?? 0) + 1,
		fingerprint: verdict.fingerprint(),
		verdict: structuredClone(verdict.toJSON()),
		post: structuredClone(plan.post.map(({ finding, placement }) => ({ finding: finding.toJSON(), placement }))),
		stillOpen: plan.stillOpen.length,
		open: Object.fromEntries(Object.entries(plan.open).map(([id, entry]) => [id, { ...entry }])),
		resolved,
		refusals: 0,
	};
}

// What one publish task posts to, validated against the provider before the task was created: the repository and pull
// request, the base branch and its tip as the provider reported them, the merge base the host computed, the head, and
// the `Revision.key` of the review whose verdict it publishes.
type PublishTarget = {
	repository: string;
	pullRequest: number;
	baseRef: string;
	baseTip: string;
	base: string;
	head: string;
	revision: string;
	roundId: string;
};

// The first way `current` differs from `recorded`, or `undefined` when they are the same target.
function targetChange(recorded: PublishTarget | undefined, current: PublishTarget): string | undefined {
	if (recorded === undefined) return "the task recorded no target";
	for (const field of [
		"repository",
		"pullRequest",
		"baseRef",
		"baseTip",
		"base",
		"head",
		"revision",
		"roundId",
	] as const) {
		if (recorded[field] !== current[field]) {
			return `its ${field} was ${String(recorded[field])}, and is ${String(current[field])} now`;
		}
	}
	return undefined;
}

// How the pull request the provider reports now differs from `target`, or `undefined` when it does not.
function movedFrom(target: PublishTarget, now: PullRequest): string | undefined {
	const repository = `${now.repository.owner}/${now.repository.name}`;
	if (repository !== target.repository) return `it belongs to ${repository} now`;
	if (now.head.sha !== target.head) return `its head moved to ${short(now.head.sha)}`;
	if (now.base.ref !== target.baseRef) return `it was retargeted onto ${now.base.ref}`;
	if (now.base.sha !== target.baseTip) return `its base branch ${now.base.ref} moved to ${short(now.base.sha)}`;
	return undefined;
}

class TargetMoved extends Error {}

type StoredPublishInput = {
	publishedBy: PublishedBy;
	root: ConversationId;
	target: PublishTarget;
	lines: Record<string, [number, number][]>;
	walkthrough?: { enabled: boolean; collapsed: boolean; diagrams: boolean };
};

class PublishInput {
	readonly stored: StoredPublishInput;

	constructor(stored: StoredPublishInput) {
		this.stored = stored;
	}

	static upgrade(value: unknown, from: number): StoredPublishInput {
		const stored = value as StoredPublishInput;
		return new PublishInput({
			...stored,
			...(from === 1 ? { publishedBy: { trustedWriters: true } } : {}),
		}).toJSON();
	}

	toJSON(): StoredPublishInput {
		return this.stored;
	}
}

type AttestedRound = {
	revision: string;
	round: number;
	dismissals: { id: string; ruleId: string; path: string; dismissal?: FindingDismissal }[];
};

export function failedAttestations(detail: unknown): AttestedRound[] {
	return (detail as { attestations?: AttestedRound[] } | undefined)?.attestations ?? [];
}

type PublishResult = {
	attestations: AttestedRound[];
	review: string;
	posted: number;
	stillOpen: number;
	resolved: number;
	// Absent from a result recorded before dismissals were posted.
	dismissed?: number;
	replies: number;
	status: ReviewStatus;
	// Posts found by their markers rather than in the document: a crash fell between post and record.
	recovered: number;
	abandoned: AbandonedRound[];
};

// `superseded`: the target changed before the task resumed, so it wrote nothing. `staleTarget`: the provider reported
// a different target just before a post, so the task stopped before it.
type PublishOutcome =
	| ({ kind: "published" } & PublishResult)
	| { kind: "superseded"; reason: string }
	| { kind: "staleTarget"; reason: string; attestations: AttestedRound[] };

const publishTaskName = "melian.publish";

const untrustedWriterStatus: ReviewStatus = {
	state: "error",
	description: "not reviewed here: writers are not trusted; a trusted host sets this status",
};

// Not replay-safe: a post and the commit that records it are two steps, and the host takes no idempotency key. Every
// post is recorded in its own commit, and before posting anything the phase reads Melian's markers back from the pull
// request, so a rerun after a crash between a post and its record finds the post instead of repeating it.
function publishTask(provider: ReviewProvider) {
	return defineTask<StoredPublishInput, { phase: "publish"; legacyTiming?: true }, PublishOutcome>({
		name: publishTaskName,
		version: 6,
		migrate: (input, checkpoint, fromVersion) => ({
			input: PublishInput.upgrade(input, fromVersion),
			checkpoint:
				fromVersion >= 3
					? (checkpoint as { phase: "publish"; legacyTiming?: true })
					: { ...(checkpoint as { phase: "publish" }), legacyTiming: true },
		}),
		initial: () => ({ phase: "publish" }),
		phases: {
			publish: async (task, runtime, context) => {
				const timing = await TaskTiming.start(runtime, task.state.checkpoint.legacyTiming, context);
				const { root, lines, publishedBy } = task.input;
				// A task created before targets were recorded has none, and is superseded like any other stale one.
				const target = structuredClone(task.input.target) as PublishTarget | undefined;
				let publisher: StoredPublisherState | undefined;
				let migrationRefusal: string | undefined;
				await runtime.commit(async (tx) => {
					const stored = await tx.doc(PublisherDocument, root);
					const unbound = [target, stored.target].filter(
						(each): each is PublishTarget => each !== undefined && each.roundId === undefined,
					);
					const rounds = await tx.doc(RoundsDocument, root);
					const ambiguous = unbound.some((each) =>
						Object.entries(rounds.items).some(
							([id, round]) => id !== legacyKey(each.revision) && Revision.key(round) === each.revision,
						),
					);
					if (ambiguous) {
						migrationRefusal =
							"its round cannot be proven because minted rounds exist at its revision; run melian publish again";
					} else {
						for (const each of unbound) {
							await new RoundWriter(tx, root).preserve(each.revision);
							each.roundId = legacyKey(each.revision);
						}
					}
					publisher = JSON.parse(JSON.stringify(stored)) as StoredPublisherState;
					return undefined;
				}, context);
				// Every publish records the target it validated before resuming any task, so a task a crash left behind for
				// another base, head, or pull request ends here, before any post.
				const change =
					migrationRefusal ??
					(publisher?.target === undefined ? "no target is recorded" : targetChange(target, publisher.target));
				const current = publisher?.publishedBy;
				const trustChanged = publishedBy.trustedWriters !== current?.trustedWriters;
				const attributionChanged = (["login", "permission", "authorPermission"] as const).find(
					(field) => publishedBy[field] !== undefined && publishedBy[field] !== current?.[field],
				);
				if (target === undefined || change !== undefined || trustChanged || attributionChanged !== undefined) {
					const reason =
						migrationRefusal ??
						(trustChanged
							? "writer trust policy changed"
							: attributionChanged !== undefined
								? `publisher ${attributionChanged} changed`
								: (change ?? "the task recorded no target"));
					await runtime.commit(async (tx) => {
						await timing.end(tx);
						return {
							status: "terminal",
							outcome: { status: "completed", result: { kind: "superseded", reason } },
						};
					}, context);
					return;
				}
				const { pullRequest, base, head, revision } = target;
				const revalidate = async () => {
					const moved = movedFrom(target, await provider.pullRequest(pullRequest));
					if (moved !== undefined) throw new TargetMoved(moved);
				};
				const read = async () =>
					(await runtime.snapshot(PublishedDocument, root, context)) ?? { order: [], revisions: {} };
				const postStatus = async (status: ReviewStatus) => {
					if (!publishedBy.trustedWriters) status = untrustedWriterStatus;
					await revalidate();
					const ledgerUrl =
						(await runtime.snapshot(LedgerDocument, root, context))?.comment?.url ??
						(await read()).revisions[head]?.ledgerUrl;
					const shown = await provider.getStatus(head, base);
					if (
						shown?.state !== status.state ||
						(await read()).revisions[head]?.status?.description !== status.description ||
						shown.targetUrl !== ledgerUrl
					)
						await provider.setStatus(head, status, ledgerUrl, base);
					await runtime.commit(async (tx) => {
						const document = await tx.doc(PublishedDocument, root);
						if (!document.order.includes(head)) document.order = [...document.order, head];
						document.revisions[head] = {
							...(document.revisions[head] ?? unpublished()),
							publishedBy: { ...publishedBy },
							status: { ...status },
							...(ledgerUrl === undefined ? {} : { ledgerUrl }),
						};
						return undefined;
					}, context);
				};
				const attestations: AttestedRound[] = [];
				const result = {
					attestations,
					posted: 0,
					stillOpen: 0,
					resolved: 0,
					dismissed: 0,
					replies: 0,
					recovered: 0,
				};
				// Set while the provider is asked to post a round, so a refusal counts against that round.
				let posting = false;
				let writingLedger = false;
				try {
					const secret = publisher?.secret;
					if (secret === undefined) throw new Error("the changeset has no publisher secret");
					const markers = new Map<string, PublishedMarkers>();
					// Reviews and roots match this head; answers span every head.
					const marked = async ({ fingerprint, round }: { fingerprint: string; round: number }) => {
						const key = `${fingerprint} ${round}`;
						if (!markers.has(key))
							markers.set(key, await provider.findPublished(pullRequest, head, { fingerprint, round }, secret));
						return markers.get(key)!;
					};
					// The target-binding commit above materialises this document, including for legacy tasks.
					const reviewRounds = (await runtime.snapshot(RoundsDocument, root, context))!;
					const storedRound = reviewRounds.items[target.roundId];
					const currentReviewRound = reviewRounds.current[revision];
					const reviewing =
						(await runtime.snapshot(ReviewIndex, root, context))?.reviews[revision]?.adjudication === undefined;
					if (reviewing || currentReviewRound !== target.roundId || storedRound?.verdict === undefined) {
						const reason = reviewing
							? `review is in progress for ${revision}; publish again`
							: `round ${target.roundId} is superseded or undecided; current round is ${currentReviewRound ?? "missing"}`;
						await runtime.commit(async (tx) => {
							await timing.end(tx);
							return {
								status: "terminal",
								outcome: { status: "completed", result: { kind: "superseded", reason } },
							};
						}, context);
						return;
					}
					provider.beginPublish?.();
					const coverage = await coverageOf(runtime, root, target.roundId, revision, context);
					const verdict = Verdict.from(storedRound.verdict);
					const current = verdict.fingerprint();
					const status = publishedBy.trustedWriters ? verdict.reviewStatus() : untrustedWriterStatus;
					await postStatus(status);
					// A pending round planned for another revision of this head, such as the pull request before a retarget,
					// is dropped unless the provider already shows it, in which case the loop below records it as posted.
					const left = (await read()).revisions[head]?.pending;
					if (left !== undefined && left.revision !== revision && (await marked(left)).review === undefined) {
						await runtime.commit(async (tx) => {
							delete (await tx.doc(PublishedDocument, root)).revisions[head]!.pending;
							return undefined;
						}, context);
					}
					// A pending round left by a failed run is posted as planned, under its own verdict. If the head's verdict
					// changed since, a second round then posts the current one, so the last review matches the status.
					for (let round = 0; round < 2; round++) {
						const state = await read();
						const before = state.revisions[head];
						if (before?.pending === undefined) {
							if (await postedVerdictOf(before, revision, head, current, runtime, root, context)) break;
							const found = await marked({ fingerprint: current, round: (before?.rounds ?? 0) + 1 });
							const settled = new Set<string>();
							const returning = verdict.held();
							for (const entry of Object.values(unanswered(state))) {
								const { id } = entry;
								if (!returning.has(id)) continue;
								if (
									found.replies[replyKeyOf(id, entry)] !== undefined ||
									!(await provider.isThreadOpen(pullRequest, entry.thread))
								)
									settled.add(entry.thread);
							}
							const planned = planRound(state, head, revision, verdict, lines, settled);
							const storedVerdict = await runtime.snapshot(VerdictDocument, root, context);
							const details = storedVerdict?.details?.[revision];
							const walkthrough = storedVerdict?.walkthroughs?.[revision];
							planned.ledger = {
								publishedBy: { ...publishedBy },
								base,
								head,
								round: (state.revisions[head]?.reviews.length ?? 0) + 1,
								verdict: structuredClone(planned.verdict),
								...(details === undefined ? {} : { details: structuredClone(details) }),
								...(walkthrough === undefined ? {} : { walkthrough: structuredClone(walkthrough) }),
								...(coverage === undefined ? {} : { coverage }),
								resolved: Object.values(planned.resolved).map((entry) => ({
									id: entry.id,
									ruleId: entry.ruleId,
									path: entry.path,
									line: entry.line,
									commit: entry.addressedIn ?? head,
									...(entry.dismissal === undefined ? {} : { reason: entry.dismissal.reason }),
								})),
							};
							await runtime.commit(async (tx) => {
								const document = await tx.doc(PublishedDocument, root);
								document.order = [...document.order.filter((each) => each !== head), head];
								document.revisions[head] = {
									...(document.revisions[head] ?? unpublished()),
									rounds: planned.round,
									pending: planned,
								};
								return undefined;
							}, context);
						}
						const pending = (await read()).revisions[head]!.pending!;
						result.stillOpen = pending.stillOpen;
						const found = await marked(pending);
						let posted: PostedReview;
						if (found.review === undefined) {
							// A still-open finding whose thread a human resolved or deleted is otherwise hidden from the pull request.
							const carried: string[] = [];
							for (const [id, entry] of Object.entries(pending.open)) {
								if (entry.thread !== undefined && !(await provider.isThreadOpen(pullRequest, entry.thread)))
									carried.push(id);
							}
							await revalidate();
							posting = true;
							posted = await provider.postReview({
								pullRequest,
								revision: head,
								base,
								fingerprint: pending.fingerprint,
								round: pending.round,
								verdict: Verdict.from(pending.verdict),
								findings: pending.post.map(({ finding, placement }) => ({
									finding: Finding.from(finding),
									placement,
								})),
								stillOpen: pending.stillOpen,
								carried,
								resolved: Object.values(pending.resolved).filter((entry) => entry.thread === undefined),
								...(pending.ledger?.coverage === undefined ? {} : { coverage: pending.ledger.coverage }),
								secret,
							});
							posting = false;
							result.posted += pending.post.length;
						} else {
							posted = { id: found.review, threads: found.threads };
							result.recovered++;
						}
						attestations.push({
							revision: pending.revision,
							round: pending.round,
							dismissals: Verdict.from(pending.verdict)
								.dismissals()
								.map(({ id, ruleId, path, dismissal }) => ({
									id,
									ruleId,
									path,
									...(dismissal === undefined ? {} : { dismissal }),
								})),
						});
						// A round planned by an earlier build may give an advisory a thread; it is resolved, as the plan resolves one.
						const advisory = new Set(
							Verdict.from(pending.verdict).findings.advisory.flatMap((finding) => finding.reportIds()),
						);
						const resolved = { ...pending.resolved };
						const open: Record<string, PublishedEntry> = {};
						for (const [id, { thread: planned, ...entry }] of Object.entries(pending.open)) {
							const thread = planned ?? (entry.revision === head ? posted.threads[id] : undefined);
							if (advisory.has(id) && thread !== undefined) {
								const closing = { ...entry, thread, id, addressedIn: head };
								resolved[resolutionKey(closing)] = closing;
								open[id] = entry;
							} else open[id] = { ...entry, ...(thread === undefined ? {} : { thread }) };
						}
						await runtime.commit(async (tx) => {
							const document = await tx.doc(PublishedDocument, root);
							const record = document.revisions[head]!;
							if (pending.ledger !== undefined)
								document.ledgerRounds = [
									...(document.ledgerRounds ?? []).map((round) =>
										"verdict" in round
											? {
													base: round.base,
													head: round.head,
													round: round.round,
													status: round.verdict.status,
												}
											: round,
									),
									structuredClone(pending.ledger),
								].slice(-maxLedgerRounds);
							record.reviews = [...record.reviews, posted.id];
							record.verdict = pending.fingerprint;
							record.verdictRevision = pending.revision;
							record.open = open;
							record.resolved = { ...record.resolved, ...resolved };
							new PublishedState(document).retire(open);
							delete record.pending;
							return undefined;
						}, context);
						const closed = Object.values(resolved);
						result.dismissed += closed.filter((entry) => entry.dismissal !== undefined).length;
						result.resolved += closed.filter((entry) => entry.dismissal === undefined).length;
					}
					// A reason changed by a second dismissal takes a reply alone, under the status already set.
					// The dismissals a publication of the verdict answers, whatever the pull request already shows.
					const { dismissals } = verdict.publication({}, lines, head);
					const again = redismissed(await read(), head, dismissals);
					if (Object.keys(again).length > 0) {
						const now = (await read()).revisions[head]!;
						const shown = (await marked({ fingerprint: now.verdict ?? "", round: now.rounds ?? 0 })).replies;
						await runtime.commit(async (tx) => {
							const document = await tx.doc(PublishedDocument, root);
							const stored = document.revisions[head]!;
							// A reason no reply ever carried is superseded by the current one on the same thread.
							const answered = repliedKeys(document);
							for (const [key, entry] of Object.entries(stored.resolved)) {
								// A root carries one finding's marker, so the thread alone names the finding.
								const replaced = Object.values(again).some((current) => current.thread === entry.thread);
								if (replaced && !answered.has(key) && shown[key] === undefined) delete stored.resolved[key];
							}
							stored.resolved = { ...stored.resolved, ...again };
							return undefined;
						}, context);
						result.dismissed += Object.keys(again).length;
					}
					const closing = await read();
					for (const [publishedHead, record] of Object.entries(closing.revisions)) {
						for (const entry of Object.values(record.resolved)) {
							const { id } = entry;
							if (entry.thread === undefined) continue;
							const key = replyKeyOf(id, { ...entry, thread: entry.thread });
							const replied = Object.hasOwn(record.replies, key);
							if (publishedHead !== head && !replied) continue;
							if (replied) {
								if (entry.dismissal !== undefined || record.threadResolutions?.[key] === true) continue;
								await revalidate();
								await provider.resolveThread(pullRequest, entry.thread);
								await runtime.commit(async (tx) => {
									const stored = (await tx.doc(PublishedDocument, root)).revisions[publishedHead]!;
									stored.threadResolutions = { ...stored.threadResolutions, [key]: true };
									return undefined;
								}, context);
								result.recovered++;
								continue;
							}
							// Replies do not depend on the round, so any round's lookup serves; the last one is likely cached.
							const found = (await marked({ fingerprint: record.verdict ?? "", round: record.rounds ?? 0 }))
								.replies[key];
							let recorded: string | null;
							// A resolution marker proves the edit or reply, but an older reply left the thread open.
							if (found === undefined || found === entry.thread) {
								await revalidate();
								const reply = await provider.replyResolved(
									pullRequest,
									{ ...entry, thread: entry.thread },
									head,
									secret,
								);
								recorded = reply ?? null;
								if (reply !== undefined) result.replies++;
							} else {
								if (entry.dismissal === undefined) {
									await revalidate();
									await provider.resolveThread(pullRequest, entry.thread);
								}
								recorded = found;
								result.recovered++;
							}
							await runtime.commit(async (tx) => {
								const stored = (await tx.doc(PublishedDocument, root)).revisions[head]!;
								stored.replies[key] = recorded;
								if (entry.dismissal === undefined)
									stored.threadResolutions = { ...stored.threadResolutions, [key]: true };
								return undefined;
							}, context);
						}
					}
					const record = closing.revisions[head]!;
					const publication = await read();
					const rounds = structuredClone(publication.ledgerRounds ?? []);
					const storedVerdict = await runtime.snapshot(VerdictDocument, root, context);
					const latest = rounds.at(-1);
					if (latest === undefined || latest.head !== head) {
						rounds.push({
							base,
							head,
							round: record.reviews.length || 1,
							verdict: verdict.toJSON(),
							resolved: [],
						});
						rounds.splice(0, rounds.length - maxLedgerRounds);
					}
					const currentRound = rounds.at(-1)! as LedgerRound;
					currentRound.publishedBy = { ...publishedBy };
					currentRound.base = base;
					currentRound.verdict = verdict.toJSON();
					currentRound.resolved = Object.values(record.resolved).map((entry) => ({
						id: entry.id,
						ruleId: entry.ruleId,
						path: entry.path,
						line: entry.line,
						commit: entry.addressedIn ?? head,
						...(entry.dismissal === undefined ? {} : { reason: entry.dismissal.reason }),
					}));
					if (storedVerdict?.details?.[revision] !== undefined)
						currentRound.details = structuredClone(storedVerdict.details[revision]);
					delete currentRound.walkthrough;
					delete currentRound.walkthroughNote;
					delete currentRound.coverage;
					if (coverage !== undefined) currentRound.coverage = structuredClone(coverage);
					if (storedVerdict?.walkthroughs?.[revision] !== undefined)
						currentRound.walkthrough = structuredClone(storedVerdict.walkthroughs[revision]);
					if (storedVerdict?.walkthroughNotes?.[revision] !== undefined)
						currentRound.walkthroughNote = storedVerdict.walkthroughNotes[revision];
					const previousLedger = (await runtime.snapshot(LedgerDocument, root, context))?.comment;
					await revalidate();
					writingLedger = true;
					const ledger = await provider.writeLedger({
						pullRequest,
						review: record.reviews.at(-1),
						verdict,
						publication: { rounds },
						walkthrough: task.input.walkthrough ?? { enabled: true, collapsed: true, diagrams: true },
						secret,
						...(previousLedger === undefined ? {} : { recorded: previousLedger }),
					});
					writingLedger = false;
					if (JSON.stringify(previousLedger) !== JSON.stringify(ledger)) {
						await runtime.commit(async (tx) => {
							(await tx.doc(LedgerDocument, root)).comment = structuredClone(ledger);
							(await tx.doc(PublishedDocument, root)).ledgerRounds = rounds;
							return undefined;
						}, context);
					}
					attestations.push({
						revision,
						round: record.rounds ?? record.reviews.length,
						dismissals: verdict.dismissals().map(({ id, ruleId, path, dismissal }) => ({
							id,
							ruleId,
							path,
							...(dismissal === undefined ? {} : { dismissal }),
						})),
					});
					await postStatus(status);
					await runtime.commit(async (tx) => {
						await timing.end(tx);
						const abandoned = structuredClone(record.abandoned ?? []);
						const done: PublishOutcome = {
							kind: "published",
							review: record.reviews.at(-1)!,
							status,
							...result,
							abandoned,
						};
						return { status: "terminal", outcome: { status: "completed", result: done } };
					}, context);
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					if (error instanceof TargetMoved) {
						const stale: PublishOutcome = { kind: "staleTarget", reason: error.message, attestations };
						await runtime.commit(async (tx) => {
							await timing.end(tx);
							return { status: "terminal", outcome: { status: "completed", result: stale } };
						}, context);
						return;
					}
					// Everything posted so far is recorded, so the outcome is the failure, and publishing again resumes. A round
					// the provider keeps refusing, such as one whose comment GitHub rejects with a 422, would block every later
					// publish of the head, so its third refusal abandons it and the next publish plans a new round.
					let message = error instanceof Error ? error.message : String(error);
					const refused = posting ? (await read()).revisions[head]?.pending : undefined;
					// An abandoned round leaves the head without a review, so its status must replace any earlier success. The
					// description is fixed because the provider's message can pass the status limit; the record keeps it.
					let shown: ReviewStatus | undefined;
					let unset: string | undefined;
					if (writingLedger && error instanceof LedgerRefusal) {
						try {
							await postStatus({
								state: "error",
								description: "ledger unavailable; restore storage or delete the ledger comment by hand",
							});
						} catch {}
					}
					if (refused !== undefined && (refused.refusals ?? 0) + 1 >= maxRefusals) {
						const failed: ReviewStatus = publishedBy.trustedWriters
							? {
									state: "error",
									description: "Melian could not post its review; see the publish record",
								}
							: untrustedWriterStatus;
						try {
							await revalidate();
							const ledgerUrl = (await runtime.snapshot(LedgerDocument, root, context))?.comment?.url;
							await provider.setStatus(head, failed, ledgerUrl, base);
							shown = failed;
						} catch (error) {
							unset = error instanceof Error ? error.message : String(error);
						}
					}
					await runtime.commit(async (tx) => {
						await timing.end(tx);
						const record = posting ? (await tx.doc(PublishedDocument, root)).revisions[head] : undefined;
						const pending = record?.pending;
						if (record !== undefined && pending !== undefined) {
							pending.refusals = (pending.refusals ?? 0) + 1;
							if (pending.refusals >= maxRefusals) {
								const { fingerprint: refused, refusals } = pending;
								record.abandoned = [
									...(record.abandoned ?? []),
									{ fingerprint: refused, refusals, error: message },
								];
								delete record.pending;
								if (shown !== undefined) record.status = { ...shown };
								const status =
									unset === undefined
										? "set the status to error"
										: `could not set the status to error (${unset})`;
								message = `the provider refused the review of verdict ${refused} ${refusals} times, so Melian abandoned it and ${status}; the next publish plans a new one: ${message}`;
							}
						}
						return {
							status: "terminal",
							outcome: { status: "failed", error: { message, detail: { attestations } } },
						};
					}, context);
				}
			},
		},
		abort: async (_task, runtime, context) => {
			const timing = await TaskTiming.read(runtime, context);
			await runtime.commit(async (tx) => {
				await timing.end(tx);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});
}

/**
 * The extension that publishes reviews through `provider`: the publish task. Install it beside the review extension in
 * the harness a host publishes from, and again after a restart, so an interrupted publication resumes.
 */
export function publishExtension(provider: ReviewProvider) {
	return defineExtension({ name: publishTaskName, tasks: [publishTask(provider)] });
}

/**
 * A durable harness that publishes through one provider over one changeset's storage, and holds nothing else, so a
 * review a crash interrupted does not resume in it and spend tokens on real models during a publish. Pass its `harness`
 * to `publishReview`, and close it when done, which closes the storage.
 */
export class PublishHarness {
	/** Pi's harness, which {@link publishReview} takes. */
	readonly harness: Harness;

	private constructor(harness: Harness) {
		this.harness = harness;
	}

	/**
	 * Opens one over `storage` that publishes through `provider`, with {@link publishExtension} alone installed. A failed
	 * open closes `storage`.
	 */
	static async open(
		storage: Storage,
		models: ReviewModels,
		provider: ReviewProvider,
		context: Context = backgroundContext,
	): Promise<PublishHarness> {
		const registry = createRegistry();
		registry.install(publishExtension(provider));
		const harness = await openHarness(storage, { models: modelsOf(models), registry }, context).catch(
			async (error: unknown) => {
				// Pi closes the storage only once it has built a harness; an open refused before that leaves it to us.
				await storage.close(backgroundContext).catch(() => undefined);
				throw error;
			},
		);
		return new PublishHarness(harness);
	}

	/** Closes the harness and its storage. Idempotent. */
	close(context: Context = backgroundContext): Promise<void> {
		return this.harness.close(context);
	}
}

/** Opens a {@link PublishHarness} over `storage`, as {@link PublishHarness.open} does. */
export function openPublishHarness(
	storage: Storage,
	models: ReviewModels,
	provider: ReviewProvider,
	context: Context = backgroundContext,
): Promise<PublishHarness> {
	return PublishHarness.open(storage, models, provider, context);
}

/** What {@link publishReview} publishes. */
export interface PublishOptions {
	/** Required root writer-trust policy; false leaves the status for a trusted host. */
	readonly trustedWriters: boolean;
	/** A harness over the changeset's storage, with {@link publishExtension} for `provider` installed. */
	readonly harness: Harness;
	readonly provider: ReviewProvider;
	/** The pull request's changeset, reviewed at the pull request's head. */
	readonly changeset: Changeset;
	/** The pull request as its provider reports it now. */
	readonly pullRequest: PullRequest;
	/**
	 * The commit the pull request diffs from now: the merge base of its base branch and its head, which the host reads
	 * with git, since the provider reports only the branch's tip.
	 */
	readonly base: string;
	readonly walkthrough?: { readonly enabled: boolean; readonly collapsed: boolean; readonly diagrams: boolean };
	readonly context?: Context;
}

/**
 * What {@link publishReview} did. Counts cover this run, so a second publish of one revision counts nothing; only
 * `abandoned` covers the head.
 */
export interface Publication {
	/** Dismissal snapshots attested by posted or recovered rounds and the current ledger. */
	readonly attestations: readonly AttestedRound[];
	readonly review: string;
	readonly posted: number;
	readonly stillOpen: number;
	/** Findings an earlier revision posted that the reviews this run posted no longer report. */
	readonly resolved: number;
	/** Findings an earlier revision posted that were dismissed since, each answered with the reason. */
	readonly dismissed: number;
	readonly replies: number;
	readonly status: ReviewStatus;
	readonly recovered: number;
	/**
	 * Every round of this head the provider refused three times, so Melian gave it up, with the last error. A later
	 * round planned afresh carries its findings, so they reach the pull request once the provider accepts one.
	 */
	readonly abandoned: readonly AbandonedReview[];
	/**
	 * Publish tasks a crash left for another target, such as the pull request before a retarget, which this run ended
	 * without posting anything.
	 */
	readonly superseded: readonly SupersededPublication[];
}

/** A publish task that ended without writing, because its target was not the pull request's any more, and why. */
export interface SupersededPublication {
	readonly task: string;
	readonly reason: string;
}

/** A review of a head that Melian gave up posting: the verdict it named, how often it was refused, and why. */
export interface AbandonedReview {
	readonly fingerprint: string;
	readonly refusals: number;
	readonly error: string;
}

/** What a revision's publication recorded: its review, each posted finding's thread, its replies, and status. */
export interface PublishedRecord {
	readonly publishedBy: PublishedBy;
	readonly review: string;
	readonly threads: Readonly<Record<string, string>>;
	/** Each resolved finding's reply, by ID; `null` when its thread was gone. */
	readonly replies: Readonly<Record<string, string | null>>;
	readonly status?: ReviewStatus;
}

/** What {@link publishReview} recorded for `revision`, a head commit, or `undefined` if nothing was published. */
export async function readPublished(
	reader: Pick<DocumentReader, "snapshot">,
	rootConversationId: ConversationId,
	revision: string,
	context: Context,
): Promise<PublishedRecord | undefined> {
	const document = await reader.snapshot(PublishedDocument, rootConversationId, context);
	if (document === undefined || !Object.hasOwn(document.revisions, revision)) return undefined;
	const { reviews, open, replies, status, publishedBy } = document.revisions[revision]!;
	const review = reviews.at(-1);
	if (review === undefined) return undefined;
	const threads = Object.fromEntries(
		Object.entries(open).flatMap(([id, entry]) =>
			entry.revision === revision && entry.thread !== undefined ? [[id, entry.thread]] : [],
		),
	);
	return structuredClone({
		review,
		threads,
		replies,
		publishedBy: publishedBy!,
		...(status === undefined ? {} : { status }),
	});
}

function short(commit: string): string {
	return commit.slice(0, 12);
}

// Why a verdict decided from `provenance` must not reach `pullRequest`, or `undefined` when it may. Only a review of
// the pull request itself, fetched from its provider, under policy read from the base commit the provider reported,
// is publishable: a range naming the refs Melian fetched for the pull request is still a range, and a review whose
// policy came from the working tree obeyed whatever was checked out.
function unpublishable(provenance: VerdictProvenance | undefined, pullRequest: PullRequest): string | undefined {
	if (provenance === undefined) return "its review recorded no provenance";
	if (provenance.kind !== "pull-request") return `it reviewed a ${provenance.kind}, not the pull request`;
	const { owner, name } = pullRequest.repository;
	if (provenance.repository.owner !== owner || provenance.repository.name !== name) {
		return `it reviewed ${provenance.repository.owner}/${provenance.repository.name}, not ${owner}/${name}`;
	}
	if (provenance.pullRequest !== pullRequest.number) return `it reviewed pull request #${provenance.pullRequest}`;
	if (provenance.head !== pullRequest.head.sha) {
		return `the provider reported head ${short(provenance.head)} to the review, and reports ${short(pullRequest.head.sha)} now`;
	}
	if (provenance.policy !== `revision:${provenance.base}`) {
		return `its policy came from ${provenance.policy}, not from base commit ${short(provenance.base)}`;
	}
	return undefined;
}

// Why the verdict stored for `revision` may not be the one its findings decide now, or `undefined` when it is. The task
// the review index names must have ended recording the stored verdict, from the findings as they are now. Pi's
// inspection lists live tasks only, so a task that ended without deciding, aborted, failed, faulted, or orphaned, is
// read by its ID, never inferred from its absence there. With no indexed adjudication, the task-side guard ends
// publication superseded as review in progress; the user must publish again after adjudication finishes.
async function undecidedVerdict(
	tx: Tx,
	root: ConversationId,
	revision: string,
	decisions: ReturnType<typeof VerdictDocument.definition.initial>["decisions"],
): Promise<string | undefined> {
	const deciding = (await tx.doc(ReviewIndex, root)).reviews[revision]?.adjudication;
	const decision = decisions?.[revision];
	const now = (await tx.doc(FindingsDocument, root)).versions[revision] ?? 0;
	if (deciding === undefined) {
		return decision === undefined || decision.findingsVersion === now
			? undefined
			: "its findings changed after it was decided, and no adjudication is recorded since";
	}
	const task = await tx.task(deciding.task as TaskId);
	if (task === undefined) return `its adjudication task ${deciding.task} is gone`;
	if (task.state.status !== "terminal") return "its adjudication has not finished";
	const { outcome } = task.state;
	if (outcome.status !== "completed") return `its adjudication ended ${outcome.status}`;
	if (outcome.result !== "recorded") return `its adjudication ended ${outcome.result}`;
	// A verdict recorded before Melian kept its decision: the input the index holds names the version it read.
	const decided = decision ?? {
		task: deciding.task,
		findingsVersion: (JSON.parse(deciding.input) as { findingsVersion: number }).findingsVersion,
	};
	if (decided.task !== deciding.task) return "another adjudication task recorded the stored verdict";
	return decided.findingsVersion === now ? undefined : "its findings changed after it was decided";
}

/**
 * Publishes the verdict recorded for a pull request's head: one review whose body is the verdict and whose comments
 * are the findings not already open. Each finding the head addressed gets its own comment edited to say so, and its
 * thread resolved, where Melian signed the comment; no reply is posted. The review ledger, the one comment Melian
 * keeps current across rounds, is created or edited, and the review's status links to it. Every post is
 * recorded in {@link PublishedDocument}, so publishing a revision again posts nothing, and a publication a crash
 * interrupted resumes, finding what it already posted by Melian's markers.
 *
 * The verdict is the one recorded for the changeset's base and head, its {@link Revision.key}, so a review of the pull
 * request before its base branch moved under it, or before it was retargeted, is never posted as a review of what it
 * shows now.
 *
 * Throws {@link PublishError}: `staleReview` when the changeset's head or base is not the pull request's, `notReviewed`
 * when no verdict is recorded for that base and head or its adjudication is still undecided, `notPublishable` when the verdict's provenance is not a review of
 * this pull request, fetched from the provider, under policy from the base commit it reported, `staleTarget` when the
 * provider reports another head, base, or repository just before a post, `notInstalled` when the harness lacks {@link publishExtension}, and
 * `publishFailed` when the provider refused a post.
 */
export async function publishReview(options: PublishOptions): Promise<Publication> {
	const { harness, changeset, pullRequest } = options;
	const context = options.context ?? backgroundContext;
	const head = pullRequest.head.sha;
	const where = { pullRequest: pullRequest.number, revision: head };
	const again = `run melian review "#${pullRequest.number}" first`;
	if (typeof options.trustedWriters !== "boolean") {
		throw new PublishError("notPublishable", "publication requires an explicit root writer-trust policy", where);
	}
	if (changeset.revision.head !== head) {
		throw new PublishError(
			"staleReview",
			`pull request #${pullRequest.number} is at ${short(head)}, but Melian reviewed ${short(changeset.revision.head)}; ${again}`,
			where,
		);
	}
	if (changeset.revision.base !== options.base) {
		throw new PublishError(
			"staleReview",
			`pull request #${pullRequest.number} now diffs from ${short(options.base)} on ${pullRequest.base.ref}, but Melian reviewed it from ${short(changeset.revision.base)}; its base branch moved or it was retargeted; run melian review "#${pullRequest.number}" again`,
			where,
		);
	}
	const revision = Revision.key(changeset.revision);
	const root = (await harness.root(context)).id;
	const validated = await (await harness.root(context)).commit(async (tx) => {
		const live = await tx.doc(VerdictDocument, root);
		const rounds = await tx.doc(RoundsDocument, root);
		const captured = {
			roundId: rounds.current[revision] ?? legacyKey(revision),
			verdict: live.verdicts[revision],
			provenance: live.provenance?.[revision] as VerdictProvenance | undefined,
			undecided: await undecidedVerdict(tx, root, revision, live.decisions),
		};
		return JSON.parse(JSON.stringify(captured)) as typeof captured;
	}, context);
	if (validated.verdict === undefined) {
		throw new PublishError(
			"notReviewed",
			`Melian has no review of ${short(head)} from ${short(changeset.revision.base)}; ${again}`,
			where,
		);
	}
	const mismatch = unpublishable(validated.provenance, pullRequest);
	if (mismatch !== undefined) {
		throw new PublishError(
			"notPublishable",
			`Melian will not publish its review of ${short(head)} to pull request #${pullRequest.number}: ${mismatch}; ${again}`,
			where,
		);
	}
	const { undecided } = validated;
	if (undecided !== undefined) {
		throw new PublishError(
			"notReviewed",
			`Melian has not finished deciding the verdict of ${short(head)}, as after a dismissal or a review that was interrupted: ${undecided}; ${again}`,
			where,
		);
	}
	const login = await options.provider.login();
	const permission = login === undefined ? undefined : await options.provider.permission(login);
	const authorPermission =
		pullRequest.author === undefined
			? undefined
			: pullRequest.author === login
				? permission
				: await options.provider.permission(pullRequest.author);
	const publishedBy: PublishedBy = {
		trustedWriters: options.trustedWriters,
		...(login === undefined ? {} : { login }),
		...(permission === undefined ? {} : { permission }),
		...(authorPermission === undefined ? {} : { authorPermission }),
	};

	const destination = {
		repository: `${pullRequest.repository.owner}/${pullRequest.repository.name}`,
		pullRequest: pullRequest.number,
		baseRef: pullRequest.base.ref,
		baseTip: pullRequest.base.sha,
		base: options.base,
		head,
		revision,
	};
	// Recorded before any earlier task resumes, so one a crash left for another target ends superseded, posting nothing.
	const target = await (await harness.root(context)).commit(async (tx) => {
		const rounds = await new RoundWriter(tx, root).preserve(revision);
		if (
			(rounds.current[revision] ?? legacyKey(revision)) !== validated.roundId ||
			!isDeepStrictEqual(rounds.items[validated.roundId]?.verdict, validated.verdict)
		) {
			throw new PublishError(
				"notReviewed",
				`a newer round exists or its verdict changed; run melian publish "#${pullRequest.number}" again`,
				where,
			);
		}
		const target: PublishTarget = { ...destination, roundId: validated.roundId };
		const publisher = await tx.doc(PublisherDocument, root);
		publisher.secret ??= randomBytes(32).toString("hex");
		publisher.target = { ...target };
		publisher.publishedBy = { ...publishedBy };
		return target;
	}, context);
	harness.resume();
	const unfinished = async () =>
		(await harness.inspect(context)).tasks.filter((each) => each.record.kind === publishTaskName);
	const superseded: SupersededPublication[] = [];
	const resumed: AttestedRound[] = [];
	for (const each of await unfinished()) {
		if (each.state.kind === "blocked") continue;
		const { outcome } = (await harness.waitForTask(each.record.id, context)).state;
		const result = outcome.status === "completed" ? (outcome.result as PublishOutcome) : undefined;
		if (result?.kind === "superseded") superseded.push({ task: String(each.record.id), reason: result.reason });
		if (result?.kind === "published" || result?.kind === "staleTarget") resumed.push(...result.attestations);
		if (outcome.status === "failed") resumed.push(...failedAttestations(outcome.error.detail));
	}
	const input = new PublishInput({
		publishedBy,
		root,
		target,
		lines: changeset.revision.diffLines(),
		...(options.walkthrough === undefined ? {} : { walkthrough: { ...options.walkthrough } }),
	}).toJSON();
	const taskId = await (await harness.root(context)).commit(
		(tx) => tx.createTask(publishTask(options.provider), input, { ownership: { kind: "conversation" } }),
		context,
	);
	harness.resume();
	const blocked = (await unfinished()).some(
		(each) => each.record.id === (taskId as TaskId) && each.state.kind === "blocked",
	);
	if (blocked) {
		await harness.abortTask(taskId, context);
		throw new PublishError(
			"notInstalled",
			"the harness has no melian.publish extension; install publishExtension",
			where,
		);
	}
	const { outcome } = (await harness.waitForTask(taskId, context)).state;
	if (outcome.status === "completed") {
		const { result } = outcome;
		if (result.kind === "published") {
			const { kind: _, ...published } = result;
			return {
				...published,
				attestations: [
					...new Map(
						[...resumed, ...published.attestations].map((round) => [JSON.stringify(round), round]),
					).values(),
				],
				dismissed: published.dismissed ?? 0,
				superseded,
			};
		}
		throw new PublishError(
			"staleTarget",
			`pull request #${pullRequest.number} changed while Melian published it, so publication stopped: ${result.reason}; ${again}`,
			{ ...where, attestations: [...resumed, ...(result.kind === "staleTarget" ? result.attestations : [])] },
		);
	}
	const why = outcome.status === "failed" ? outcome.error.message : outcome.status;
	throw new PublishError("publishFailed", `publishing to pull request #${pullRequest.number} stopped: ${why}`, {
		...where,
		attestations: [...resumed, ...(outcome.status === "failed" ? failedAttestations(outcome.error.detail) : [])],
	});
}
