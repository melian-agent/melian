import type { Revision } from "./changeset.ts";
import type { Cause } from "./findings.ts";

/** Lines in one file at head. `endLine` defaults to `startLine`. */
export interface CodeLocation {
	/** The repository-relative path, with forward slashes. */
	readonly file: string;
	readonly startLine: number;
	readonly endLine?: number;
}

/**
 * Classifies a finding's cause by where it sits, a placeholder until decision models classify by evidence.
 *
 * A location overlapping any hunk's new lines is `introduced`. A location elsewhere in a file the revision changed is
 * `affected`, and one in an unchanged file is `pre-existing`. A pure deletion has no new lines, so code beside it is
 * `affected`, not `introduced`. A lens that can cite the change it broke, or show that it did not, may override the
 * result.
 */
export function classifyCause(location: CodeLocation, revision: Pick<Revision, "files">): Cause {
	const changed = revision.files.find((file) => file.path === location.file);
	if (changed === undefined) return "pre-existing";
	const end = location.endLine ?? location.startLine;
	const overlaps = changed.hunks.some(
		(hunk) => hunk.newLines > 0 && location.startLine < hunk.newStart + hunk.newLines && end >= hunk.newStart,
	);
	return overlaps ? "introduced" : "affected";
}
