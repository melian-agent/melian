import { type Finding, renderFindings, renderSummary } from "./render.ts";

/** Prints a review's findings, read from the JSON a review of a pull request wrote. */
export function printReview(findings: readonly Finding[]): void {
	process.stdout.write(`${renderFindings(findings)}\n\n${renderSummary(findings)}\n`);
}
