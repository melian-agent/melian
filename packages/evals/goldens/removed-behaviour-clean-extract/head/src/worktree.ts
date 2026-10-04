import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `task` in a temporary worktree of `commit` in `repo`, and removes the worktree afterwards. */
export async function inWorktree<T>(repo: string, commit: string, task: (dir: string) => Promise<T>): Promise<T> {
	const dir = addWorktree(repo, commit);
	try {
		return await task(dir);
	} finally {
		removeWorktree(repo, dir);
	}
}

/** Adds a detached worktree of `commit` in a new temporary directory, and returns the directory. */
export function addWorktree(repo: string, commit: string): string {
	const dir = mkdtempSync(join(tmpdir(), "review-"));
	execFileSync("git", ["worktree", "add", "--detach", dir, commit], { cwd: repo });
	return dir;
}

/** Removes the worktree at `dir`, even when it holds changes. */
export function removeWorktree(repo: string, dir: string): void {
	execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repo });
}
