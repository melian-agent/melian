import { type Decider, Decision, type DecisionRequest, type StoredDecision } from "@melian-agent/core";
import {
	type Context,
	type ConversationId,
	type DocumentReader,
	defineDoc,
	defineExtension,
	defineTask,
} from "./harness.ts";

// Type aliases, not interfaces: a document's value must satisfy Pi's JsonObject, which an interface never does.

// One question set's decision for a revision: the task that decides it, what it was asked as `key`, and, once the task
// has run, the decision with its whole distribution, or why the decider gave none.
type StoredEntry = { key: string; task: number; decision?: StoredDecision; failure?: string };

type DecisionState = { decisions: Record<string, Record<string, StoredEntry>> };

// Each revision's decisions, keyed by `revisionKey` of its base and head, then by question set, on the changeset's root
// conversation. Rewindable, so a fork of the root at a revision carries the decisions its review was made with.
export const DecisionDocument = defineDoc<DecisionState>({
	kind: "melian.decisions",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ decisions: {} }),
});

// A request as a task's input holds it.
type StoredRequest = {
	questionSet: { name: string; version: string };
	state: string;
	questions: { id: string; text: string; options: string[] }[];
};

export type DecisionTaskInput = { root: ConversationId; revision: string; key: string; request: StoredRequest };

// `superseded` when a later call recorded another task for the revision's question set, so this one wrote nothing.
export type DecisionResult = "recorded" | "superseded";

// How long a decider may take before the decision fails closed.
const decisionTimeout = 120_000;

export const decisionTaskName = "melian.decision";

// The longest failure a decision stores, which reaches every lens's record and the review body: a provider's error can
// quote what a model said, and a record is no place for a page of it.
const maxFailure = 200;

// One question set's decision on one revision. The decider is asked in the phase and its answer committed with the
// task's outcome, so a crash before the commit asks again and a repeat call attaches to the task: replay safe. A
// decider that throws, times out, or answers what was not asked is recorded as a failure, and the caller fails closed.
export function decisionTask(decider: Decider, timeout = decisionTimeout) {
	return defineTask<DecisionTaskInput, { phase: "decide" }, DecisionResult>({
		name: decisionTaskName,
		version: 1,
		initial: () => ({ phase: "decide" }),
		phases: {
			decide: async (task, runtime, context) => {
				const { root, revision, key, request } = task.input;
				const timedOut = AbortSignal.timeout(timeout);
				const signal = AbortSignal.any([runtime.signal, timedOut]);
				// A decider that ignores its signal would otherwise hold the task open past the timeout.
				const expired = new Promise<never>((_, reject) => {
					signal.addEventListener(
						"abort",
						() =>
							reject(
								timedOut.aborted ? new Error(`the decider did not answer within ${timeout} ms`) : signal.reason,
							),
						{ once: true },
					);
				});
				expired.catch(() => undefined);
				let answer: Pick<StoredEntry, "decision" | "failure">;
				// The registry holds the decider the harness opened with, whatever the input's key names, so asking it would
				// record another decider's answer under this key.
				const named = (JSON.parse(key) as { decider?: unknown }).decider;
				if (named !== decider.name) {
					answer = {
						failure: `the decision was asked of ${String(named)}, but this harness holds ${decider.name}; open the harness with the same decider`,
					};
				} else {
					try {
						const decided = await Promise.race([decider.decide(request as DecisionRequest, signal), expired]);
						answer = { decision: Decision.parse(request as DecisionRequest, decided, decider).toJSON() };
					} catch (error) {
						if (runtime.signal.aborted) throw error;
						const failure = error instanceof Error ? error.message : String(error);
						answer = { failure: failure.length <= maxFailure ? failure : `${failure.slice(0, maxFailure - 1)}…` };
					}
				}
				await runtime.commit(async (tx) => {
					const document = await tx.doc(DecisionDocument, root);
					const entries = document.decisions[revision] ?? {};
					const entry = entries[request.questionSet.name];
					if (entry?.task !== runtime.taskId) {
						return { status: "terminal", outcome: { status: "completed", result: "superseded" } };
					}
					const decided = { ...entries, [request.questionSet.name]: { ...entry, ...answer } };
					document.decisions = { ...document.decisions, [revision]: decided };
					return { status: "terminal", outcome: { status: "completed", result: "recorded" } };
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}

/**
 * The extension a review harness needs to decide through `decider`: the decision task, which asks it and stores the
 * whole distribution. `ReviewHarness.open` installs it when given a decider; install it again after a restart, so an
 * interrupted decision resumes. `timeout`, in milliseconds, is how long the decider may take before the decision fails
 * closed; tests shorten it.
 */
export function decisionExtension(decider: Decider, timeout?: number) {
	return defineExtension({ name: decisionTaskName, tasks: [decisionTask(decider, timeout)] });
}

/** A question set's decision on a revision as stored: the task that made it, and the decision or why there is none. */
export type RecordedDecision = {
	readonly task: number;
	readonly decision?: Decision;
	readonly failure?: string;
};

/**
 * The decision `questionSet` holds for `revision`, a `revisionKey`, as the root conversation's decision document
 * records it, or `undefined` when none was asked. A decision still being made has neither `decision` nor `failure`.
 */
export async function readRecordedDecision(
	reader: Pick<DocumentReader, "snapshot">,
	rootConversationId: ConversationId,
	revision: string,
	questionSet: string,
	context: Context,
): Promise<RecordedDecision | undefined> {
	const entries = (await reader.snapshot(DecisionDocument, rootConversationId, context))?.decisions[revision];
	const entry = entries === undefined || !Object.hasOwn(entries, questionSet) ? undefined : entries[questionSet];
	if (entry === undefined) return undefined;
	return {
		task: entry.task,
		...(entry.decision === undefined ? {} : { decision: Decision.from(structuredClone(entry.decision)) }),
		...(entry.failure === undefined ? {} : { failure: entry.failure }),
	};
}
