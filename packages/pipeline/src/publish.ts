import { createHash } from "node:crypto";
import {
	type Changeset,
	diffLines,
	type Finding,
	type Placement,
	type PostedReview,
	type PublishedMarkers,
	type PullRequest,
	planPublication,
	type ReviewProvider,
	type ReviewStatus,
	reviewStatus,
	type Verdict,
} from "@melian-agent/core";
import { readVerdict, type StoredVerdict } from "./adjudication.ts";
import { PublishError } from "./errors.ts";
import { revisionKey } from "./findings.ts";
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
} from "./harness.ts";
import { modelsOf, type ReviewModels } from "./models.ts";

// Type aliases with mutable arrays, not core's interfaces: a document's value must satisfy Pi's JsonObject.
type StoredFinding = { ruleId: string; path: string; line: number; revision: string; thread?: string };

// What one round of a revision will post, committed before posting so a rerun posts exactly this: the verdict it
// renders as well as its findings, since the head's verdict can change before a failed round is posted again.
type PendingRound = {
	fingerprint: string;
	verdict: StoredVerdict;
	post: { finding: Finding; placement: Placement }[];
	stillOpen: number;
	open: Record<string, StoredFinding>;
	resolved: Record<string, StoredFinding>;
	// How many times the provider refused to post it.
	refusals: number;
};

// A round the provider refused `maxRefusals` times. It is dropped so the next publish of the head plans afresh.
type AbandonedRound = { fingerprint: string; refusals: number; error: string };

const maxRefusals = 3;

type StoredRevision = {
	// One review per verdict published at this head: a second review of the same head can change the verdict.
	reviews: string[];
	// The fingerprint of the verdict the last review posted.
	verdict?: string;
	pending?: PendingRound;
	abandoned?: AbandonedRound[];
	open: Record<string, StoredFinding>;
	resolved: Record<string, StoredFinding>;
	// null when the thread was gone and there was nothing to reply to.
	replies: Record<string, string | null>;
	status?: { state: ReviewStatus["state"]; description: string };
};

type PublishedState = { order: string[]; revisions: Record<string, StoredRevision> };

// Keeps its latest value and forks as it stands: a post is a fact about the pull request, and a fork that forgot one
// would post it twice.
export const PublishedDocument = defineDoc<PublishedState>({
	kind: "melian.published",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ order: [], revisions: {} }),
});

function fingerprint(verdict: Verdict): string {
	return createHash("sha256").update(JSON.stringify(verdict)).digest("hex").slice(0, 16);
}

// Resolutions an earlier head decided but never replied to, because a later push arrived first. They are still owed.
// A thread is answered once any revision replied in it, so a resolution carried forward is not carried again.
function unanswered(state: PublishedState, head: string): Record<string, StoredFinding> {
	const answered = new Set<string>();
	for (const { resolved, replies } of Object.values(state.revisions)) {
		for (const id of Object.keys(replies)) answered.add(`${id} ${resolved[id]?.thread}`);
	}
	const owed: Record<string, StoredFinding> = {};
	for (const each of state.order) {
		if (each === head) continue;
		for (const [id, entry] of Object.entries(state.revisions[each]!.resolved)) {
			if (entry.thread !== undefined && !answered.has(`${id} ${entry.thread}`)) owed[id] = entry;
		}
	}
	return owed;
}

// The round to post for `verdict` at `head`: against the head's own open findings if it was published before, else
// against the previous head's, with any resolution an earlier head still owes.
function planRound(
	state: PublishedState,
	head: string,
	verdict: Verdict,
	lines: Record<string, [number, number][]>,
): PendingRound {
	const own = state.revisions[head];
	const previous = state.order.filter((each) => each !== head).at(-1);
	const base = own?.open ?? (previous === undefined ? {} : state.revisions[previous]!.open);
	const plan = planPublication(verdict, base, lines, head);
	const resolved: Record<string, StoredFinding> = Object.fromEntries(
		plan.resolved.map(({ id, ...entry }) => [id, { ...entry }]),
	);
	if (own === undefined) {
		const held = new Set(
			[...Object.values(verdict.findings).flat(), ...verdict.dismissed].map((finding) => finding.properties.id),
		);
		for (const [id, entry] of Object.entries(unanswered(state, head))) {
			if (!held.has(id) && !Object.hasOwn(plan.open, id)) resolved[id] ??= { ...entry };
		}
	}
	return {
		fingerprint: fingerprint(verdict),
		verdict: structuredClone(verdict) as StoredVerdict,
		post: structuredClone(plan.post.map(({ finding, placement }) => ({ finding, placement }))),
		stillOpen: plan.stillOpen.length,
		open: Object.fromEntries(Object.entries(plan.open).map(([id, entry]) => [id, { ...entry }])),
		resolved,
		refusals: 0,
	};
}

type PublishInput = {
	root: ConversationId;
	pullRequest: number;
	head: string;
	// The review whose verdict this publishes: the revisionKey of its base and head.
	revision: string;
	lines: Record<string, [number, number][]>;
};

type PublishResult = {
	review: string;
	posted: number;
	stillOpen: number;
	resolved: number;
	replies: number;
	status: ReviewStatus;
	// Posts found by their markers rather than in the document: a crash fell between post and record.
	recovered: number;
	abandoned: AbandonedRound[];
};

const publishTaskName = "melian.publish";

// Not replay-safe: a post and the commit that records it are two steps, and the host takes no idempotency key. Every
// post is recorded in its own commit, and before posting anything the phase reads Melian's markers back from the pull
// request, so a rerun after a crash between a post and its record finds the post instead of repeating it.
function publishTask(provider: ReviewProvider) {
	return defineTask<PublishInput, { phase: "publish" }, PublishResult>({
		name: publishTaskName,
		version: 1,
		initial: () => ({ phase: "publish" }),
		phases: {
			publish: async (task, runtime, context) => {
				const { root, pullRequest, head, revision, lines } = task.input;
				const read = async () =>
					(await runtime.snapshot(PublishedDocument, root, context)) ?? { order: [], revisions: {} };
				const markers = new Map<string, PublishedMarkers>();
				const marked = async (verdict: string) => {
					if (!markers.has(verdict))
						markers.set(verdict, await provider.findPublished(pullRequest, head, verdict));
					return markers.get(verdict)!;
				};
				const result = { posted: 0, stillOpen: 0, resolved: 0, replies: 0, recovered: 0 };
				// Set while the provider is asked to post a round, so a refusal counts against that round.
				let posting = false;
				try {
					const verdict = await readVerdict(runtime, root, revision, context);
					if (verdict === undefined) throw new Error(`no verdict is recorded for ${revision}`);
					const current = fingerprint(verdict);
					// A pending round left by a failed run is posted as planned, under its own verdict. If the head's verdict
					// changed since, a second round then posts the current one, so the last review matches the status.
					for (let round = 0; round < 2; round++) {
						const state = await read();
						const before = state.revisions[head];
						if (before?.pending === undefined) {
							if (before?.verdict === current) break;
							const planned = planRound(state, head, verdict, lines);
							await runtime.commit(async (tx) => {
								const document = await tx.doc(PublishedDocument, root);
								document.order = [...document.order.filter((each) => each !== head), head];
								const existing = document.revisions[head] ?? {
									reviews: [],
									open: {},
									resolved: {},
									replies: {},
								};
								document.revisions[head] = { ...existing, pending: planned };
								return undefined;
							}, context);
						}
						const pending = (await read()).revisions[head]!.pending!;
						result.stillOpen = pending.stillOpen;
						const found = await marked(pending.fingerprint);
						let posted: PostedReview;
						if (found.review === undefined) {
							posting = true;
							posted = await provider.postReview({
								pullRequest,
								revision: head,
								fingerprint: pending.fingerprint,
								verdict: pending.verdict,
								findings: pending.post,
								stillOpen: pending.stillOpen,
								resolved: Object.entries(pending.resolved)
									.filter(([, entry]) => entry.thread === undefined)
									.map(([id, entry]) => ({ id, ...entry })),
							});
							posting = false;
							result.posted += pending.post.length;
						} else {
							posted = { id: found.review, threads: found.threads };
							result.recovered++;
						}
						const open = Object.fromEntries(
							Object.entries(pending.open).map(([id, entry]): [string, StoredFinding] => {
								const thread = entry.thread ?? (entry.revision === head ? posted.threads[id] : undefined);
								return [id, { ...entry, ...(thread === undefined ? {} : { thread }) }];
							}),
						);
						await runtime.commit(async (tx) => {
							const record = (await tx.doc(PublishedDocument, root)).revisions[head]!;
							record.reviews = [...record.reviews, posted.id];
							record.verdict = pending.fingerprint;
							record.open = open;
							record.resolved = { ...record.resolved, ...pending.resolved };
							delete record.pending;
							return undefined;
						}, context);
					}
					const record = (await read()).revisions[head]!;
					result.resolved = Object.keys(record.resolved).length;
					// The status comes before the replies, so a thread that cannot take a reply never holds back the check.
					const status = reviewStatus(verdict);
					if (record.status?.state !== status.state || record.status.description !== status.description) {
						await provider.setStatus(head, status);
						await runtime.commit(async (tx) => {
							(await tx.doc(PublishedDocument, root)).revisions[head]!.status = { ...status };
							return undefined;
						}, context);
					}
					for (const id of Object.keys(record.resolved).sort()) {
						const entry = record.resolved[id]!;
						if (entry.thread === undefined || Object.hasOwn(record.replies, id)) continue;
						const found = (await marked(record.verdict ?? "")).replies[id];
						let recorded: string | null;
						if (found === undefined) {
							const reply = await provider.replyResolved(
								pullRequest,
								{ id, ...entry, thread: entry.thread },
								head,
							);
							recorded = reply ?? null;
							if (reply !== undefined) result.replies++;
						} else {
							recorded = found;
							result.recovered++;
						}
						await runtime.commit(async (tx) => {
							(await tx.doc(PublishedDocument, root)).revisions[head]!.replies[id] = recorded;
							return undefined;
						}, context);
					}
					await runtime.commit(() => {
						const abandoned = structuredClone(record.abandoned ?? []);
						const done: PublishResult = { review: record.reviews.at(-1)!, status, ...result, abandoned };
						return { status: "terminal", outcome: { status: "completed", result: done } };
					}, context);
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					// Everything posted so far is recorded, so the outcome is the failure, and publishing again resumes. A round
					// the provider keeps refusing, such as one whose comment GitHub rejects with a 422, would block every later
					// publish of the head, so its third refusal abandons it and the next publish plans a new round.
					let message = error instanceof Error ? error.message : String(error);
					await runtime.commit(async (tx) => {
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
								message = `the provider refused the review of verdict ${refused} ${refusals} times, so Melian abandoned it and the next publish plans a new one: ${message}`;
							}
						}
						return { status: "terminal", outcome: { status: "failed", error: { message } } };
					}, context);
				}
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
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
 * Opens a harness over `storage` that publishes through `provider` and holds nothing else, so a review a crash
 * interrupted does not resume in it and spend tokens on real models during a publish.
 */
export function openPublishHarness(
	storage: Storage,
	models: ReviewModels,
	provider: ReviewProvider,
	context: Context = backgroundContext,
): Promise<Harness> {
	const registry = createRegistry();
	registry.install(publishExtension(provider));
	return openHarness(storage, { models: modelsOf(models), registry }, context);
}

/** What {@link publishReview} publishes. */
export interface PublishOptions {
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
	readonly context?: Context;
}

/** What {@link publishReview} did. Counts cover this run; a second publish of one revision posts nothing. */
export interface Publication {
	readonly review: string;
	readonly posted: number;
	readonly stillOpen: number;
	readonly resolved: number;
	readonly replies: number;
	readonly status: ReviewStatus;
	readonly recovered: number;
	/**
	 * Every round of this head the provider refused three times, so Melian gave it up, with the last error. A later
	 * round planned afresh carries its findings, so they reach the pull request once the provider accepts one.
	 */
	readonly abandoned: readonly AbandonedReview[];
}

/** A review of a head that Melian gave up posting: the verdict it named, how often it was refused, and why. */
export interface AbandonedReview {
	readonly fingerprint: string;
	readonly refusals: number;
	readonly error: string;
}

/** What a revision's publication recorded: its review, each posted finding's thread, its replies, and status. */
export interface PublishedRecord {
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
	const { reviews, open, replies, status } = document.revisions[revision]!;
	const review = reviews.at(-1);
	if (review === undefined) return undefined;
	const threads = Object.fromEntries(
		Object.entries(open).flatMap(([id, entry]) =>
			entry.revision === revision && entry.thread !== undefined ? [[id, entry.thread]] : [],
		),
	);
	return structuredClone({ review, threads, replies, ...(status === undefined ? {} : { status }) });
}

function short(commit: string): string {
	return commit.slice(0, 12);
}

/**
 * Publishes the verdict recorded for a pull request's head: one review whose body is the verdict and whose comments
 * are the findings not already open, a reply in each resolved finding's thread, and the review's status. Every post is
 * recorded in {@link PublishedDocument}, so publishing a revision again posts nothing, and a publication a crash
 * interrupted resumes, finding what it already posted by Melian's markers.
 *
 * The verdict is the one recorded for the changeset's base and head, its {@link revisionKey}, so a review of the pull
 * request before its base branch moved under it, or before it was retargeted, is never posted as a review of what it
 * shows now.
 *
 * Throws {@link PublishError}: `staleReview` when the changeset's head or base is not the pull request's, `notReviewed`
 * when no verdict is recorded for that base and head, `notInstalled` when the harness lacks {@link publishExtension}, and
 * `publishFailed` when the provider refused a post.
 */
export async function publishReview(options: PublishOptions): Promise<Publication> {
	const { harness, changeset, pullRequest } = options;
	const context = options.context ?? backgroundContext;
	const head = pullRequest.head.sha;
	const where = { pullRequest: pullRequest.number, revision: head };
	const again = `run melian review '#${pullRequest.number}' first`;
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
			`pull request #${pullRequest.number} now diffs from ${short(options.base)} on ${pullRequest.base.ref}, but Melian reviewed it from ${short(changeset.revision.base)}; its base branch moved or it was retargeted; run melian review '#${pullRequest.number}' again`,
			where,
		);
	}
	const revision = revisionKey(changeset.revision);
	const root = (await harness.root(context)).id;
	if ((await readVerdict(harness, root, revision, context)) === undefined) {
		throw new PublishError(
			"notReviewed",
			`Melian has no review of ${short(head)} from ${short(changeset.revision.base)}; ${again}`,
			where,
		);
	}
	harness.resume();
	const unfinished = async () =>
		(await harness.inspect(context)).tasks.filter((each) => each.record.kind === publishTaskName);
	for (const each of await unfinished()) {
		if (each.state.kind === "blocked") continue;
		await harness.waitForTask(each.record.id, context);
	}
	const input: PublishInput = {
		root,
		pullRequest: pullRequest.number,
		head,
		revision,
		lines: diffLines(changeset.revision.files),
	};
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
	if (outcome.status === "completed") return outcome.result;
	const why = outcome.status === "failed" ? outcome.error.message : outcome.status;
	throw new PublishError("publishFailed", `publishing to pull request #${pullRequest.number} stopped: ${why}`, where);
}
