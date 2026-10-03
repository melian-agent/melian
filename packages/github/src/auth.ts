import { execFile } from "node:child_process";
import { GitHubError } from "./errors.ts";

/** A GitHub repository, by owner and name. */
export interface GitHubRepository {
	readonly owner: string;
	readonly repo: string;
}

const name = "[A-Za-z0-9_.-]+";
const remotePatterns = [
	new RegExp(`^(?:https?|git)://(?:[^@/]+@)?([^/:]+)(?::\\d+)?/(${name})/(${name}?)(?:\\.git)?/?$`),
	new RegExp(`^ssh://(?:[^@/]+@)?([^/:]+)(?::\\d+)?/(${name})/(${name}?)(?:\\.git)?/?$`),
	new RegExp(`^(?:[^@/]+@)?([^/:]+):(${name})/(${name}?)(?:\\.git)?/?$`),
];

/**
 * The repository a git remote URL names on `host`, `github.com` by default: an HTTPS, SSH, or scp-style URL such as
 * `git@github.com:owner/repo.git`. Throws {@link GitHubError} `notGitHubRemote` for anything else.
 */
export function parseGitHubRemote(url: string, host = "github.com"): GitHubRepository {
	for (const pattern of remotePatterns) {
		const match = pattern.exec(url.trim());
		if (match !== null && match[1]!.toLowerCase() === host.toLowerCase() && match[3] !== "") {
			return { owner: match[2]!, repo: match[3]!.replace(/\.git$/, "") };
		}
	}
	// A CI clone's remote can hold a token as its user info, as in https://oauth2:<token>@host/o/r.
	const shown = url.trim().replace(/^([a-z+]+:\/\/)[^@/]*@/i, "$1");
	throw new GitHubError("notGitHubRemote", `${shown} is not a ${host} repository`);
}

/** Where a GitHub token came from: an environment variable, or the gh CLI's login. */
export type TokenSource = "GITHUB_TOKEN" | "GH_TOKEN" | "gh";

/** A token and where it came from. Print the source, never the token. */
export interface GitHubToken {
	readonly token: string;
	readonly source: TokenSource;
}

/** The token `gh auth token` prints, or `undefined` when gh is missing or logged out. */
export function ghAuthToken(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("gh", ["auth", "token"], { timeout: 10_000 }, (error, stdout) => {
			const token = stdout.trim();
			resolve(error === null && token !== "" ? token : undefined);
		});
	});
}

/**
 * The token for GitHub requests: `GITHUB_TOKEN`, then `GH_TOKEN`, then the gh CLI's login. `undefined` when there is
 * none. `gh` is asked only when neither variable is set.
 */
export async function resolveGitHubToken(
	env: NodeJS.ProcessEnv = process.env,
	gh: () => Promise<string | undefined> = ghAuthToken,
): Promise<GitHubToken | undefined> {
	for (const variable of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
		const token = env[variable]?.trim();
		if (token !== undefined && token !== "") return { token, source: variable };
	}
	const token = await gh();
	return token === undefined ? undefined : { token, source: "gh" };
}
