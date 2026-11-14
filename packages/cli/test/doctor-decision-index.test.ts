import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionFiles } from "@melian-agent/decisions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/commands.ts";
import { doctor } from "../src/doctor.ts";

let directory: string;
let repo: string;
let output: string;
let io: Io;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "melian-doctor-decisions-"));
	repo = join(directory, "repo");
	mkdirSync(join(repo, "docs", "decisions"), { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: repo });
	output = "";
	io = {
		cwd: repo,
		env: {
			PATH: process.env.PATH,
			XDG_CONFIG_HOME: directory,
			PI_CODING_AGENT_DIR: directory,
			MELIAN_STATE_DIR: join(directory, "state"),
			GITHUB_TOKEN: "test-token",
		},
		stdout: (text) => {
			output += text;
		},
		stderr: (text) => {
			throw new Error(text);
		},
		color: false,
	};
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function commit(files: Record<string, string>): string {
	for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
	git("add", "--all");
	git("commit", "--quiet", "-m", "c");
	return git("rev-parse", "HEAD").trim();
}

const line = () => output.split("\n").find((row) => /^\S+\s+decision index\s/.test(row));

describe("doctor's decision index check", { timeout: 60_000 }, () => {
	it("leaves the check out outside a repository, before any commit, and with no decisions", async () => {
		await doctor({ ...io, cwd: directory });
		expect(line()).toBeUndefined();
		output = "";
		await doctor(io);
		expect(line()).toBeUndefined();
		output = "";
		commit({ "a.ts": "export {};\n" });
		await doctor(io);
		expect(line()).toBeUndefined();
	});

	it("says ok with the index's size at HEAD when it is under the threshold", async () => {
		commit({ "docs/decisions/2026-10-01-a.md": "# A\n" });
		await doctor(io);
		expect(line()).toMatch(/^ok\s+decision index\s+45 bytes for 1 decision at HEAD, under 64 KiB$/);
	});

	it("warns with the review's own warning when the index at HEAD is long, and passes", async () => {
		const head = commit({ "docs/decisions/2026-10-01-a.md": `# ${"x".repeat(70_000)}\n` });
		expect(await doctor(io)).toBe(0);
		expect(line()).toMatch(/^warn\s+decision index\s+/);
		expect(line()?.replace(/^warn\s+decision index\s+/, "")).toBe((await DecisionFiles.load(repo, head)).warning());
	});

	it("warns, and never fails, when the decisions at HEAD cannot be read", async () => {
		commit({ "docs/decisions/2026-10-02-b.md": "# B\nSupersedes: 2026-10-09-absent.md\n" });
		expect(await doctor(io)).toBe(0);
		expect(line()).toMatch(/^warn\s+decision index\s+.*supersedes absent/);
	});
});
