import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inWorktree } from "./worktree.ts";

const run = promisify(execFile);

/** Lints `commit` in a worktree of its own, failing when the linter exits non-zero or runs past two minutes. */
export async function lintCommit(repo: string, commit: string): Promise<string> {
	return inWorktree(repo, commit, async (dir) => {
		const { stdout } = await run("npx", ["--no", "biome", "lint", "."], { cwd: dir, timeout: 120_000 });
		return stdout;
	});
}
