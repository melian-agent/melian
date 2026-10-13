// A score says a golden failed; these say which finding a lens reported, or why the verifier left a claim unjudged.
export function verdictLabel(verdict: string | undefined, unjudged: string | undefined): string {
	return verdict ?? `unjudged (${unjudged ?? "no reason recorded"})`;
}

export function shownOutput(rendered: string, env: NodeJS.ProcessEnv): string[] {
	if (env.MELIAN_EVAL_SHOW !== "1") return [];
	return rendered
		.trimEnd()
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`));
}
