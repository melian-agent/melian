export type LensRun = { name: string; notes: string[] };

export function renderNotes(runs: LensRun[]): string[] {
	return runs.flatMap((run) => run.notes.map((note) => `- ${run.name}: ${note}`));
}
