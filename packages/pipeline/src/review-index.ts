import type { CoverageIds } from "@melian-agent/core";
import { defineDoc, type TaskId, type Tx } from "./harness.ts";

// Type aliases, not interfaces: a document's value must satisfy Pi's JsonObject, which an interface never does.
type IndexedReview = {
	// The lens task, absent when the review selected no lens.
	task?: number;
	// The selected lenses by `name@version@level`, each with the band its level was held to, the severity that escalates
	// it, where a quick run escalates, and `on <route>` last, sorted: a review at another level, route, band, or `escalateAt` is
	// another selection. An entry an older Melian recorded names `name@version`, with no route in a version 2 entry, and
	// no review after the upgrade attaches to it.
	lenses: string[];
	// The adjudication task and its input as JSON, so a repeat call with the same input attaches to it.
	adjudication?: { task: number; input: string };
	verification?: { task: number; input: string };
	callers?: CallerRecord;
};

// The caller notes and coverage the first call that finished a lens task rendered into its records, by lens
// `name@version`. A repeat call reads them back, so its records, adjudication input and verdict fingerprint match the
// first call's whatever the graph cache holds by then.
export type CallerRecord = {
	notes: Record<string, string[]>;
	coverage?: CoverageIds;
	coverageUnavailable?: true;
	// The lens task the record was computed from; a record of another task is stale.
	task?: number;
};

export type ReviewIndexState = { reviews: Record<string, IndexedReview> };

// Which tasks reviewed each revision, keyed by `revisionKey` of its base and head, and with which lenses. Kept on the
// root conversation, so a later call for the same revision and lenses finds the tasks, whether they finished, are
// running, or crashed. A head retargeted onto another base is another revision, with tasks of its own.
// Version 3 keys each selected lens by its route too. An entry stored before reads unchanged and never matches a
// selection, so a review harness aborts its task as it opens, before anything resumes it, and the next review of its
// revision replaces it and drops its sightings.
export const ReviewIndex = defineDoc<ReviewIndexState>({
	kind: "melian.reviews",
	version: 3,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ reviews: {} }),
	migrate: (value) => value as ReviewIndexState,
});

// Outcomes that decided nothing: a cancelled task, one that broke the task contract, and one whose definition is gone.
export const undecided: readonly string[] = ["aborted", "faulted", "orphaned"];

// Whether a repeat call may attach to the task the index names: one that is live, crashed, or decided something, and
// whose outcome is not one of `retry`. A task that ended without deciding would hand every later call the same
// non-result.
export async function attachable(tx: Tx, id: number | undefined, retry: readonly string[]): Promise<boolean> {
	if (id === undefined) return false;
	const record = await tx.task(id as TaskId);
	if (record === undefined) return false;
	return record.state.status !== "terminal" || !retry.includes(record.state.outcome.status);
}
