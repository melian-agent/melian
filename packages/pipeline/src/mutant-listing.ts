import { type MutationInventoryV2, visibleText } from "@melian-agent/core";

export const maxListedMutants = 200;

export const maxReplacementChars = 120;

type Row = MutationInventoryV2["mutants"][number];

export type MutantWindow = {
	mutants: Row[];
	excluded: number;
	// `cutLine` is set when one line held more than the cap, so the next call starts past it.
	more?: { count: number; startLine: number; cutLine?: number };
};

// Rows the base's configuration excludes are counted, not shown. Rows a disable comment in the head ignores are shown,
// marked: that comment is the change's own text, so a head cannot hide its mutants from the lens with it.
export class MutantListing {
	readonly file: string;
	readonly #rows: readonly Row[];
	readonly #unmutated: string | undefined;

	private constructor(file: string, rows: readonly Row[], unmutated: string | undefined) {
		this.file = file;
		this.#rows = rows;
		this.#unmutated = unmutated;
	}

	static of(inventory: MutationInventoryV2, file: string): MutantListing {
		const rows = inventory.mutants
			.filter((row) => row.file === file)
			.sort((a, b) => a.line - b.line || a.column - b.column);
		return new MutantListing(file, rows, inventory.unmutated.find((each) => each.file === file)?.reason);
	}

	get unmutated(): string | undefined {
		return this.#unmutated;
	}

	// A cut falls at a line boundary, so the next call from `more.startLine` repeats none.
	window(startLine: number, endLine: number): MutantWindow {
		const inRange = this.#rows.filter((row) => row.line >= startLine && row.line <= endLine);
		const listed = inRange.filter((row) => row.ignoredBy !== "config");
		const excluded = inRange.length - listed.length;
		if (listed.length <= maxListedMutants) return { mutants: listed, excluded };
		const next = listed[maxListedMutants]!.line;
		const whole = listed.filter((row) => row.line < next);
		const shown = whole.length > 0 ? whole : listed.slice(0, maxListedMutants);
		const count = listed.length - shown.length;
		return {
			mutants: shown,
			excluded,
			more: whole.length > 0 ? { count, startLine: next } : { count, startLine: next + 1, cutLine: next },
		};
	}
}

export function describeMutant(row: Row): string {
	const escaped = visibleText(JSON.stringify(row.replacement));
	const replacement =
		escaped.length > maxReplacementChars ? `${escaped.slice(0, maxReplacementChars)} [cut]` : escaped;
	const mark = row.ignoredBy === "comment" ? " [ignored by a comment in the head]" : "";
	return `${row.line}:${row.column}-${row.endLine}:${row.endColumn} ${visibleText(row.mutatorName)} -> ${replacement}${mark}`;
}
