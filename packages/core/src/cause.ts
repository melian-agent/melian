import type { Revision } from "./changeset.ts";
import type { ChangedFile, Hunk } from "./diff.ts";
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

function onlyMoved(file: ChangedFile): boolean {
	return file.status === "renamed" && file.hunks.length === 0;
}

function overlaps(start: number, end: number, from: number, count: number): boolean {
	return count > 0 && start < from + count && end >= from;
}

/**
 * The part of the change a location's lines fall on: a hunk they overlap, or a file the change renamed without
 * editing, which the rename changed as a whole.
 */
export type ChangeOverlap =
	| { readonly kind: "hunk"; readonly hunk: Hunk }
	| { readonly kind: "rename"; readonly file: ChangedFile };

/**
 * The part of the change a location falls on, whatever its role, or `undefined` when it falls on nothing the change
 * did. At head: a hunk's new lines in a file the change keeps. At the base: a hunk's old lines in a file the base had,
 * named by its base path, so deleted lines count as changed code. On either side, any line of a file the change
 * renamed without editing, named by its path on that side, since the rename is what the change did to it, unless
 * `findingFile`, the head path of the finding the location supports, is itself a file the change only moved: moving
 * files changes none of their lines, so no rename proves anything about a defect inside one, its own or a sibling's.
 * Compares canonical paths; throws `FindingError` `invalidPath` for a path that is not repository-relative.
 */
export function changeOverlap(
	location: CodeLocation & { readonly revision?: EvidenceRevision },
	revision: Pick<Revision, "files">,
	findingFile?: string,
): ChangeOverlap | undefined {
	const path = canonicalPath(location.file, "/evidence/file");
	const end = location.endLine ?? location.startLine;
	const base = location.revision === "base";
	const changed = revision.files.find((file) =>
		base
			? (file.oldPath ?? file.path) === path && file.status !== "added"
			: file.path === path && file.status !== "deleted",
	);
	if (changed === undefined) return undefined;
	if (onlyMoved(changed)) {
		const findingPath = findingFile === undefined ? undefined : canonicalPath(findingFile, "/file");
		const findingMoved = revision.files.some((file) => file.path === findingPath && onlyMoved(file));
		return findingMoved ? undefined : { kind: "rename", file: changed };
	}
	const hunk = changed.hunks.find((each) =>
		base
			? overlaps(location.startLine, end, each.oldStart, each.oldLines)
			: overlaps(location.startLine, end, each.newStart, each.newLines),
	);
	return hunk === undefined ? undefined : { kind: "hunk", hunk };
}

/**
 * The part of the change a piece of evidence proves caused a finding in `findingFile`, by {@link changeOverlap}, or
 * `undefined` when it proves nothing. Only a `cause` location proves anything; a `context` location never does.
 */
export function causeOverlap(
	site: EvidenceSite,
	revision: Pick<Revision, "files">,
	findingFile?: string,
): ChangeOverlap | undefined {
	canonicalPath(site.file, "/evidence/file");
	return site.role === "cause" ? changeOverlap(site, revision, findingFile) : undefined;
}

/**
 * Classifies a finding's cause by where it sits and, given its evidence, by what that evidence proves.
 *
 * Location proves `introduced` only: a location in an added file, binary files included, or overlapping any hunk's new
 * lines is `introduced`. Any other location is `affected` when one of `evidence`'s locations proves the change caused
 * it, by {@link causeOverlap}, and `pre-existing` otherwise, including code beside or around a pure deletion, which has no
 * new lines, and code in a file the change only renamed, whatever renamed file its evidence cites. A file deleted at
 * head has no lines to point at, so a location in one throws `FindingError` `deletedFile`. Compares canonical paths, so
 * `./src/run.ts` is `src/run.ts`; throws `FindingError` `invalidPath` for a path that is absolute, escapes the
 * repository, or uses a backslash.
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
	return evidence.some((site) => causeOverlap(site, revision, location.file) !== undefined)
		? "affected"
		: "pre-existing";
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
