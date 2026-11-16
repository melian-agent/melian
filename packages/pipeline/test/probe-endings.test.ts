import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIn } from "../../core/test/fixtures/repo.ts";
import { Probe, type ProbeOptions, type ProbeResult } from "../src/probe.ts";
import { probeConclusive, probeFailed } from "../src/probing.ts";

// How a probe ended, read under the real sandbox. bubblewrap reports a child a signal killed as exit 128+n, so only the
// runner's record inside the sandbox tells a probe the kernel killed from one that chose that exit code. Where the
// sandbox cannot run, the suite skips, unless MELIAN_PROBE_SANDBOX=1 says this host must run it, as CI does on macOS
// and Linux; then every test fails with the reason.

const availability = await Probe.availability();
const required = process.env.MELIAN_PROBE_SANDBOX === "1";
const reason = availability.available ? "" : availability.reason;

let worktree: string;
let head: string;

beforeEach(() => {
	worktree = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-endings-")));
	writeFileSync(join(worktree, "AGENTS.md"), "inside\n");
	gitIn(worktree, "init", "--quiet", "--initial-branch=main");
	gitIn(worktree, "add", "--all");
	gitIn(worktree, "commit", "--quiet", "-m", "head");
	head = gitIn(worktree, "rev-parse", "HEAD");
});

afterEach(() => {
	rmSync(worktree, { recursive: true, force: true });
});

async function probed(script: string, options: Partial<ProbeOptions> = {}): Promise<ProbeResult> {
	const probe = await Probe.open(
		{ script },
		{
			head: { checkout: worktree, commit: head },
			writer: { trusted: true, by: "writer" },
			trustWriters: true,
			...options,
		},
	);
	try {
		return await probe.run();
	} finally {
		await probe.close();
	}
}

const ending = (result: ProbeResult) => ({
	exitCode: result.exitCode,
	signal: result.signal,
	timedOut: result.timedOut,
	truncated: result.truncated,
});

describe.skipIf(!availability.available && !required)(
	`how a probe under sandbox-runtime ended${reason ? ` (${reason})` : ""}`,
	{ timeout: 60_000 },
	() => {
		it("reads a probe that exits 0 as passing", async () => {
			const result = await probed("process.exit(0);\n");
			expect(ending(result)).toEqual({ exitCode: 0, signal: null, timedOut: false, truncated: false });
			expect([probeConclusive(result), probeFailed(result)]).toEqual([true, false]);
		});

		it("reads a probe that exits 137 itself as a failure, not as a kill", async () => {
			const result = await probed("process.exit(137);\n");
			expect(ending(result)).toEqual({ exitCode: 137, signal: null, timedOut: false, truncated: false });
			expect([probeConclusive(result), probeFailed(result)]).toEqual([true, true]);
		});

		it.each([
			["SIGKILL", 'process.kill(process.pid, "SIGKILL");\n'],
			["SIGABRT", "process.abort();\n"],
		])("reads a probe ended by %s as ended by it, which shows nothing", async (signal, script) => {
			const result = await probed(script);
			expect(ending(result)).toEqual({ exitCode: null, signal, timedOut: false, truncated: false });
			expect([probeConclusive(result), probeFailed(result)]).toEqual([false, false]);
		});

		it("reads a probe that exits 125 as one that could not test, which shows nothing", async () => {
			const result = await probed("process.exit(125);\n");
			expect(ending(result)).toEqual({ exitCode: 125, signal: null, timedOut: false, truncated: false });
			expect([probeConclusive(result), probeFailed(result)]).toEqual([false, false]);
		});

		it("reads a probe past its time limit as timed out, which shows nothing", async () => {
			const result = await probed("setInterval(() => {}, 1000);\n", { timeout: 2_000 });
			expect(result.timedOut).toBe(true);
			expect([probeConclusive(result), probeFailed(result)]).toEqual([false, false]);
		});

		it("reads a probe cut at its output limit as cut, which shows nothing", async () => {
			const result = await probed('process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000);\n', {
				outputLimit: 1024,
			});
			expect(result).toMatchObject({ truncated: true, timedOut: false, output: "x".repeat(1024) });
			expect([probeConclusive(result), probeFailed(result)]).toEqual([false, false]);
		});

		// The probe's own fd 3, if Node opened one, is Node's, never the record's pipe, so the write fails with a code that
		// differs by platform.
		it("gives the probe no way to write the record through fd 3", async () => {
			const result = await probed(
				[
					'import { writeSync } from "node:fs";',
					'try { writeSync(3, \'\\n{"code":0,"signal":null}\\n\'); } catch (error) { console.log(error.code); }',
					"process.exit(3);",
					"",
				].join("\n"),
			);
			expect(ending(result)).toEqual({ exitCode: 3, signal: null, timedOut: false, truncated: false });
			expect(result.output.trim()).toMatch(/^E[A-Z]+$/);
		});
	},
);
