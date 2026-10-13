import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/commands.ts";
import { doctor } from "../src/doctor.ts";

let directory: string;
let repo: string;
let output: string;
let io: Io;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "melian-doctor-resolution-"));
	repo = join(directory, "repo");
	mkdirSync(repo);
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

function write(files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
}

const lens = (...frontMatter: string[]) =>
	[
		"---",
		"name: cleanup",
		"description: Reuse.",
		"tier: medium",
		"rules:",
		"  - id: reuse",
		"    description: Repeats a helper.",
		...frontMatter,
		"---",
		"Find what repeats.",
		"",
	].join("\n");

async function resolutionLines(): Promise<string[]> {
	await doctor(io);
	return output
		.split("\n")
		.filter((line) => /^\w+ +resolution +/.test(line))
		.map((line) => line.replace(/^(\w+) +resolution +/, "$1: "));
}

describe("doctor resolution overrides", { timeout: 60_000 }, () => {
	it("says so when no file overrides anything, and prints nothing outside a repository", async () => {
		expect(await resolutionLines()).toEqual([
			"ok: no file overrides a lens's default or a farther file's resolution",
		]);
		output = "";
		io = { ...io, cwd: directory };
		expect(await resolutionLines()).toEqual([]);
	});

	it("lists the farther ceiling and rule entry a nested table overrides, once", async () => {
		write({
			"melian.yaml": [
				"resolution:",
				"  P2: acknowledge",
				"  checks:",
				"    lens.cleanup: { ceiling: advisory }",
				"    lens.trust-boundary:",
				"      rules:",
				"        terminal-escape: { P1: acknowledge }",
				"",
			].join("\n"),
			"services/payments/melian.yaml": "resolution:\n  P1: block\n",
			"services/payments/api/melian.yaml": "knowledge:\n  writeBack: false\n",
		});
		expect(await resolutionLines()).toEqual([
			"ok: services/payments/melian.yaml: resolution.P1 overrides melian.yaml's resolution.checks.lens.cleanup.ceiling for P1 lens.cleanup findings",
			"ok: services/payments/melian.yaml: resolution.P1 overrides melian.yaml's resolution.checks.lens.trust-boundary.rules.terminal-escape for P1 lens.trust-boundary terminal-escape findings",
		]);
	});

	it("lists a lens's declared ceiling a root table overrides, as the lens applies in each folder", async () => {
		write({
			"melian.yaml": "resolution:\n  P2: acknowledge\n",
			".melian/lenses/cleanup/LENS.md": lens("resolution: { ceiling: advisory }"),
			"docs/melian.yaml": "resolution:\n  P3: silent\n",
			"docs/.melian/lenses/cleanup/LENS.md": lens("resolution: { P3: advisory }"),
		});
		expect(await resolutionLines()).toEqual([
			"ok: melian.yaml: resolution.P2 overrides lens cleanup's declared ceiling for P2 lens.cleanup findings",
			"ok: docs/melian.yaml: resolution.P3 overrides lens cleanup's declared mapping for P3 lens.cleanup findings",
		]);
	});

	it("walks a folder that defines a lens, though it holds no melian.yaml", async () => {
		write({
			"melian.yaml": "resolution:\n  P2: acknowledge\n",
			"services/.agents/lenses/cleanup/LENS.md": lens("resolution: { ceiling: advisory }"),
			"notes/LENS.md": "A note about lenses, not a lens.\n",
		});
		expect(await resolutionLines()).toEqual([
			"ok: melian.yaml: resolution.P2 overrides lens cleanup's declared ceiling for P2 lens.cleanup findings",
		]);
	});

	it("lists what a ceiling-only file drops, and a preference file's overrides at the root", async () => {
		write({
			"melian.yaml": "resolution:\n  P2: acknowledge\n",
			"a/melian.yaml": "resolution:\n  checks:\n    lens.cleanup: { ceiling: block }\n",
			"melian.local.yaml": "resolution:\n  P2: silent\n",
		});
		expect(await resolutionLines()).toEqual([
			"ok: melian.local.yaml: resolution.P2 overrides melian.yaml's table for P2 findings",
			"ok: melian.local.yaml: resolution.P2 overrides a/melian.yaml's resolution.checks.lens.cleanup.ceiling for P2 lens.cleanup findings",
			"ok: a/melian.yaml: resolution.checks.lens.cleanup.ceiling overrides melian.yaml's table for P2 lens.cleanup findings",
		]);
	});

	it("puts the user-level preference file first on the walk, by the path it was given", async () => {
		write({ "melian.yaml": "resolution:\n  P1: block\n" });
		const preferences = join(directory, "melian", "config.yaml");
		mkdirSync(dirname(preferences), { recursive: true });
		writeFileSync(preferences, "resolution:\n  P1: silent\n");
		expect(await resolutionLines()).toEqual([
			`ok: ${preferences}: resolution.P1 overrides melian.yaml's table for P1 findings`,
		]);
	});

	it("walks the root when only a preference file speaks there", async () => {
		write({
			".melian/lenses/cleanup/LENS.md": lens("resolution: { ceiling: advisory }"),
			"melian.local.yaml": "resolution:\n  P1: block\n",
		});
		expect(await resolutionLines()).toEqual([
			"ok: melian.local.yaml: resolution.P1 overrides lens cleanup's declared ceiling for P1 lens.cleanup findings",
		]);
	});

	it("lists folders in path order, tracked or not, with a path's control characters made visible", async () => {
		write({
			"melian.yaml": "resolution:\n  P2: acknowledge\n",
			"z/melian.yaml": "resolution:\n  P2: block\n",
			"a\u001b/melian.yaml": "resolution:\n  P2: silent\n",
		});
		execFileSync("git", ["add", "z/melian.yaml"], { cwd: repo });
		expect(await resolutionLines()).toEqual([
			"ok: a\\u001b/melian.yaml: resolution.P2 overrides melian.yaml's table for P2 findings",
			"ok: z/melian.yaml: resolution.P2 overrides melian.yaml's table for P2 findings",
		]);
		expect(output).not.toContain("\u001b");
	});

	it("warns, with the text made visible, when a file cannot be read", async () => {
		write({ "a\u001b/melian.yaml": "resolution: [\n" });
		const [line] = await resolutionLines();
		expect(line).toMatch(/^warn: .*a\\u001b\/melian\.yaml/);
		expect(output).not.toContain("\u001b");
	});
});
