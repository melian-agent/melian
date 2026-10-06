import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandardsInventory, standardsLimits } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Io } from "../src/commands.ts";
import { doctor } from "../src/doctor.ts";

let directory: string;
let repo: string;
let output: string;
let io: Io;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "melian-doctor-inventory-"));
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
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

describe("doctor standards branches", { timeout: 60_000 }, () => {
	it("omits the standards check outside a repository", async () => {
		const inspect = vi.spyOn(StandardsInventory, "inspect");
		await doctor({ ...io, cwd: directory });
		expect(inspect).not.toHaveBeenCalled();
		expect(output).not.toMatch(/^(?:ok|warn)\s+standards\s/m);
	});

	it("prints an empty inventory without a path separator", async () => {
		await doctor(io);
		expect(output).toMatch(/^ok\s+standards\s+0 files, 0 bytes$/m);
	});

	it.each([new Error("bad\n\u001b[31mpath"), "bad\n\u001b[31mpath"])(
		"renders an inventory failure as visible text: %s",
		async (failure) => {
			vi.spyOn(StandardsInventory, "inspect").mockRejectedValueOnce(failure);
			await doctor(io);
			expect(output).toMatch(/^warn\s+standards\s+bad\\u000a\\u001b\[31mpath$/m);
			expect(output).not.toContain("\u001b");
		},
	);

	it("counts unequal oversized and symlink warnings", async () => {
		for (const name of ["AGENTS.md", "CLAUDE.md"])
			writeFileSync(join(repo, name), "x".repeat(standardsLimits.fileBytes + 1));
		for (const name of ["a", "b", "c"]) {
			mkdirSync(join(repo, name));
			symlinkSync("../AGENTS.md", join(repo, name, "AGENTS.md"));
		}
		await doctor(io);
		expect(output).toMatch(/^warn\s+standards\s+2 files, .*; 2 over 256 KiB; 3 symlinks skipped$/m);
	});

	it("names a remainder made entirely of skipped symlinks", async () => {
		for (let index = 0; index < 12; index++) {
			const path = join(repo, `p${String(index).padStart(2, "0")}`);
			mkdirSync(path);
			symlinkSync("missing.md", join(path, "AGENTS.md"));
		}
		await doctor(io);
		expect(output).toMatch(/^warn\s+standards\s+0 files, 0 bytes; .*2 more skipped symlinks; 12 symlinks skipped$/m);
		expect(output).not.toContain("and 0 more");
	});
});
