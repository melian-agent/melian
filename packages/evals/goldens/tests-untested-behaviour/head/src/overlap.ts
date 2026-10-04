/** One hunk of a diff: the lines it replaced at the base and the lines it wrote at head. */
export interface Hunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
}

/** Lines a finding cites as evidence, at head unless `revision` names the base, for lines the change deleted. */
export interface Location {
	readonly line: number;
	readonly endLine?: number;
	readonly revision?: "base" | "head";
}

/** Whether `location` overlaps lines the change wrote or, at the base, deleted, so a finding citing it was caused by the change. */
export function overlapsChange(hunks: readonly Hunk[], location: Location): boolean {
	const end = location.endLine ?? location.line;
	return hunks.some((hunk) => {
		const start = location.revision === "base" ? hunk.oldStart : hunk.newStart;
		const count = location.revision === "base" ? hunk.oldLines : hunk.newLines;
		return location.line < start + count && end >= start;
	});
}
