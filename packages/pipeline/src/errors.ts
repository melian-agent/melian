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

/** Why a review could not be published. */
export type PublishErrorCode = "staleReview" | "notReviewed" | "notPublishable" | "notInstalled" | "publishFailed";

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
	| "noAvailableModel"
	| "notInstalled"
	| "lensFailed"
	| "allModelsFailed"
	| "adjudicationFailed";

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
