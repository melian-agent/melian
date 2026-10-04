import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `task` in a temporary worktree of `commit` in `repo`, and removes the worktree afterwards. */
export async function inWorktree<T>(repo: string, commit: string, task: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "review-"));
	execFileSync("git", ["worktree", "add", "--detach", dir, commit], { cwd: repo });
	try {
		return await task(dir);
	} finally {
		execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repo });
	}
}
