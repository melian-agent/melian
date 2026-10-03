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
