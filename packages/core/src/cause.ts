import type { Revision } from "./changeset.ts";
import type { Hunk } from "./diff.ts";
import { FindingError } from "./errors.ts";
import { type Cause, canonicalPath, type EvidenceRevision, type EvidenceRole, type LocationCause } from "./findings.ts";

/** Lines in one file at head. `endLine` defaults to `startLine`. */
export interface CodeLocation {
	/** The repository-relative path, with forward slashes. */
	readonly file: string;
	readonly startLine: number;
	readonly endLine?: number;
}

/** Lines one piece of evidence points at, and the role they play. A base location names a renamed file by its old path. */
export interface EvidenceSite extends CodeLocation {
	readonly role: EvidenceRole;
	/** `head` when absent. */
	readonly revision?: EvidenceRevision;
}

function overlaps(start: number, end: number, from: number, count: number): boolean {
	return count > 0 && start < from + count && end >= from;
}

/**
 * The hunk a piece of evidence proves the change caused, or `undefined` when it proves nothing. Only a `cause` location
 * proves anything: at head, lines overlapping a hunk's new lines in a file the change keeps; at the base, lines
 * overlapping a hunk's old lines in a file the base had, named by its base path, so a deleted guard counts as changed
 * code. A `context` location never does. Compares canonical paths; throws `FindingError` `invalidPath` for a path that
 * is not repository-relative.
 */
export function causeHunk(site: EvidenceSite, revision: Pick<Revision, "files">): Hunk | undefined {
	const path = canonicalPath(site.file, "/evidence/file");
	if (site.role !== "cause") return undefined;
	const end = site.endLine ?? site.startLine;
	if (site.revision === "base") {
		const changed = revision.files.find((file) => (file.oldPath ?? file.path) === path && file.status !== "added");
		return changed?.hunks.find((hunk) => overlaps(site.startLine, end, hunk.oldStart, hunk.oldLines));
	}
	const changed = revision.files.find((file) => file.path === path && file.status !== "deleted");
	return changed?.hunks.find((hunk) => overlaps(site.startLine, end, hunk.newStart, hunk.newLines));
}

/**
 * Classifies a finding's cause by where it sits and, given its evidence, by what that evidence proves.
 *
 * Location proves `introduced` only: a location in an added file, binary files included, or overlapping any hunk's new
 * lines is `introduced`. Any other location is `affected` when one of `evidence`'s locations proves the change caused
 * it, by {@link causeHunk}, and `pre-existing` otherwise, including code beside or around a pure deletion, which has no
 * new lines. A file deleted at head has no lines to point at, so a location in one throws `FindingError` `deletedFile`.
 * Compares canonical paths, so `./src/run.ts` is `src/run.ts`; throws `FindingError` `invalidPath` for a path that is
 * absolute, escapes the repository, or uses a backslash.
 */
export function classifyCause(location: CodeLocation, revision: Pick<Revision, "files">): LocationCause;
export function classifyCause(
	location: CodeLocation,
	revision: Pick<Revision, "files">,
	evidence: readonly EvidenceSite[],
): Cause;
export function classifyCause(
	location: CodeLocation,
	revision: Pick<Revision, "files">,
	evidence: readonly EvidenceSite[] = [],
): Cause {
	const located = causeByLocation(location, revision);
	if (located === "introduced") return located;
	return evidence.some((site) => causeHunk(site, revision) !== undefined) ? "affected" : "pre-existing";
}

function causeByLocation(location: CodeLocation, revision: Pick<Revision, "files">): LocationCause {
	const path = canonicalPath(location.file, "/file");
	const changed = revision.files.find((file) => file.path === path);
	if (changed === undefined) return "pre-existing";
	if (changed.status === "deleted") {
		throw new FindingError("deletedFile", `${path} is deleted at head, so no finding can point into it`, {
			path: "/file",
		});
	}
	if (changed.status === "added") return "introduced";
	const end = location.endLine ?? location.startLine;
	return changed.hunks.some((hunk) => overlaps(location.startLine, end, hunk.newStart, hunk.newLines))
		? "introduced"
		: "pre-existing";
}
