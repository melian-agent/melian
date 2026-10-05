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
	| "unknownFinding"
	| "invalidDismissal";

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
	| "nothingToCheck"
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

/** Why a revision could not be read. */
export type RevisionErrorCode =
	| "invalidRevision"
	| "notFound"
	| "notAFile"
	| "symlink"
	| "binary"
	| "invalidPattern"
	| "gitFailed";

/** A path could not be read at a revision. `path` names it, where there is one. */
export class RevisionError extends Error {
	readonly code: RevisionErrorCode;
	readonly path: string | undefined;

	constructor(code: RevisionErrorCode, message: string, options: { path?: string; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "RevisionError";
		this.code = code;
		this.path = options.path;
	}
}

/** Why a lens could not be loaded. */
export type LensErrorCode =
	| "missingRoot"
	| "notARepository"
	| "unknownCommit"
	| "symlink"
	| "tooLarge"
	| "unreadable"
	| "missingFrontMatter"
	| "invalidYaml"
	| "unknownField"
	| "invalidValue"
	| "missingField"
	| "unknownLens"
	| "unknownLevel";

/**
 * A lens could not be loaded. `file` names its `LENS.md`, repository-relative, or `builtin:<name>` for a lens shipped
 * with Melian. `field` is the offending front matter field, where there is one. For a problem with one of its scrutiny
 * levels, `lens` names the lens and `level` the level.
 */
export class LensError extends Error {
	readonly code: LensErrorCode;
	readonly file: string;
	readonly field: string | undefined;
	readonly lens: string | undefined;
	readonly level: string | undefined;

	constructor(
		code: LensErrorCode,
		file: string,
		message: string,
		options: { field?: string; lens?: string; level?: string; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "LensError";
		this.code = code;
		this.file = file;
		this.field = options.field;
		this.lens = options.lens;
		this.level = options.level;
	}
}

/** Why a tier could not be routed to a model. */
export type ModelRoutingErrorCode = "noModelForTier" | "invalidModel";

/** A model tier could not be routed. `tier` names it; `model` is the offending configured value, where there is one. */
export class ModelRoutingError extends Error {
	readonly code: ModelRoutingErrorCode;
	readonly tier: string;
	readonly model: string | undefined;

	constructor(code: ModelRoutingErrorCode, message: string, options: { tier: string; model?: string }) {
		super(message);
		this.name = "ModelRoutingError";
		this.code = code;
		this.tier = options.tier;
		this.model = options.model;
	}
}

/** Why a decision could not be made. */
export type DecisionErrorCode = "unanswered" | "invalidAnswer" | "unrecorded" | "staleRecording";

/**
 * A decider gave no usable answer: it left a question unanswered, answered one it was not asked or with an option or
 * probability the question does not allow, or, for the recorded adapter, has no recording for it or one made for
 * another version of its question set or another form of the question. `question` names
 * the question, where one is at fault.
 */
export class DecisionError extends Error {
	readonly code: DecisionErrorCode;
	readonly question: string | undefined;

	constructor(code: DecisionErrorCode, message: string, options: { question?: string; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "DecisionError";
		this.code = code;
		this.question = options.question;
	}
}
