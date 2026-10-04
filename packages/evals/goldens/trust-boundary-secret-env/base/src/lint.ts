import { execFileSync } from "node:child_process";

/**
 * Lints a worktree of the pull request's head with the head's own ESLint configuration, which can run any code it
 * likes. Only PATH and HOME reach it.
 */
export function lint(worktree: string): string {
	return execFileSync("npx", ["--no", "eslint", "--format", "json", "."], {
		cwd: worktree,
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: process.env.HOME },
	});
}
