import type { Revision } from "./changeset.ts";
import { canonicalPath, type LocationCause } from "./findings.ts";

/** Lines in one file at head. `endLine` defaults to `startLine`. */
export interface CodeLocation {
	/** The repository-relative path, with forward slashes. */
	readonly file: string;
	readonly startLine: number;
	readonly endLine?: number;
}

/**
 * Classifies a finding's cause by where it sits. Location proves `introduced` only: a location overlapping any hunk's
 * new lines is `introduced`, and every other location is `pre-existing`, including code beside a pure deletion, which
 * has no new lines. A finding becomes `affected` only when its producer cites the changed code that breaks it, through
 * `createFinding`'s `cause: { evidence }`. Compares canonical paths, so `./src/run.ts` is `src/run.ts`; throws
 * `FindingError` `invalidPath` for a path that is absolute, escapes the repository, or uses a backslash.
 */
export function classifyCause(location: CodeLocation, revision: Pick<Revision, "files">): LocationCause {
	const path = canonicalPath(location.file, "/file");
	const changed = revision.files.find((file) => file.path === path);
	if (changed === undefined) return "pre-existing";
	const end = location.endLine ?? location.startLine;
	const overlaps = changed.hunks.some(
		(hunk) => hunk.newLines > 0 && location.startLine < hunk.newStart + hunk.newLines && end >= hunk.newStart,
	);
	return overlaps ? "introduced" : "pre-existing";
}
