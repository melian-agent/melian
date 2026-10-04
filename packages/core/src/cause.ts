import type { ChangedFile, Hunk } from "./diff.ts";
import type { EvidenceRevision, EvidenceRole } from "./findings.ts";

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

/**
 * The part of the change a location's lines fall on: a hunk they overlap, or a file the change renamed without
 * editing, which the rename changed as a whole.
 */
export type ChangeOverlap =
	| { readonly kind: "hunk"; readonly hunk: Hunk }
	| { readonly kind: "rename"; readonly file: ChangedFile };
