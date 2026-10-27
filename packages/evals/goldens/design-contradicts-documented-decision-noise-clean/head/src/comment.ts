export type LensRun = { name: string; notes: string[] };

export function renderNotes(runs: LensRun[]): string[] {
	const lenses = new Map<string, string[]>();
	for (const run of runs) {
		for (const note of run.notes) lenses.set(note, [...(lenses.get(note) ?? []), run.name]);
	}
	return [...lenses].map(([note, names]) => `- ${note} (${names.join(", ")})`);
}
