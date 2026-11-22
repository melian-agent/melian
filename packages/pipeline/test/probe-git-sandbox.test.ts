import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIn } from "../../core/test/fixtures/repo.ts";
import { Probe, type ProbeInput, type ProbeOptions, type ProbeResult } from "../src/probe.ts";

// What a probe's own code needs under the real sandbox: git, and a bare import of a workspace package. On macOS git runs
// only from the developer tools the host names, so CI's macOS job runs this file, as scripts/macos-tests.json lists.
// Where the sandbox cannot run, the suite skips, unless MELIAN_PROBE_SANDBOX=1 says this host must run it.

const availability = await Probe.availability();
const required = process.env.MELIAN_PROBE_SANDBOX === "1";
const reason = availability.available ? "" : availability.reason;

let worktree: string;

beforeEach(() => {
	worktree = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-git-")));
});

afterEach(() => {
	rmSync(worktree, { recursive: true, force: true });
});

function committed(root: string): string {
	gitIn(root, "init", "--quiet", "--initial-branch=main");
	gitIn(root, "add", "--all");
	gitIn(root, "commit", "--quiet", "--allow-empty", "-m", "head");
	return gitIn(root, "rev-parse", "HEAD");
}

async function probed(
	input: ProbeInput,
	head: { checkout: string; commit: string },
	more: Partial<ProbeOptions> = {},
): Promise<ProbeResult> {
	const probe = await Probe.open(input, {
		head,
		writer: { trusted: true, by: "reviewer" },
		trustWriters: true,
		timeout: 120_000,
		...more,
	});
	try {
		return await probe.run();
	} finally {
		await probe.close();
	}
}

// Runs git in a fresh repository under the probe's temporary directory, with no variable of git's own.
const repository = `import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
export const scratch = mkdtempSync(join(process.env.TMPDIR, "repository-"));
export const git = (...args) =>
	execFileSync("git", ["-C", scratch, "-c", "user.name=probe", "-c", "user.email=probe@example.invalid", ...args], {
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
export function twoCommits() {
	git("init", "--quiet", "--initial-branch=main");
	git("commit", "--quiet", "--allow-empty", "-m", "base");
	writeFileSync(join(scratch, "sum.ts"), "export const sum = (a: number, b: number) => a + b;\\n");
	git("add", "sum.ts");
	git("commit", "--quiet", "-m", "head");
}
export { env };
`;

describe.skipIf(!availability.available && !required)(
	`a probe's git and workspace imports under sandbox-runtime${reason ? ` (${reason})` : ""}`,
	() => {
		it("runs git init, and doctor's check says git runs", { timeout: 120_000 }, async () => {
			const commit = committed(worktree);
			const result = await probed(
				{
					script:
						'import { git, twoCommits } from "./repository.mjs";\ntwoCommits();\nprocess.stdout.write(git("log", "--format=%s"));\n',
					files: [{ path: "repository.mjs", text: repository }],
				},
				{ checkout: worktree, commit },
			);
			expect([result.exitCode, result.output]).toEqual([0, "head\nbase\n"]);
			expect(await Probe.gitAvailability()).toEqual({ available: true });
		});

		it("imports a workspace package by name, from its source under the policy's condition", {
			timeout: 120_000,
		}, async () => {
			const pkg = join(worktree, "packages", "pkg");
			mkdirSync(join(pkg, "src"), { recursive: true });
			writeFileSync(join(worktree, ".gitignore"), "node_modules\n");
			writeFileSync(
				join(pkg, "package.json"),
				JSON.stringify({
					name: "@scope/pkg",
					type: "module",
					exports: { ".": { "@scope/source": "./src/index.js", default: "./dist/index.js" } },
				}),
			);
			writeFileSync(join(pkg, "src", "index.js"), 'export const where = "source";\n');
			mkdirSync(join(worktree, "node_modules", "@scope"), { recursive: true });
			symlinkSync(join("..", "..", "packages", "pkg"), join(worktree, "node_modules", "@scope", "pkg"));
			const commit = committed(worktree);
			const result = await probed(
				{ script: 'const { where } = await import("@scope/pkg");\nconsole.log(where);\n' },
				{ checkout: worktree, commit },
				{ conditions: ["@scope/source"] },
			);
			expect([result.exitCode, result.output]).toEqual([0, "source\n"]);
		});

		it("runs this checkout's melian review on a repository of the probe's own", { timeout: 300_000 }, async () => {
			const checkout = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
			const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
			const review = `import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { env, scratch, twoCommits } from "./repository.mjs";
twoCommits();
const ran = spawnSync(process.execPath, [resolve("packages/cli/bin/melian.js"), "review", "HEAD~1...HEAD"], { cwd: scratch, env, encoding: "utf8" });
console.log(JSON.stringify({ status: ran.status, output: ran.stdout + ran.stderr }));
`;
			const result = await probed(
				{ script: review, files: [{ path: "repository.mjs", text: repository }] },
				{ checkout, commit },
				{ conditions: ["@melian-agent/source"] },
			);
			expect(result.exitCode, result.output).toBe(0);
			const ran = JSON.parse(result.output) as { status: number; output: string };
			// The probe holds no credential, so the review stops at its plan, which it reaches only once git has read the
			// range.
			expect(ran, result.output).toMatchObject({ status: 2, output: expect.stringContaining("Plan: no model for") });
		});
	},
);
