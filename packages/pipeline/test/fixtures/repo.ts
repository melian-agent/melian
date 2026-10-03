import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Isolates git from the developer's own configuration, such as commit signing.
export const isolatedGitEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Melian Test",
	GIT_AUTHOR_EMAIL: "test@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Test",
	GIT_COMMITTER_EMAIL: "test@melian.invalid",
};

export function lines(...content: string[]): string {
	return `${content.join("\n")}\n`;
}

export function gitIn(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, env: { ...process.env, ...isolatedGitEnv }, encoding: "utf8" }).trim();
}

export function writeFiles(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

// A repository with a `main` commit holding `base` and a `feature` commit on top holding `head`.
export function baseAndHead(base: Record<string, string>, head: Record<string, string>): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-review-")));
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, base);
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "base");
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	writeFiles(repo, head);
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "head");
	return repo;
}
