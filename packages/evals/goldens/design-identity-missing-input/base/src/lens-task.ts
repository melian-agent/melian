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

export async function runLens(input: LensTaskInput, converse: Conversation): Promise<LensResult> {
	return converse(input);
}
