export type LensRun = { name: string; notes: string[] };

export function renderNotes(runs: LensRun[]): string[] {
	const notes = new Set(runs.flatMap((run) => run.notes));
	const lines = [...notes].map((note) => `- ${note}`);
	if (runs.length > 0 && runs.every((run) => run.notes.length > 0))
		lines.push("- Every lens ran with a note, so read them before trusting a pass.");
	return lines;
}
