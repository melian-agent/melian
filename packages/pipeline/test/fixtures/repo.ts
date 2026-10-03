import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";

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

/** A git repository in a temporary directory, resolved through symlinks, with git isolated from the user's config. */
export function createRepository(): string {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "melian-pipeline-")));
	gitIn(root, "init", "--quiet", "--initial-branch=main");
	return root;
}

export function removeRepository(root: string): void {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
}

/** Writes `files`, deleting `remove`, commits everything, and returns the commit. */
export function commit(root: string, files: Record<string, string>, remove: string[] = []): string {
	writeFiles(root, files);
	for (const path of remove) gitIn(root, "rm", "--quiet", path);
	gitIn(root, "add", "--all");
	gitIn(root, "commit", "--quiet", "--allow-empty", "-m", "commit");
	return gitIn(root, "rev-parse", "HEAD");
}

/** Installs a fake tool as the checkout's `node_modules/.bin/<name>`, a shell script. */
export function fakeTool(root: string, name: string, script: string): void {
	const path = join(root, "node_modules", ".bin", name);
	writeFiles(root, { [`node_modules/.bin/${name}`]: `#!/bin/sh\n${script}\n` });
	chmodSync(path, 0o755);
}
