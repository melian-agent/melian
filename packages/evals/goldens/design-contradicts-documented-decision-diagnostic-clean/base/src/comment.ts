export type LensRun = { name: string; callersSeen: boolean; notes: string[] };
export type Rendered = { comment: string[]; ledger: string[] };

export function render(findings: string[], runs: LensRun[]): Rendered {
	const notes = [...new Set(runs.flatMap((run) => run.notes))];
	return { comment: findings.map((finding) => `- ${finding}`), ledger: notes.map((note) => `- ${note}`) };
}
