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

// Which tasks reviewed each head, and with which lenses. Kept on the root conversation, so a later call for the same
// head and lenses finds the tasks, whether they finished, are running, or crashed.
export const ReviewIndex = defineDoc<ReviewIndexState>({
	kind: "melian.reviews",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ reviews: {} }),
});
