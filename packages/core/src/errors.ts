/** Why a changeset could not be resolved. */
export type ChangesetErrorCode =
	| "notARepository"
	| "invalidRange"
	| "unknownRef"
	| "noMergeBase"
	| "dirtyWorktree"
	| "gitUnavailable"
	| "gitFailed";

/** A changeset could not be resolved. `code` says why; `ref` and `paths` carry the offending input where there is one. */
export class ChangesetError extends Error {
	readonly code: ChangesetErrorCode;
	readonly ref: string | undefined;
	readonly paths: readonly string[];

	constructor(
		code: ChangesetErrorCode,
		message: string,
		options: { ref?: string; paths?: readonly string[]; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "ChangesetError";
		this.code = code;
		this.ref = options.ref;
		this.paths = options.paths ?? [];
	}
}
