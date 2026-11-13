import type * as ChildProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn } from "../../core/test/fixtures/repo.ts";
import { Probe, type ProbeOptions } from "../src/probe.ts";

// Writing the head runs git and sh through execFile. This records each call and runs it for real, and fails a sh call
// when a test asks it to, so the environment each gets and a failed link script are visible.
const recorded = vi.hoisted(() => ({
	calls: [] as { file: string; args: readonly string[]; env: Record<string, string | undefined> }[],
	failShell: undefined as { code: number; stderr: string } | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	const execFile = Object.assign(actual.execFile.bind(undefined), {
		[Symbol.for("nodejs.util.promisify.custom")]: (
			file: string,
			args: readonly string[],
			options: { cwd?: string; env: Record<string, string | undefined> },
		) => {
			recorded.calls.push({ file, args, env: options.env });
			const failure = recorded.failShell;
			if (file === "/bin/sh" && failure !== undefined)
				return Promise.reject(Object.assign(new Error("sh failed"), failure));
			return new Promise((resolve, reject) => {
				actual.execFile(file, args, options, (error, stdout, stderr) =>
					error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
				);
			});
		},
	});
	return { ...actual, execFile };
});

let scratch: string;
let checkout: string;
let head: string;

const sandbox = {
	platform: "linux" as const,
	kind: "fake",
	unavailable: () => undefined,
	open: async () => {},
	wrap: async (command: string) => ["/bin/bash", "-c", command],
	cleanup: () => {},
	close: async () => {},
};

function options(): ProbeOptions {
	return {
		head: { checkout, commit: head },
		writer: { trusted: true, by: "writer" },
		trustWriters: true,
		sandbox,
	};
}

beforeEach(() => {
	recorded.calls.length = 0;
	recorded.failShell = undefined;
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-head-test-")));
	checkout = join(scratch, "checkout");
	mkdirSync(join(checkout, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(checkout, "tracked.txt"), "tracked\n");
	writeFileSync(join(checkout, ".gitignore"), "node_modules\n");
	gitIn(checkout, "init", "--quiet", "--initial-branch=main");
	gitIn(checkout, "add", "--all");
	gitIn(checkout, "commit", "--quiet", "-m", "head");
	head = gitIn(checkout, "rev-parse", "HEAD");
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("Probe.open writing the head", () => {
	it("runs git with no user or system configuration and sh with only a PATH, then removes its repository", async () => {
		const probe = await Probe.open({ script: "" }, options());
		await probe.close();
		const gits = recorded.calls.filter((call) => call.file === "git");
		expect(gits.map((call) => call.args[0])).toEqual(["rev-parse", "init", "read-tree", "checkout-index"]);
		const repository = gits[0]!.env.HOME!;
		expect(repository).toMatch(/melian-head-/);
		const isolated = {
			PATH: process.env.PATH,
			HOME: repository,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		};
		expect(gits.map((call) => call.env)).toEqual([
			isolated,
			isolated,
			{ ...isolated, GIT_DIR: repository, GIT_WORK_TREE: expect.stringMatching(/tree$/) },
			{ ...isolated, GIT_DIR: repository, GIT_WORK_TREE: expect.stringMatching(/tree$/) },
		]);
		expect(recorded.calls.filter((call) => call.file === "/bin/sh").map((call) => call.env)).toEqual([
			{ PATH: process.env.PATH },
		]);
		expect(existsSync(repository)).toBe(false);
	});

	it("refuses a head whose dependency links fail, with the link script's own output", async () => {
		recorded.failShell = { code: 2, stderr: "ln: tree/node_modules/dep: File exists" };
		await expect(Probe.open({ script: "" }, options())).rejects.toMatchObject({
			code: "invalidProbe",
			message: "the dependency install: linking dependencies failed: ln: tree/node_modules/dep: File exists",
		});
	});
});
