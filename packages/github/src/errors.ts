/** Why a GitHub request or setting failed. */
export type GitHubErrorCode =
	| "unauthorized"
	| "forbidden"
	| "notFound"
	| "failed"
	| "noToken"
	| "notGitHubRemote"
	| "fetchFailed";

/**
 * A GitHub request failed, no token was found, or a remote does not name a GitHub repository. `status` is the HTTP
 * status when GitHub answered. The message never holds a token.
 */
export class GitHubError extends Error {
	readonly code: GitHubErrorCode;
	readonly status: number | undefined;

	constructor(code: GitHubErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "GitHubError";
		this.code = code;
		this.status = options.status;
	}
}
