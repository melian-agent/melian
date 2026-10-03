import type { Finding } from "@melian-agent/core";

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

/** Why a review could not run or finish. */
export type ReviewErrorCode = "noAvailableModel" | "notInstalled" | "lensFailed" | "allModelsFailed";

/**
 * A review could not run or finish. `lenses` names the lenses involved, `models` the models tried when every model of
 * a tier failed, and `findings` what was reported anyway.
 */
export class ReviewError extends Error {
	readonly code: ReviewErrorCode;
	readonly lenses: readonly string[];
	readonly models: readonly string[];
	readonly findings: readonly Finding[];

	constructor(
		code: ReviewErrorCode,
		message: string,
		options: {
			lenses: readonly string[];
			models?: readonly string[];
			findings?: readonly Finding[];
			cause?: unknown;
		},
	) {
		super(message, { cause: options.cause });
		this.name = "ReviewError";
		this.code = code;
		this.lenses = options.lenses;
		this.models = options.models ?? [];
		this.findings = options.findings ?? [];
	}
}
