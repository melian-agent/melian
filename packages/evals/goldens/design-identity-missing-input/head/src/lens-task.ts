export type LensTaskInput = {
	lens: string;
	lensVersion: string;
	head: string;
	band: "quick" | "careful" | "deep";
	route: string;
	instructions: string;
};

export type LensResult = { findings: string[] };

export type Conversation = (input: LensTaskInput) => Promise<LensResult>;

export interface TaskStore {
	find(key: string): Promise<LensResult | undefined>;
	save(key: string, result: LensResult): Promise<void>;
}

export function selectionKey(input: LensTaskInput): string {
	return [input.lens, input.lensVersion, input.head, input.band, input.route].join(" ");
}

export async function runLens(store: TaskStore, input: LensTaskInput, converse: Conversation): Promise<LensResult> {
	const key = selectionKey(input);
	const finished = await store.find(key);
	if (finished !== undefined) return finished;
	const result = await converse(input);
	await store.save(key, result);
	return result;
}
