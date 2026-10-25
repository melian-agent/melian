/** Inclusive `[first, last]` line ranges, in line order, never overlapping or touching. */
export type LineRanges = [number, number][];

/** Line ranges by repository-relative path. */
export type LinesByPath = Record<string, LineRanges>;

/**
 * The facts of a changed file that a lens must receive to have seen a change no line describes, as the changeset's
 * `ChangedFile` holds them, plus a symlink's target and whether the file is empty.
 */
export const unitFields = [
	"status",
	"path",
	"oldPath",
	"oldMode",
	"newMode",
	"oldKind",
	"newKind",
	"binary",
	"target",
	"empty",
] as const;

/** One of {@link unitFields}. */
export type UnitField = (typeof unitFields)[number];

/** What makes a changed file a coverage unit of its own: what lines cannot describe. */
export type UnitKind = "binary" | "submodule" | "symlink" | "empty" | "rename" | "mode";

/**
 * A changed file that is a coverage unit of its own, keyed by its head path, or its base path when deleted. `fields`
 * lists every field a lens must receive, in {@link unitFields} order.
 */
export interface FileUnit {
	readonly path: string;
	readonly oldPath?: string;
	readonly kind: UnitKind;
	readonly fields: readonly UnitField[];
}

/** The ranges `lines` hold, each line once. */
export function rangesOf(lines: Iterable<number>): LineRanges {
	const sorted = [...new Set(lines)].filter((line) => Number.isSafeInteger(line) && line > 0).sort((a, b) => a - b);
	const ranges: LineRanges = [];
	for (const line of sorted) {
		const last = ranges.at(-1);
		if (last !== undefined && line === last[1] + 1) last[1] = line;
		else ranges.push([line, line]);
	}
	return ranges;
}

/** Every line of `a` or `b`. */
export function unionRanges(a: LineRanges, b: LineRanges): LineRanges {
	const merged: LineRanges = [];
	for (const [first, last] of [...a, ...b].sort((x, y) => x[0] - y[0])) {
		const previous = merged.at(-1);
		if (previous !== undefined && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
		else merged.push([first, last]);
	}
	return merged;
}

/** The lines of `a` that `b` does not hold. */
export function subtractRanges(a: LineRanges, b: LineRanges): LineRanges {
	const left: LineRanges = [];
	for (const [first, last] of a) {
		let start = first;
		for (const [from, to] of b) {
			if (to < start || from > last) continue;
			if (from > start) left.push([start, from - 1]);
			start = Math.max(start, to + 1);
		}
		if (start <= last) left.push([start, last]);
	}
	return left;
}

/** How many lines `ranges` hold. */
export function countRanges(ranges: LineRanges): number {
	return ranges.reduce((sum, [first, last]) => sum + last - first + 1, 0);
}
