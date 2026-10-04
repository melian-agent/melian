/** One hunk of a diff: the lines it replaced at the base and the lines it wrote at head. */
export interface Hunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
}

/** Lines a finding cites as evidence, at head. */
export interface Location {
	readonly line: number;
	readonly endLine?: number;
}

/** Whether `location` overlaps lines the change wrote, so a finding citing it was caused by the change. */
export function overlapsChange(hunks: readonly Hunk[], location: Location): boolean {
	const end = location.endLine ?? location.line;
	return hunks.some((hunk) => location.line < hunk.newStart + hunk.newLines && end >= hunk.newStart);
}
