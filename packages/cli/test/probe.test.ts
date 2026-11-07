import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pipeline from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main, usageExitCode } from "../src/main.ts";
import * as probeCommand from "../src/probe.ts";

// `melian probe` reads a directory and runs it through Probe. The runs that need the real sandbox skip where it cannot
// run, unless MELIAN_PROBE_SANDBOX=1 says this host must run them, as CI does on macOS and Linux.

const availability = await pipeline.Probe.availability();
const required = process.env.MELIAN_PROBE_SANDBOX === "1";

let repo: string;
let dir: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-cli-")));
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFileSync(join(repo, "value.txt"), "from the checkout\n");
	dir = join(repo, "probes", "first");
	mkdirSync(join(dir, "fixture"), { recursive: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(repo, { recursive: true, force: true });
});

async function melian(args: readonly string[]) {
	let stdout = "";
	let stderr = "";
	const io: Io = {
		cwd: repo,
		env: process.env,
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		color: false,
	};
	return { status: await main(args, io), stdout, stderr };
}

describe("melian probe arguments", () => {
	it("names the bound of --timeout, and the one directory it takes", async () => {
		expect((await melian(["probe"])).stderr).toBe(
			"melian: probe takes one directory\nRun melian --help for usage.\n",
		);
		expect((await melian(["probe", "a", "--timeout", "601"])).stderr).toBe(
			"melian: --timeout takes whole seconds from 1 to 600\nRun melian --help for usage.\n",
		);
		expect((await melian(["review", "main", "--timeout", "5"])).stderr).toBe(
			"melian: --timeout is only available for probe\nRun melian --help for usage.\n",
		);
	});

	it.each([
		[["probe"]],
		[["probe", "a", "b"]],
		[["probe", "a", "--timeout", "0"]],
		[["probe", "a", "--timeout", "601"]],
		[["probe", "a", "--timeout", "1.5"]],
		[["probe", "a", "--timeout", "-1"]],
		[["review", "main", "--timeout", "5"]],
	])("refuses %j as usage", async (args) => {
		const run = vi.spyOn(probeCommand, "probe");
		expect((await melian(args)).status).toBe(usageExitCode);
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		[["probe", "a", "--trust-head"], { trustHead: true, json: false }],
		[["probe", "a"], { trustHead: false, json: false }],
		[["probe", "a", "--json", "--timeout", "600"], { trustHead: false, json: true, timeout: 600_000 }],
		[["probe", "a", "--timeout", "1"], { trustHead: false, json: false, timeout: 1_000 }],
	])("passes %j on", async (args, options) => {
		const run = vi.spyOn(probeCommand, "probe").mockResolvedValue(0);
		expect((await melian(args)).status).toBe(0);
		expect(run).toHaveBeenCalledExactlyOnceWith(expect.anything(), "a", options);
	});
});

describe("melian probe", () => {
	it("refuses without --trust-head, and opens nothing", async () => {
		writeFileSync(join(dir, "probe.mjs"), "console.log('ran');\n");
		const open = vi.spyOn(pipeline.Probe, "open");
		const result = await melian(["probe", "probes/first"]);
		expect(result).toEqual({
			status: 2,
			stdout: "",
			stderr:
				"melian: the head's code may not run here: nothing git records says whose code the checkout is; pass --trust-head if you have read this code and want it probed\n",
		});
		expect(open).toHaveBeenCalledOnce();
	});

	it("refuses a directory without probe.mjs, or holding a link", async () => {
		expect(await melian(["probe", "probes/first", "--trust-head"])).toMatchObject({
			status: 2,
			stderr: expect.stringContaining("ENOENT"),
		});
		writeFileSync(join(dir, "probe.mjs"), "");
		symlinkSync(join(repo, "value.txt"), join(dir, "fixture", "link"));
		expect(await melian(["probe", "probes/first", "--trust-head"])).toEqual({
			status: 2,
			stdout: "",
			stderr: "melian: fixture/link is neither a file nor a directory\n",
		});
	});

	it("refuses more files than a probe takes", async () => {
		writeFileSync(join(dir, "probe.mjs"), "");
		for (let index = 0; index <= pipeline.probeLimits.files; index++) writeFileSync(join(dir, `f${index}`), "");
		expect(await melian(["probe", "probes/first", "--trust-head"])).toMatchObject({
			status: 2,
			stderr: `melian: a probe has at most ${pipeline.probeLimits.files} files\n`,
		});
	});

	// Writes and reads 1 MiB files twice, which can pass five seconds on a loaded machine.
	it("reads a file at the size bound and refuses one past it before reading it", { timeout: 30_000 }, async () => {
		writeFileSync(join(dir, "probe.mjs"), "");
		writeFileSync(join(dir, "fixture", "big"), "x".repeat(pipeline.probeLimits.fileBytes));
		const open = vi.spyOn(pipeline.Probe, "open").mockRejectedValue(new pipeline.ProbeError("invalidProbe", "stop"));
		expect((await melian(["probe", "probes/first", "--trust-head"])).stderr).toBe("melian: stop\n");
		expect(open.mock.calls[0]![0].files).toEqual([
			{ path: "fixture/big", bytes: Buffer.from("x".repeat(pipeline.probeLimits.fileBytes)) },
		]);
		writeFileSync(join(dir, "fixture", "big"), "x".repeat(pipeline.probeLimits.fileBytes + 1));
		expect(await melian(["probe", "probes/first", "--trust-head"])).toMatchObject({
			status: 2,
			stderr: `melian: fixture/big is larger than ${pipeline.probeLimits.fileBytes} bytes\n`,
		});
		expect(open).toHaveBeenCalledOnce();
	});

	it("reads as many files as a probe takes, and opens nothing past them", async () => {
		writeFileSync(join(dir, "probe.mjs"), "");
		for (let index = 0; index < pipeline.probeLimits.files; index++) writeFileSync(join(dir, `f${index}`), "");
		const open = vi.spyOn(pipeline.Probe, "open").mockRejectedValue(new pipeline.ProbeError("invalidProbe", "stop"));
		await melian(["probe", "probes/first", "--trust-head"]);
		expect(open.mock.calls[0]![0].files).toHaveLength(pipeline.probeLimits.files);
		writeFileSync(join(dir, "extra"), "");
		expect((await melian(["probe", "probes/first", "--trust-head"])).stderr).toBe(
			`melian: a probe has at most ${pipeline.probeLimits.files} files\n`,
		);
		expect(open).toHaveBeenCalledOnce();
	});

	it("refuses the aggregate byte limit while reading, before opening the probe", async () => {
		writeFileSync(join(dir, "probe.mjs"), "");
		// Two files that each fit but together exceed the aggregate: the CLI must refuse while reading, not leave it to
		// Probe.open after both are in memory.
		const half = Math.ceil(pipeline.probeLimits.fileBytes / 2) + 1;
		writeFileSync(join(dir, "a"), "x".repeat(half));
		writeFileSync(join(dir, "b"), "x".repeat(half));
		const open = vi.spyOn(pipeline.Probe, "open");
		expect((await melian(["probe", "probes/first", "--trust-head"])).stderr).toBe(
			`melian: a probe's files hold at most ${pipeline.probeLimits.fileBytes} bytes\n`,
		);
		expect(open).not.toHaveBeenCalled();
	});

	it("fails as any other error does when the directory cannot be read", async () => {
		writeFileSync(join(repo, "plain"), "");
		expect(await melian(["probe", "plain", "--trust-head"])).toMatchObject({
			status: 1,
			stderr: expect.stringContaining("ENOTDIR"),
		});
	});

	it.each([
		[{ exitCode: 0, signal: null, timedOut: false, truncated: false }, 30, 0, "Probe: exited 0"],
		[
			{ exitCode: null, signal: "SIGKILL", timedOut: true, truncated: false },
			2,
			1,
			"Probe: timed out after 2 seconds",
		],
		[{ exitCode: null, signal: "SIGTERM", timedOut: false, truncated: false }, 30, 1, "Probe: ended by SIGTERM"],
		[
			{ exitCode: 0, signal: null, timedOut: false, truncated: true },
			30,
			1,
			"Probe: exited 0; its output was cut at its limit",
		],
	] as const)("says how the probe ended: %j", async (ended, seconds, status, line) => {
		writeFileSync(join(dir, "probe.mjs"), "");
		const close = vi.fn(async () => ({ removed: true }));
		vi.spyOn(pipeline.Probe, "open").mockResolvedValue({
			run: async () => ({ ...ended, output: "" }),
			close,
		} as never);
		const args = ["probe", "probes/first", "--trust-head", "--timeout", String(seconds)];
		expect(await melian(args)).toEqual({ status, stdout: `${line}\n`, stderr: "" });
		expect(close).toHaveBeenCalledOnce();
	});

	it("closes the probe when its run throws", async () => {
		writeFileSync(join(dir, "probe.mjs"), "");
		const close = vi.fn(async () => ({ removed: true }));
		const run = async () => {
			throw new pipeline.ProbeError("sandboxUnavailable", "refused");
		};
		vi.spyOn(pipeline.Probe, "open").mockResolvedValue({ run, close } as never);
		expect((await melian(["probe", "probes/first", "--trust-head"])).status).toBe(2);
		expect(close).toHaveBeenCalledOnce();
	});

	it("escapes bidi and C1 controls in JSON output, which JSON.stringify leaves alone", async () => {
		writeFileSync(join(dir, "probe.mjs"), "");
		// U+202E reverses the text after it; U+009B is the C1 control sequence introducer.
		const output = "safe\u202eevil\u009b[2Jdone";
		const result = { exitCode: 0, signal: null, output, truncated: false, timedOut: false, error: "ps\u202efailed" };
		const close = vi.fn(async () => ({ removed: true }));
		vi.spyOn(pipeline.Probe, "open").mockResolvedValue({ run: async () => result, close } as never);
		const run = await melian(["probe", "probes/first", "--trust-head", "--json"]);
		expect(run.stdout).not.toMatch(/[\u202e\u009b]/);
		expect(JSON.parse(run.stdout)).toMatchObject({
			output: "safe\\u202eevil\\u009b[2Jdone",
			error: "ps\\u202efailed",
		});
	});

	it("reports a leftover scratch without replacing the probe's result", async () => {
		writeFileSync(join(dir, "probe.mjs"), "");
		const result = { exitCode: 0, signal: null, output: "ok\n", truncated: false, timedOut: false };
		const close = vi.fn(async () => ({ removed: false, leftover: "/tmp/melian-probe-x", reason: "EPERM: unlink" }));
		vi.spyOn(pipeline.Probe, "open").mockResolvedValue({ run: async () => result, close } as never);
		const run = await melian(["probe", "probes/first", "--trust-head"]);
		// The probe passed, but the leftover downgrades the exit and prints a distinct warning naming the path.
		expect(run.status).toBe(1);
		expect(run.stdout).toBe("ok\nProbe: exited 0\n");
		expect(run.stderr).toBe(
			"melian: the probe's scratch could not be removed and was left at /tmp/melian-probe-x: EPERM: unlink\n",
		);
	});

	it("says where the sandbox cannot run", async () => {
		writeFileSync(join(dir, "probe.mjs"), "");
		vi.spyOn(pipeline.Probe, "open").mockRejectedValue(
			new pipeline.ProbeError(
				"sandboxUnavailable",
				"sandbox-runtime cannot run here: bubblewrap\u001b[2J not found",
			),
		);
		expect(await melian(["probe", "probes/first", "--trust-head"])).toEqual({
			status: 2,
			stdout: "",
			stderr: "melian: sandbox-runtime cannot run here: bubblewrap\\u001b[2J not found\n",
		});
	});

	describe.skipIf(!availability.available && !required)("under the sandbox", () => {
		it("runs the probe in the checkout with its files and prints how it ended", { timeout: 60_000 }, async () => {
			writeFileSync(join(dir, "fixture", "name.txt"), "fixture\n");
			writeFileSync(
				join(dir, "probe.mjs"),
				[
					'import { readFileSync } from "node:fs";',
					'process.stdout.write(readFileSync("value.txt", "utf8"));',
					'process.stdout.write(readFileSync(new URL("./fixture/name.txt", import.meta.url), "utf8"));',
					'process.stdout.write("\\u001b[31m\\n");',
				].join("\n"),
			);
			expect(await melian(["probe", "probes/first", "--trust-head"])).toEqual({
				status: 0,
				stdout: "from the checkout\nfixture\n\\u001b[31m\nProbe: exited 0\n",
				stderr: "",
			});
		});

		it("exits 1 for a probe that fails, and prints JSON", { timeout: 60_000 }, async () => {
			writeFileSync(join(dir, "probe.mjs"), "console.log('no'); process.exit(4);\n");
			const result = await melian(["probe", "probes/first", "--trust-head", "--json"]);
			expect(result.status).toBe(1);
			expect(JSON.parse(result.stdout)).toEqual({
				exitCode: 4,
				signal: null,
				// visibleText escapes every control, the newline included, as the plain output does per line.
				output: "no\\u000a",
				truncated: false,
				timedOut: false,
			});
		});

		it("exits 1 for a probe past its time limit", { timeout: 60_000 }, async () => {
			writeFileSync(join(dir, "probe.mjs"), "setInterval(() => {}, 1000);\n");
			expect(await melian(["probe", "probes/first", "--trust-head", "--timeout", "1"])).toEqual({
				status: 1,
				stdout: "Probe: timed out after 1 second\n",
				stderr: "",
			});
		});

		it("exits 1 for a probe that floods its output", { timeout: 60_000 }, async () => {
			writeFileSync(
				join(dir, "probe.mjs"),
				'const flood = () => process.stdout.write("y".repeat(65536), flood);\nflood();\n',
			);
			const result = await melian(["probe", "probes/first", "--trust-head"]);
			expect(result.status).toBe(1);
			const output = "y".repeat(pipeline.probeLimits.output.default);
			expect(result.stdout.slice(0, output.length + 1)).toBe(`${output}\n`);
			expect(result.stdout.slice(output.length + 1)).toMatch(
				/^Probe: (exited \d+|ended by SIG[A-Z]+); its output was cut at its limit\n$/,
			);
		});
	});
});
