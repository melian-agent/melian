/**
 * What a live run prints for one golden beyond its score: the review's own rendering, indented, when
 * `MELIAN_EVAL_SHOW=1`, and nothing otherwise. A score says a golden failed; the rendering says which finding a lens
 * reported, or why the verifier left a claim unjudged.
 */
export function shownOutput(rendered: string, env: NodeJS.ProcessEnv = process.env): string[] {
	if (env.MELIAN_EVAL_SHOW !== "1") return [];
	return rendered
		.trimEnd()
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`));
}
