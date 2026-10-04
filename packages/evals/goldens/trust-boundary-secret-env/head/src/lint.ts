import { execFileSync } from "node:child_process";

/**
 * Lints a worktree of the pull request's head with the head's own ESLint configuration. The linter sees the whole
 * environment, so proxy and registry settings reach it.
 */
export function lint(worktree: string): string {
	return execFileSync("npx", ["--no", "eslint", "--format", "json", "."], {
		cwd: worktree,
		encoding: "utf8",
	});
}
