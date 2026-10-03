import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Isolates git from the developer's own configuration, such as commit signing or a different diff algorithm.
export const isolatedGitEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Melian Test",
	GIT_AUTHOR_EMAIL: "test@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Test",
	GIT_COMMITTER_EMAIL: "test@melian.invalid",
};

export function temporaryDirectory(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "melian-core-")));
}

export function removeDirectory(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

export function lines(...content: string[]): string {
	return `${content.join("\n")}\n`;
}

export function gitIn(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, env: { ...process.env, ...isolatedGitEnv }, encoding: "utf8" }).trim();
}
