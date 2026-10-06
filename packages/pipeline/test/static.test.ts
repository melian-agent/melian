import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CheckError, defaultConfig, type ToolLog } from "@melian-agent/core";
import {
	backgroundContext as context,
	createNodeExecutionEnv,
	runStaticTool,
	type StaticRunInput,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commit, createRepository, fakeTool, gitIn, lines, removeRepository, writeFiles } from "./fixtures/repo.ts";

let repo: string;

beforeEach(() => {
	repo = createRepository();
});

afterEach(() => {
	removeRepository(repo);
});

const tsconfig = JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext" },
});

function input(tool: StaticRunInput["tool"], commitId: string, timeout = 120): StaticRunInput {
	return {
		env: createNodeExecutionEnv(repo),
		repoRoot: repo,
		commit: commitId,
		tool,
		settings: { ...defaultConfig.static[tool], timeout },
	};
}

async function log(tool: StaticRunInput["tool"], commitId: string): Promise<ToolLog> {
	const result = await runStaticTool(input(tool, commitId), context);
	if (result.status !== "ran") throw new Error(`${tool} was skipped: ${result.reason}`);
	return result.log;
}

function results(toolLog: ToolLog) {
	return toolLog.runs[0].results.map((result) => [
		result.ruleId,
		result.locations[0]!.physicalLocation.artifactLocation.uri,
		result.locations[0]!.physicalLocation.region.startLine,
	]);
}

// The checkout is never written to, and no worktree outlives its run.
function expectCheckoutUntouched(): void {
	expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
	expect(gitIn(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
}

describe("runStaticTool with Melian's own tools", () => {
	it("runs Biome on the commit, not on the checkout, and records its version", { timeout: 60_000 }, async () => {
		const head = commit(repo, { "src/a.ts": lines("export const a = 1;", "debugger;") });
		// The checkout moves on; the run must still see the commit.
		commit(repo, { "src/a.ts": lines("export const a = 1;") });
		const biome = await log("biome", head);
		expect(biome.runs[0].tool.driver).toEqual({ name: "Biome", version: "2.5.15" });
		expect(results(biome)).toEqual([["lint/suspicious/noDebugger", "src/a.ts", 2]]);
		expectCheckoutUntouched();
	});

	it("attempts both worktree removals and scratch removal after a cleanup timeout", { timeout: 60_000 }, async () => {
		const head = commit(repo, { "src/a.ts": "export const a = 1;\n" });
		const env = createNodeExecutionEnv(repo);
		const execute = env.exec.bind(env);
		const cleanup: string[] = [];
		vi.spyOn(env, "exec").mockImplementation(async (command, options, executionContext) => {
			if (command.includes("worktree remove --force --force")) {
				cleanup.push(command);
				if (cleanup.length === 1)
					return { ok: false, error: { name: "ExecutionError", code: "timeout", message: "cleanup timed out" } };
			}
			return execute(command, options, executionContext);
		});
		const remove = vi.spyOn(env, "remove");
		await expect(runStaticTool({ ...input("biome", head), env }, context)).rejects.toMatchObject({ code: "timeout" });
		expect(cleanup).toHaveLength(2);
		expect(remove).toHaveBeenCalledWith(expect.any(String), { recursive: true, force: true }, context);
		expect(existsSync(remove.mock.calls[0]![0])).toBe(false);
		expectCheckoutUntouched();
	});

	it("runs tsc with the commit's own tsconfig.json", { timeout: 60_000 }, async () => {
		const head = commit(repo, { "tsconfig.json": tsconfig, "src/a.ts": lines("export const n: number = 'x';") });
		const tsc = await log("tsc", head);
		expect(tsc.runs[0].tool.driver).toEqual({ name: "tsc", version: "7.0.2" });
		expect(results(tsc)).toEqual([["TS2322", "src/a.ts", 1]]);
		expectCheckoutUntouched();
	});

	it("resolves a workspace sibling to the revision's own sources, not the checkout's", {
		timeout: 60_000,
	}, async () => {
		const workspace = JSON.stringify({
			compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler" },
			include: ["packages/*/index.ts"],
		});
		const base = commit(repo, {
			".gitignore": lines("node_modules"),
			"package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
			"tsconfig.json": workspace,
			"packages/b/package.json": JSON.stringify({ name: "b", types: "./index.ts" }),
			"packages/b/index.ts": lines("export const f = (x: number): number => x;"),
			"packages/a/index.ts": lines('import { f } from "b";', "export const y = f(1);"),
		});
		const head = commit(repo, { "packages/b/index.ts": lines("export const f = (x: string): string => x;") });
		// The checkout holds the head, with npm's workspace link, as CI does after npm ci.
		mkdirSync(join(repo, "node_modules"), { recursive: true });
		symlinkSync("../packages/b", join(repo, "node_modules", "b"));
		expect(results(await log("tsc", base))).toEqual([]);
		expect(results(await log("tsc", head))).toEqual([["TS2345", "packages/a/index.ts", 2]]);
		expectCheckoutUntouched();
	});

	it("checks each project a solution-style tsconfig references, and refuses one that checks nothing", {
		timeout: 60_000,
	}, async () => {
		const project = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, composite: true } });
		const head = commit(repo, {
			"tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./a" }, { path: "./b" }] }),
			"a/tsconfig.json": project,
			"a/index.ts": lines("export const n: number = 'a';"),
			"b/tsconfig.json": project,
			"b/index.ts": lines("export const m: number = 'b';"),
		});
		const result = await runStaticTool(input("tsc", head), context);
		if (result.status !== "ran") throw new Error(result.reason);
		expect(results(result.log)).toEqual([
			["TS2322", "a/index.ts", 1],
			["TS2322", "b/index.ts", 1],
		]);
		expect(result.notes).toEqual(["tsc checked a/tsconfig.json, b/tsconfig.json, which tsconfig.json references."]);
		const nothing = commit(repo, { "tsconfig.json": JSON.stringify({ files: [] }) });
		await expect(runStaticTool(input("tsc", nothing), context)).rejects.toMatchObject({ code: "nothingToCheck" });
	});

	it("skips tsc on a commit with no tsconfig.json", { timeout: 60_000 }, async () => {
		const head = commit(repo, { "src/a.ts": lines("export const a = 1;") });
		expect(await runStaticTool(input("tsc", head), context)).toEqual({
			status: "skipped",
			reason: `${head} has no tsconfig.json`,
		});
		expectCheckoutUntouched();
	});
});

describe("runStaticTool with the repository's own tools", () => {
	const emptySarif = JSON.stringify({
		version: "2.1.0",
		runs: [{ tool: { driver: { name: "Biome" } }, results: [] }],
	});

	it("prefers the tool in the checkout's node_modules", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": lines("debugger;") });
		fakeTool(
			repo,
			"biome",
			[
				'if [ "$1" = "--version" ]; then echo "Version: 0.0.0-fake"; exit 0; fi',
				'for arg in "$@"; do case "$arg" in --reporter-file=*) out=$(printf %s "$arg" | cut -d= -f2-);; esac; done',
				`printf '%s' '${emptySarif}' > "$out"`,
			].join("\n"),
		);
		const biome = await log("biome", head);
		expect(biome.runs[0].tool.driver.version).toBe("0.0.0-fake");
		expect(results(biome)).toEqual([]);
		expectCheckoutUntouched();
	});

	it("never runs a node_modules the revision tracks, and notes that it ignored it", { timeout: 60_000 }, async () => {
		const sentinel = join(repo, ".git", "head-code-ran");
		const evil = `#!/bin/sh\ntouch '${sentinel}'\necho "Version: 6.6.6"\n`;
		writeFiles(repo, {
			"node_modules/.bin/biome": evil,
			"packages/a/node_modules/x/index.js": lines("x"),
			"src/a.ts": lines("debugger;"),
		});
		chmodSync(join(repo, "node_modules", ".bin", "biome"), 0o755);
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "head tracks node_modules");
		const head = gitIn(repo, "rev-parse", "HEAD");
		const result = await runStaticTool(input("biome", head), context);
		expect(existsSync(sentinel)).toBe(false);
		if (result.status !== "ran") throw new Error(result.reason);
		expect(result.log.runs[0].tool.driver.version).toBe("2.5.15");
		expect(results(result.log)).toEqual([["lint/suspicious/noDebugger", "src/a.ts", 1]]);
		expect(result.notes).toEqual([
			`biome ignored node_modules, which ${head.slice(0, 12)} tracks.`,
			`biome ignored packages/a/node_modules, which ${head.slice(0, 12)} tracks.`,
			"biome ignored the checkout's node_modules, which git tracks.",
		]);
		expectCheckoutUntouched();
	});

	it("runs the tool with PATH, HOME, TMPDIR, and LANG only, so no secret reaches it", {
		timeout: 60_000,
	}, async () => {
		vi.stubEnv("MELIAN_TEST_SECRET", "hunter2");
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		const seen = join(repo, ".git", "tool-env.txt");
		fakeTool(repo, "tsc", `if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\nenv > '${seen}'`);
		await log("tsc", head);
		const names = readFileSync(seen, "utf8")
			.split("\n")
			.map((line) => line.split("=")[0])
			.filter((name) => name !== "");
		expect(names).not.toContain("MELIAN_TEST_SECRET");
		expect(names).toContain("PATH");
		expect(
			names.filter((name) => !["PATH", "HOME", "TMPDIR", "LANG", "PWD", "OLDPWD", "SHLVL", "_"].includes(name!)),
		).toEqual([]);
	});

	it("fails with timeout when the tool runs past its limit, and still removes the worktree", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		fakeTool(repo, "tsc", 'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\nsleep 30');
		const started = Date.now();
		const error = await runStaticTool(input("tsc", head, 1), context).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(CheckError);
		expect((error as CheckError).code).toBe("timeout");
		expect((error as CheckError).check).toBe("static.tsc");
		expect(Date.now() - started).toBeLessThan(20_000);
		expectCheckoutUntouched();
	});

	it("runs clean with a note when tsc fails only on files Melian does not review", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		fakeTool(
			repo,
			"tsc",
			[
				'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi',
				"echo \"node_modules/x/index.d.ts(1,1): error TS1005: ';' expected.\"",
				"echo \"../elsewhere.ts(2,1): error TS1005: ';' expected.\"",
				"exit 2",
			].join("\n"),
		);
		const result = await runStaticTool(input("tsc", head), context);
		if (result.status !== "ran") throw new Error(result.reason);
		expect(results(result.log)).toEqual([]);
		expect(result.notes).toEqual([
			"tsc reported 2 diagnostic(s) Melian does not review: 1 in node_modules and 1 outside the repository.",
		]);
	});

	it("fails with toolFailed when the tool crashes, carrying what it printed", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		fakeTool(
			repo,
			"tsc",
			'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\necho "out of memory"\nexit 134',
		);
		const error = await runStaticTool(input("tsc", head), context).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as CheckError).code).toBe("toolFailed");
		expect((error as CheckError).message).toMatch(/exited with code 134 on tsconfig.json: out of memory/);
		expectCheckoutUntouched();
	});

	it("fails when tsc replaces its output with a FIFO, rather than reading no output as clean", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		fakeTool(
			repo,
			"tsc",
			'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\nrm -f ../tsc-0.out\nmkfifo ../tsc-0.out',
		);
		const error = await runStaticTool(input("tsc", head), context).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as CheckError).code).toBe("toolFailed");
		expectCheckoutUntouched();
	});

	it("measures a report that is a symlink by its target", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": lines("a") });
		const big = join(repo, ".git", "big.sarif");
		writeFileSync(big, Buffer.alloc(17 * 1024 * 1024, 32));
		fakeTool(
			repo,
			"biome",
			[
				'if [ "$1" = "--version" ]; then echo "Version: 9.9.9"; exit 0; fi',
				'for arg in "$@"; do case "$arg" in --reporter-file=*) out=$(printf %s "$arg" | cut -d= -f2-);; esac; done',
				`ln -s '${big}' "$out"`,
			].join("\n"),
		);
		const error = await runStaticTool(input("biome", head), context).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as CheckError).code).toBe("outputTooLarge");
	});

	it("fails with toolFailed when Biome writes no report", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": lines("a") });
		fakeTool(
			repo,
			"biome",
			'if [ "$1" = "--version" ]; then echo "Version: 9.9.9"; exit 0; fi\necho "bad config" >&2\nexit 1',
		);
		const error = await runStaticTool(input("biome", head), context).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as CheckError).code).toBe("toolFailed");
		expect((error as CheckError).message).toMatch(/no report: bad config/);
	});
});

describe("runStaticTool and the user's worktrees", () => {
	it("leaves a stale worktree of the user's own registered", { timeout: 60_000 }, async () => {
		const head = commit(repo, { "src/a.ts": lines("export const a = 1;") });
		const mine = `${repo}-mine`;
		gitIn(repo, "worktree", "add", "--quiet", "--detach", mine);
		rmSync(mine, { recursive: true, force: true });
		await log("biome", head);
		expect(gitIn(repo, "worktree", "list", "--porcelain")).toContain(`worktree ${mine}`);
		gitIn(repo, "worktree", "remove", "--force", mine);
	});
});

describe("runStaticTool after a cancellation", () => {
	it("removes its worktree even though the caller's context is cancelled", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		fakeTool(repo, "tsc", 'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\nsleep 30');
		const controller = new AbortController();
		const cancellable = { abortSignal: controller.signal, value: () => undefined, toString: () => "cancellable" };
		setTimeout(() => controller.abort(), 2_000);
		await expect(runStaticTool(input("tsc", head), cancellable)).rejects.toMatchObject({
			name: "CheckError",
			code: "aborted",
		});
		expectCheckoutUntouched();
	});
});

describe("runStaticTool after a crash", () => {
	const crashScript = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "static-crash.ts");

	it("removes a worktree left by a run killed with SIGKILL before it adds its own", { timeout: 60_000 }, async () => {
		const head = commit(repo, { "src/a.ts": lines("export const a = 1;") });
		const events = join(repo, ".git", "crash.log");
		const child = spawn(process.execPath, ["--conditions=@melian-agent/source", crashScript, repo, head, events], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal ?? code)));
		const deadline = Date.now() + 15_000;
		try {
			while (!(existsSync(events) && readFileSync(events, "utf8").includes("parked\n"))) {
				if (child.exitCode !== null || child.signalCode !== null) throw new Error(`exited early:\n${stderr}`);
				if (Date.now() > deadline) throw new Error(`never parked:\n${stderr}`);
				await sleep(20);
			}
		} finally {
			child.kill("SIGKILL");
		}
		expect(await exited).toBe("SIGKILL");
		const stale = gitIn(repo, "worktree", "list", "--porcelain")
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length))
			.filter((path) => path !== repo);
		expect(stale).toHaveLength(1);
		expect(existsSync(stale[0]!)).toBe(true);

		await log("biome", head);
		expect(existsSync(stale[0]!)).toBe(false);
		expectCheckoutUntouched();
	});
});
