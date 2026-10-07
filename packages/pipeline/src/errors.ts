import type { Finding, Verdict } from "@melian-agent/core";

/** Why Pi's credential store could not serve a credential. */
export type PiCredentialsErrorCode = "unreadable" | "invalid" | "readOnly";

/** Pi's `auth.json` could not be read, holds something other than credentials, or would need writing. `path` names it. */
export class PiCredentialsError extends Error {
	readonly code: PiCredentialsErrorCode;
	readonly path: string;

	constructor(code: PiCredentialsErrorCode, path: string, message: string, options: { cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "PiCredentialsError";
		this.code = code;
		this.path = path;
	}
}

/** Why a named credential could not be used: its command failed, its source gave nothing, its bearer expired, or its provider accepts no supported auth. */
export type CredentialErrorCode = "commandFailed" | "noValue" | "tokenExpired" | "unknownProvider" | "unsupportedAuth";

/**
 * A named credential from a secrets file could not be read: its command failed or timed out, or its source gave an
 * empty value or expired bearer. `credential` and `file` name it; the message never quotes what the command printed.
 */
export class CredentialError extends Error {
	readonly code: CredentialErrorCode;
	readonly credential: string;
	readonly file: string;

	constructor(code: CredentialErrorCode, message: string, options: { credential: string; file: string }) {
		super(message);
		this.name = "CredentialError";
		this.code = code;
		this.credential = options.credential;
		this.file = options.file;
	}
}

/** Why a review could not be published. */
export type PublishErrorCode =
	| "staleReview"
	| "staleTarget"
	| "notReviewed"
	| "notPublishable"
	| "notInstalled"
	| "publishFailed";

/**
 * A review could not be published. `pullRequest` names the pull request and `revision` the head commit involved. What
 * was posted before a `publishFailed` is recorded, so publishing again resumes rather than repeats.
 */
export class PublishError extends Error {
	readonly code: PublishErrorCode;
	readonly pullRequest: number;
	readonly revision: string;

	constructor(
		code: PublishErrorCode,
		message: string,
		options: { pullRequest: number; revision: string; cause?: unknown },
	) {
		super(message, { cause: options.cause });
		this.name = "PublishError";
		this.code = code;
		this.pullRequest = options.pullRequest;
		this.revision = options.revision;
	}
}

/** Why a review could not run or finish. */
export type ReviewErrorCode =
	| "missingPolicy"
	| "noAvailableModel"
	| "notInstalled"
	| "lensFailed"
	| "verifierFailed"
	| "allModelsFailed"
	| "adjudicationFailed"
	| "superseded";

/**
 * A review could not run or finish. `lenses` names the lenses involved, `models` the models tried when every model of
 * a tier failed, and `findings` what was reported anyway. `verdict`, when adjudication ran, is the `not-reviewed`
 * verdict it recorded.
 */
export class ReviewError extends Error {
	readonly code: ReviewErrorCode;
	readonly lenses: readonly string[];
	readonly models: readonly string[];
	readonly findings: readonly Finding[];
	readonly verdict?: Verdict;

	constructor(
		code: ReviewErrorCode,
		message: string,
		options: {
			lenses: readonly string[];
			models?: readonly string[];
			findings?: readonly Finding[];
			verdict?: Verdict;
			cause?: unknown;
		},
	) {
		super(message, { cause: options.cause });
		this.name = "ReviewError";
		this.code = code;
		this.lenses = options.lenses;
		this.models = options.models ?? [];
		this.findings = options.findings ?? [];
		if (options.verdict !== undefined) this.verdict = options.verdict;
	}
}

/** Why a finding could not be dismissed, or why its verdict was not decided again afterwards. */
export type DismissErrorCode = "notReviewed" | "unknownFinding" | "notInstalled" | "adjudicationFailed";

/**
 * A dismissal could not be recorded: `notReviewed` when no verdict is stored for the revision, `unknownFinding` when the
 * verdict holds no finding with the ID, and `notInstalled` when the harness cannot adjudicate. `adjudicationFailed`
 * means the dismissal was recorded but the verdict was not decided again; the next review of the revision decides it.
 * `revision` is the revision's key and `finding` the ID.
 */
export class DismissError extends Error {
	readonly code: DismissErrorCode;
	readonly revision: string;
	readonly finding: string;

	constructor(code: DismissErrorCode, message: string, options: { revision: string; finding: string }) {
		super(message);
		this.name = "DismissError";
		this.code = code;
		this.revision = options.revision;
		this.finding = options.finding;
	}
}
