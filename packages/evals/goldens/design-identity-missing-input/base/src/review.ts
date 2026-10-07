import { type Conversation, type LensResult, type LensTaskInput, runLens } from "./lens-task.ts";

export async function reviewLenses(inputs: LensTaskInput[], converse: Conversation): Promise<LensResult[]> {
	return Promise.all(inputs.map((input) => runLens(input, converse)));
}
