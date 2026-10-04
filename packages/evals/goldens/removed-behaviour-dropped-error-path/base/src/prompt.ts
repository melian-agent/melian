import { readStandards } from "./standards.ts";

/** The reviewer's instructions for `root`, with the repository's standards when it has any. */
export function instructions(root: string): string {
	const standards = readStandards(root);
	return standards === undefined
		? "Review the change. This repository has written no standards."
		: `Review the change against these standards:\n\n${standards}`;
}
