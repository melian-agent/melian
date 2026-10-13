/**
 * What a live run prints for one golden beyond its score: the review's own rendering, indented, when
 * `MELIAN_EVAL_SHOW=1`, and nothing otherwise. A score says a golden failed; the rendering says which finding a lens
 * reported, or why the verifier left a claim unjudged.
 */
/** A verifier golden's verdict as a live run prints it: the verdict, or `unjudged` with the reason the check recorded. */
export function verdictLabel(verdict: string | undefined, unjudged: string | undefined): string {
	return verdict ?? `unjudged (${unjudged ?? "no reason recorded"})`;
}

export function shownOutput(rendered: string, env: NodeJS.ProcessEnv = process.env): string[] {
	if (env.MELIAN_EVAL_SHOW !== "1") return [];
	return rendered
		.trimEnd()
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`));
}
