import {
	type Changeset,
	diffLines,
	type PostedReview,
	type PublishedMarkers,
	type PullRequest,
	planPublication,
	type ReviewProvider,
	type ReviewStatus,
	reviewStatus,
} from "@melian-agent/core";
import { readVerdict } from "./adjudication.ts";
import { PublishError } from "./errors.ts";
import {
	backgroundContext,
	type Context,
	type ConversationId,
	type DocumentReader,
	defineDoc,
	defineExtension,
	defineTask,
	type Harness,
	type TaskId,
} from "./harness.ts";

// Type aliases with mutable arrays, not core's interfaces: a document's value must satisfy Pi's JsonObject.
type StoredFinding = { ruleId: string; path: string; line: number; revision: string; thread?: string };

type StoredRevision = {
	review: string;
	open: Record<string, StoredFinding>;
	resolved: Record<string, StoredFinding>;
	replies: Record<string, string>;
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

type PublishInput = {
	root: ConversationId;
	pullRequest: number;
	head: string;
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
};

const publishTaskName = "melian.publish";

function same(left: ReviewStatus | undefined, right: ReviewStatus): boolean {
	return left?.state === right.state && left.description === right.description;
}

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
				const { root, pullRequest, head, lines } = task.input;
				const read = async () =>
					(await runtime.snapshot(PublishedDocument, root, context)) ?? { order: [], revisions: {} };
				let markers: PublishedMarkers | undefined;
				const marked = async () => {
					markers ??= await provider.findPublished(pullRequest, head);
					return markers;
				};
				const result = { posted: 0, stillOpen: 0, resolved: 0, replies: 0, recovered: 0 };
				try {
					const verdict = await readVerdict(runtime, root, head, context);
					if (verdict === undefined) throw new Error(`no verdict is recorded for ${head}`);
					let state = await read();
					if (!Object.hasOwn(state.revisions, head)) {
						const previous = state.order.filter((each) => each !== head).at(-1);
						const plan = planPublication(
							verdict,
							previous === undefined ? {} : state.revisions[previous]!.open,
							lines,
							head,
						);
						const found = await marked();
						let posted: PostedReview;
						if (found.review === undefined) {
							posted = await provider.postReview({
								pullRequest,
								revision: head,
								verdict,
								findings: plan.post,
								stillOpen: plan.stillOpen.length,
								resolved: plan.resolved.filter((each) => each.thread === undefined),
							});
							result.posted = plan.post.length;
						} else {
							posted = { id: found.review, threads: found.threads };
							result.recovered++;
						}
						const open = Object.fromEntries(
							Object.entries(plan.open).map(([id, entry]): [string, StoredFinding] => {
								const thread = entry.revision === head ? posted.threads[id] : entry.thread;
								return [id, { ...entry, ...(thread === undefined ? {} : { thread }) }];
							}),
						);
						const resolved = Object.fromEntries(plan.resolved.map(({ id, ...entry }) => [id, { ...entry }]));
						await runtime.commit(async (tx) => {
							const document = await tx.doc(PublishedDocument, root);
							document.order = [...document.order.filter((each) => each !== head), head];
							document.revisions[head] = { review: posted.id, open, resolved, replies: {} };
							return undefined;
						}, context);
						state = await read();
					}
					const record = state.revisions[head]!;
					result.stillOpen = Object.values(record.open).filter((entry) => entry.revision !== head).length;
					result.resolved = Object.keys(record.resolved).length;
					for (const id of Object.keys(record.resolved).sort()) {
						const entry = record.resolved[id]!;
						if (entry.thread === undefined || Object.hasOwn(record.replies, id)) continue;
						let reply = (await marked()).replies[id];
						if (reply === undefined) {
							reply = await provider.replyResolved(pullRequest, { id, ...entry, thread: entry.thread }, head);
							result.replies++;
						} else result.recovered++;
						const recorded = reply;
						await runtime.commit(async (tx) => {
							(await tx.doc(PublishedDocument, root)).revisions[head]!.replies[id] = recorded;
							return undefined;
						}, context);
					}
					const status = reviewStatus(verdict);
					if (!same(record.status, status)) await provider.setStatus(head, status);
					await runtime.commit(async (tx) => {
						(await tx.doc(PublishedDocument, root)).revisions[head]!.status = { ...status };
						const done: PublishResult = { review: record.review, status, ...result };
						return { status: "terminal", outcome: { status: "completed", result: done } };
					}, context);
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					// Everything posted so far is recorded, so the outcome is the failure, and publishing again resumes.
					const failure = { message: error instanceof Error ? error.message : String(error) };
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "failed", error: failure } }),
						context,
					);
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

/** What {@link publishReview} publishes. */
export interface PublishOptions {
	/** A harness over the changeset's storage, with {@link publishExtension} for `provider` installed. */
	readonly harness: Harness;
	readonly provider: ReviewProvider;
	/** The pull request's changeset, reviewed at the pull request's head. */
	readonly changeset: Changeset;
	/** The pull request as its provider reports it now. */
	readonly pullRequest: PullRequest;
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
}

/** What a revision's publication recorded: its review, each posted finding's thread, its replies, and status. */
export interface PublishedRecord {
	readonly review: string;
	readonly threads: Readonly<Record<string, string>>;
	readonly replies: Readonly<Record<string, string>>;
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
	const { review, open, replies, status } = document.revisions[revision]!;
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
 * Throws {@link PublishError}: `staleReview` when the changeset's head is not the pull request's, `notReviewed` when no
 * verdict is recorded for that head, `notInstalled` when the harness lacks {@link publishExtension}, and
 * `publishFailed` when the provider refused a post.
 */
export async function publishReview(options: PublishOptions): Promise<Publication> {
	const { harness, changeset, pullRequest } = options;
	const context = options.context ?? backgroundContext;
	const head = pullRequest.head.sha;
	const where = { pullRequest: pullRequest.number, revision: head };
	const again = `run melian review #${pullRequest.number} first`;
	if (changeset.revision.head !== head) {
		throw new PublishError(
			"staleReview",
			`pull request #${pullRequest.number} is at ${short(head)}, but Melian reviewed ${short(changeset.revision.head)}; ${again}`,
			where,
		);
	}
	const root = (await harness.root(context)).id;
	if ((await readVerdict(harness, root, head, context)) === undefined) {
		throw new PublishError("notReviewed", `Melian has no review of ${short(head)}; ${again}`, where);
	}
	harness.resume();
	const unfinished = async () =>
		(await harness.inspect(context)).tasks.filter((each) => each.record.kind === publishTaskName);
	for (const each of await unfinished()) {
		if (each.state.kind === "blocked") break;
		await harness.waitForTask(each.record.id, context);
	}
	const input: PublishInput = {
		root,
		pullRequest: pullRequest.number,
		head,
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
