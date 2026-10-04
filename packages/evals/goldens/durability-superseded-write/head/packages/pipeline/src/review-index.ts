import { defineDoc } from "./harness.ts";

// A type alias, not an interface: a document's value must satisfy Pi's JsonObject.
type IndexedRevision = { adjudication?: number; walkthrough?: number };

// Which task last started each step of each revision, on the root conversation, so a task can tell in its final commit
// whether a newer one has replaced it.
export const ReviewIndex = defineDoc<{ revisions: Record<string, IndexedRevision> }>({
	kind: "melian.reviews",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ revisions: {} }),
});
