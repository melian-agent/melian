/** Why a changeset could not be resolved. */
export type ChangesetErrorCode =
	| "notARepository"
	| "invalidRange"
	| "unknownRef"
	| "noMergeBase"
	| "dirtyWorktree"
	| "gitUnavailable"
	| "gitTooOld"
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

/** Why configuration could not be loaded. */
export type ConfigErrorCode =
	| "missingRoot"
	| "notARepository"
	| "unknownCommit"
	| "symlink"
	| "tooLarge"
	| "unreadable"
	| "invalidYaml"
	| "unknownKey"
	| "reservedKey"
	| "invalidValue";

/**
 * A `melian.yaml` could not be loaded. `file` names it, repository-relative, or names the repository root or commit when
 * the source itself could not be opened. `key` is the dotted path of the offending key, where there is one.
 */
export class ConfigError extends Error {
	readonly code: ConfigErrorCode;
	readonly file: string;
	readonly key: string | undefined;

	constructor(code: ConfigErrorCode, file: string, message: string, options: { key?: string; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "ConfigError";
		this.code = code;
		this.file = file;
		this.key = options.key;
	}
}

/** Why standards could not be collected. */
export type StandardsErrorCode =
	| "missingRoot"
	| "notARepository"
	| "unknownCommit"
	| "tooLarge"
	| "totalTooLarge"
	| "unreadable";

/**
 * Standards could not be collected. `path` names the file, or the repository root for `missingRoot` and
 * `notARepository`, or the commit for `unknownCommit`. A file that does not exist is absence, and a symlink is
 * skipped; neither is an error.
 */
export class StandardsError extends Error {
	readonly code: StandardsErrorCode;
	readonly path: string;

	constructor(code: StandardsErrorCode, path: string, message: string, options: { cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "StandardsError";
		this.code = code;
		this.path = path;
	}
}

/** A path given to a loader lies outside the repository it was asked about. */
export class OutsideRepositoryError extends Error {
	readonly code = "outsideRepository";
	readonly path: string;
	readonly repoRoot: string;

	constructor(path: string, repoRoot: string) {
		super(`${path} is outside the repository at ${repoRoot}`);
		this.name = "OutsideRepositoryError";
		this.path = path;
		this.repoRoot = repoRoot;
	}
}

/** Why a value is not a valid finding. */
export type FindingErrorCode =
	| "invalidFinding"
	| "levelMismatch"
	| "invalidPath"
	| "invalidRegion"
	| "deletedFile"
	| "missingEvidence"
	| "missingDiscriminator"
	| "snippetNotFound"
	| "idMismatch"
	| "unknownFinding";

/**
 * A value is not a valid finding, or an ID names no finding. `path` is the JSON pointer of the offending field, empty
 * for the whole value.
 */
export class FindingError extends Error {
	readonly code: FindingErrorCode;
	readonly path: string;

	constructor(code: FindingErrorCode, message: string, options: { path: string }) {
		super(message);
		this.name = "FindingError";
		this.code = code;
		this.path = options.path;
	}
}

/** Why a check could not run. */
export type CheckErrorCode =
	| "unknownCheck"
	| "unknownTier"
	| "tierCycle"
	| "unknownConversation"
	| "notCompleted"
	| "noEnvironment"
	| "worktreeFailed"
	| "toolMissing"
	| "toolFailed"
	| "timeout"
	| "aborted"
	| "outputTooLarge"
	| "invalidOutput"
	| "unreadable"
	| "tooLarge";

/**
 * A check could not run, or a tool it runs failed. `check` names the check, such as `static.tsc`, or the tier for
 * `unknownTier` and `tierCycle`. A failed check says so with this error; it never reports an empty result instead.
 */
export class CheckError extends Error {
	readonly code: CheckErrorCode;
	readonly check: string;

	constructor(code: CheckErrorCode, check: string, message: string, options: { cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "CheckError";
		this.code = code;
		this.check = check;
	}
}
