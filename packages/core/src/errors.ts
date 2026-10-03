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

/** Why configuration could not be loaded. */
export type ConfigErrorCode =
	| "missingRoot"
	| "unreadable"
	| "invalidYaml"
	| "unknownKey"
	| "reservedKey"
	| "invalidValue";

/** A `melian.yaml` could not be loaded. `file` names it; `key` is the dotted path of the offending key, where there is one. */
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

/** A path given to a loader lies outside the repository it was asked about. */
export class OutsideRepositoryError extends Error {
	readonly path: string;
	readonly repoRoot: string;

	constructor(path: string, repoRoot: string) {
		super(`${path} is outside the repository at ${repoRoot}`);
		this.name = "OutsideRepositoryError";
		this.path = path;
		this.repoRoot = repoRoot;
	}
}
