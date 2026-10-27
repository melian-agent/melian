export type LensRun = { name: string; notes: string[] };

export function renderNotes(runs: LensRun[]): string[] {
	const notes = new Set(runs.flatMap((run) => run.notes));
	return [...notes].map((note) => `- Note: ${note}`);
}
