import { defineDoc } from "./harness.ts";

// Type aliases, not interfaces: a document's value must satisfy Pi's JsonObject, which an interface never does.
type IndexedReview = {
	// The lens task, absent when the review selected no lens.
	task?: number;
	// The selected lenses by `name@version`, sorted.
	lenses: string[];
	// The adjudication task and its input as JSON, so a repeat call with the same input attaches to it.
	adjudication?: { task: number; input: string };
};

export type ReviewIndexState = { reviews: Record<string, IndexedReview> };

// Which tasks reviewed each revision, keyed by `revisionKey` of its base and head, and with which lenses. Kept on the
// root conversation, so a later call for the same revision and lenses finds the tasks, whether they finished, are
// running, or crashed. A head retargeted onto another base is another revision, with tasks of its own.
export const ReviewIndex = defineDoc<ReviewIndexState>({
	kind: "melian.reviews",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ reviews: {} }),
});
