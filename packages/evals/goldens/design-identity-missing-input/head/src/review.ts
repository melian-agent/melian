import { type Conversation, type LensResult, type LensTaskInput, runLens, type TaskStore } from "./lens-task.ts";

export async function reviewLenses(
	store: TaskStore,
	inputs: LensTaskInput[],
	converse: Conversation,
): Promise<LensResult[]> {
	return Promise.all(inputs.map((input) => runLens(store, input, converse)));
}
