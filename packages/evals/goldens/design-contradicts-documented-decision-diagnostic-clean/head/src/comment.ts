export type LensRun = { name: string; callersSeen: boolean; notes: string[] };
export type Rendered = { comment: string[]; ledger: string[] };

export function render(findings: string[], runs: LensRun[]): Rendered {
	const notes = [...new Set(runs.flatMap((run) => run.notes))];
	const comment = findings.map((finding) => `- ${finding}`);
	if (runs.length > 0 && runs.every((run) => !run.callersSeen))
		comment.push("- Callers unavailable for every changed site, so no lens saw the blast radius.");
	return { comment, ledger: notes.map((note) => `- ${note}`) };
}
