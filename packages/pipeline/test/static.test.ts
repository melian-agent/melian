import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Changeset, CheckError, defaultConfig, type ToolLog } from "@melian-agent/core";
import {
	backgroundContext as context,
	createNodeExecutionEnv,
	runStaticTool,
	type StaticRunInput,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sandbox } from "../src/sandbox.ts";
import { Run, staticToolSource } from "../src/static.ts";
import { fakeMutationProcesses } from "./fixtures/mutation-process.ts";
import { commit, createRepository, fakeTool, gitIn, lines, removeRepository, writeFiles } from "./fixtures/repo.ts";
import { hostSandbox, unconfinedNotes, unconfinedSandbox } from "./fixtures/sandbox.ts";
import { emptyVitestInstall } from "./fixtures/vitest-listing.ts";

let repo: string;

beforeEach(() => {
	fakeMutationProcesses();
	repo = createRepository();
});

afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

it("keeps Enola provisioning out of checkout binary discovery", () => {
	expect(staticToolSource(repo, "enola")).toEqual({ from: "missing" });
});

it("refuses to run in a scratch directory it cannot resolve, and removes it", { timeout: 60_000 }, async () => {
	const head = commit(repo, { "a.ts": "function a() {}\n" });
	const env = createNodeExecutionEnv(repo);
	const created = vi.spyOn(env, "createTempDir");
	vi.spyOn(env, "canonicalPath").mockResolvedValueOnce({
		ok: false,
		error: Object.assign(new Error("canonicalisation refused"), { code: "permission_denied" as const }),
	});
	const run = new Run({ ...input("biome", head), env }, context);
	const use = vi.fn(async () => "done");
	const directory = async () => ((await created.mock.results[0]!.value) as { value: string }).value;
	await expect(run.inWorktree(use)).rejects.toMatchObject({ code: "worktreeFailed" });
	await expect(run.inWorktree(use)).resolves.toBe("done");
	expect(use).toHaveBeenCalledOnce();
	expect(await directory()).toMatch(/melian-static-/);
	expect(existsSync(await directory())).toBe(false);
	expect(gitIn(repo, "worktree", "list", "--porcelain")).not.toContain("melian-static-");
});

it("reads nothing before a run has a scratch directory", async () => {
	const run = new Run(input("biome", "a".repeat(40)), context);
	await expect(run.readOutput(join(repo, "a.ts"))).rejects.toMatchObject({
		code: "worktreeFailed",
		message: expect.stringContaining("outside a run's scratch"),
	});
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
		trustedWriter: true,
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

	it("keeps the run's result and still removes scratch when a worktree removal times out", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, { "src/a.ts": "export const a = 1;\n" });
		// The host's own teardown, which a run takes where it was not confined.
		vi.spyOn(Sandbox, "detect").mockResolvedValue(undefined);
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
		const result = await runStaticTool({ ...input("biome", head), env }, context);
		expect(result.status).toBe("ran");
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
		expect(result.notes).toEqual([
			...unconfinedNotes("tsc"),
			"tsc checked a/tsconfig.json, b/tsconfig.json, which tsconfig.json references.",
		]);
		const nothing = commit(repo, { "tsconfig.json": JSON.stringify({ files: [] }) });
		await expect(runStaticTool(input("tsc", nothing), context)).rejects.toMatchObject({ code: "nothingToCheck" });
	});

	it("does not read a tsconfig.json the head committed as a link to a host file", { timeout: 60_000 }, async () => {
		const outside = join(dirname(repo), `melian-host-config-${process.pid}.json`);
		writeFileSync(outside, JSON.stringify({ files: [], references: [{ path: "./leak-marker" }] }));
		symlinkSync(outside, join(repo, "tsconfig.json"));
		const head = commit(repo, { ".gitignore": lines("node_modules"), "leak-marker/tsconfig.json": tsconfig });
		fakeTool(repo, "tsc", 'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi');
		try {
			const result = await runStaticTool(input("tsc", head), context);
			// Read through the link, the host would have checked the project that file names and said so in a note.
			expect(result).toMatchObject({ status: "ran", notes: unconfinedNotes("tsc") });
		} finally {
			rmSync(outside);
		}
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

	it("probes the sandbox once and runs the version probe and the tool inside it", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": "export const a = 1;\n" });
		writeFiles(repo, { "node_modules/x/index.js": "x\n" });
		const detect = vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
		const started = vi.spyOn(unconfinedSandbox, "runtimeFailure");
		const command = vi.spyOn(unconfinedSandbox, "command");
		vi.spyOn(unconfinedSandbox, "environment").mockReturnValue({ PATH: process.env.PATH!, MELIAN_SANDBOX: "test" });
		const env = createNodeExecutionEnv(repo);
		const execute = vi.spyOn(env, "exec");
		const result = await runStaticTool({ ...input("biome", head), env }, context);
		expect(result).toMatchObject({ status: "ran", notes: [], confinement: { confined: true } });
		expect(detect).toHaveBeenCalledOnce();
		const [, paths] = command.mock.calls[0]!;
		expect(started).toHaveBeenCalledExactlyOnceWith(paths, env, context);
		expect(detect).toHaveBeenCalledExactlyOnceWith(env, context);
		expect(paths.worktree).toBe(join(paths.scratch, "tree"));
		expect(paths.scratch).toMatch(/melian-static-/);
		// The checkout's install, then Melian's own, which holds the Biome that ran.
		expect(paths.installs).toEqual([
			join(repo, "node_modules"),
			realpathSync(fileURLToPath(new URL("../../../node_modules", import.meta.url))),
		]);
		expect(paths.loopback).toBeUndefined();
		expect(
			command.mock.calls.map(([inner, , file, profile]) => [/ --version$| lint /.exec(inner)?.[0], file, profile]),
		).toEqual([
			[" --version", "", undefined],
			[" lint ", "", undefined],
			[undefined, "", undefined],
			[undefined, "", undefined],
			[undefined, "", undefined],
		]);
		// The last two are the teardown: the tree removed, then scratch emptied, both from outside the worktree.
		expect(command.mock.calls.slice(3).map(([inner]) => /,"(remove|clean)",/.exec(inner)?.[1])).toEqual([
			"remove",
			"clean",
		]);
		// The third is the reader, fetching the report: it starts outside the worktree and is granted no install.
		expect(command.mock.calls[2]![1]).toMatchObject({ worktree: "/", scratch: paths.scratch, installs: [] });
		expect(command.mock.calls[2]![0]).toContain(JSON.stringify(join(paths.scratch, "biome.sarif")));
		// Only those commands carry the sandbox's variables and a scratch HOME and TMPDIR; git, ln, and rm do not.
		const confined = execute.mock.calls.filter(([, options]) => options?.env?.MELIAN_SANDBOX === "test");
		expect(confined.map(([text]) => text)).toEqual(command.mock.results.map((made) => made.value));
		for (const [, options] of confined)
			expect(options?.env).toMatchObject({ HOME: paths.scratch, TMPDIR: paths.scratch, PATH: process.env.PATH });
		for (const [text, options] of execute.mock.calls.filter(([text]) => /git -C|^sh |^cmp /.test(text))) {
			expect(text).not.toContain("--version");
			expect(options?.env?.HOME).toBe(process.env.HOME);
		}
	});

	it.each([
		["the host offers no sandbox", undefined, "this host offers no sandbox"],
		[
			"Node cannot start inside the sandbox",
			{ ...unconfinedSandbox, runtimeFailure: async () => "Node runtime /n could not start within seatbelt" },
			"Node runtime /n could not start within seatbelt",
		],
	] as const)(
		"runs the tool unconfined, and says so on the record, when %s",
		{ timeout: 60_000 },
		async (_name, sandbox, reason) => {
			const head = commit(repo, { "src/a.ts": lines("debugger;") });
			vi.spyOn(Sandbox, "detect").mockResolvedValue(sandbox as Sandbox | undefined);
			const command = vi.spyOn(unconfinedSandbox, "command");
			const env = createNodeExecutionEnv(repo);
			const execute = vi.spyOn(env, "exec");
			const result = await runStaticTool({ ...input("biome", head), env }, context);
			if (result.status !== "ran") throw new Error(result.reason);
			// The fallback reached the tool: the real Biome reported the finding, through a plain shell command.
			expect(results(result.log)).toEqual([["lint/suspicious/noDebugger", "src/a.ts", 1]]);
			expect(result.confinement).toEqual({ confined: false, reason });
			expect(result.notes).toEqual([`biome ran unconfined: ${reason}.`]);
			expect(command).not.toHaveBeenCalled();
			const lint = execute.mock.calls.find(([text]) => text.includes(" lint "))!;
			expect(lint[0]).toMatch(/^cd '/);
			expect(lint[1]?.env?.HOME).toBe(process.env.HOME);
			expect(lint[1]?.env).not.toHaveProperty("MELIAN_SANDBOX");
		},
	);

	it("runs the tool by its resolved path when the checkout is reached through a link", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": "export const a = 1;\n" });
		fakeTool(
			repo,
			"biome",
			[
				'if [ "$1" = "--version" ]; then echo 0.0.0; exit 0; fi',
				'for arg in "$@"; do case "$arg" in --reporter-file=*) out=$(printf %s "$arg" | cut -d= -f2-);; esac; done',
				`printf '%s' '${emptySarif}' > "$out"`,
			].join("\n"),
		);
		const linked = join(dirname(repo), `melian-linked-checkout-${process.pid}`);
		symlinkSync(repo, linked);
		const env = createNodeExecutionEnv(linked);
		const execute = vi.spyOn(env, "exec");
		try {
			// In the host's own sandbox where it has one: under bubblewrap the linked path is not there to run.
			const result = await runStaticTool({ ...input("biome", head), env, repoRoot: linked }, context);
			expect(result).toMatchObject({ status: "ran", notes: unconfinedNotes("biome") });
			const tool = execute.mock.calls
				.map(([text]) => text.replaceAll("'\\''", "'"))
				.filter((text) => /biome' (--version|lint )/.test(text));
			expect(tool).toHaveLength(2);
			for (const text of tool) {
				expect(text).toContain(`'${join(repo, "node_modules/.bin/biome")}'`);
				expect(text).not.toContain(linked);
			}
		} finally {
			rmSync(linked);
		}
	});

	it("grants no install of its own when the tool's path names no node_modules", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": "export const a = 1;\n" });
		fakeTool(
			repo,
			"biome",
			[
				'if [ "$1" = "--version" ]; then echo 0.0.0; exit 0; fi',
				'for arg in "$@"; do case "$arg" in --reporter-file=*) out=$(printf %s "$arg" | cut -d= -f2-);; esac; done',
				`printf '%s' '${emptySarif}' > "$out"`,
			].join("\n"),
		);
		vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
		const command = vi.spyOn(unconfinedSandbox, "command");
		const env = createNodeExecutionEnv(repo);
		const canonical = env.canonicalPath.bind(env);
		// The checkout's `.bin` entry is a link, as npm makes it, to a tool that lives wherever `to` says.
		const bin = join(repo, "node_modules/.bin/biome");
		const script = readFileSync(bin, "utf8");
		const elsewhere = join(dirname(repo), `melian-tools-${process.pid}`);
		const linkTo = (to: string) => {
			writeFiles(elsewhere, { [to]: script });
			chmodSync(join(elsewhere, to), 0o755);
			rmSync(bin);
			symlinkSync(join(elsewhere, to), bin);
		};
		try {
			linkTo("biome");
			expect((await runStaticTool({ ...input("biome", head), env }, context)).status).toBe("ran");
			expect(command.mock.calls[0]![0]).toBe(`'${join(elsewhere, "biome")}' --version`);
			expect(command.mock.calls[0]![1].installs).toEqual([join(repo, "node_modules")]);
			// A nested install is read from the outermost node_modules, where the packages hoisted beside it live.
			linkTo("a/node_modules/b/node_modules/biome/bin/biome");
			command.mockClear();
			expect((await runStaticTool({ ...input("biome", head), env }, context)).status).toBe("ran");
			expect(command.mock.calls[0]![1].installs).toEqual([
				join(repo, "node_modules"),
				join(elsewhere, "a/node_modules"),
			]);
			// A tool whose path cannot be resolved runs as named, and the checkout's install already covers that name.
			vi.spyOn(env, "canonicalPath").mockImplementation(async (path, at) =>
				path.endsWith("/.bin/biome")
					? { ok: false, error: Object.assign(new Error("unreadable"), { code: "permission_denied" as const }) }
					: canonical(path, at),
			);
			command.mockClear();
			expect((await runStaticTool({ ...input("biome", head), env }, context)).status).toBe("ran");
			expect(command.mock.calls[0]![0]).toBe(`'${bin}' --version`);
			expect(command.mock.calls[0]![1].installs).toEqual([join(repo, "node_modules")]);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("names a checkout lockfile mismatch after linking its installed dependencies", async () => {
		const head = commit(repo, {
			".gitignore": "node_modules\n",
			"package-lock.json": "old\n",
			"src/a.ts": "export const a = 1;\n",
		});
		writeFileSync(join(repo, "package-lock.json"), "new\n");
		fakeTool(
			repo,
			"biome",
			[
				'if [ "$1" = "--version" ]; then echo 0.0.0; exit 0; fi',
				'for arg in "$@"; do case "$arg" in --reporter-file=*) out=$(printf %s "$arg" | cut -d= -f2-);; esac; done',
				`printf '%s' '${emptySarif}' > "$out"`,
			].join("\n"),
		);
		const run = await runStaticTool(input("biome", head), context);
		expect(run).toMatchObject({
			status: "ran",
			notes: [
				`biome resolved dependencies from the checkout's install, whose package-lock.json differs from ${head.slice(0, 12)}'s.`,
				...unconfinedNotes("biome"),
			],
		});
	});

	it("links a workspace's own dependencies and grants exactly those install directories to mutation tests", async () => {
		writeFiles(repo, emptyVitestInstall);
		vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
		const command = vi.spyOn(unconfinedSandbox, "command");
		const probed = vi.spyOn(unconfinedSandbox, "runtimeFailure");
		const base = commit(repo, {
			".gitignore": "node_modules\n",
			"stryker.config.json": JSON.stringify({ testRunner: "vitest" }),
			"packages/b/package.json": JSON.stringify({ name: "b", main: "index.ts" }),
			"packages/b/index.ts": "export const b = 1;\n",
		});
		const head = commit(repo, { "src/a.ts": "export const a = 1;\n" });
		writeFiles(repo, { "packages/b/node_modules/nested/index.js": "nested-version\n" });
		mkdirSync(join(repo, "node_modules"), { recursive: true });
		symlinkSync("../packages/b", join(repo, "node_modules/b"));
		fakeTool(
			repo,
			"stryker",
			`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
[ "$(cat packages/b/node_modules/nested/index.js)" = "nested-version" ] || exit 1
mkdir -p reports/mutation
echo '{"files":{}}' > reports/mutation/mutation.json`,
		);
		const run = await runStaticTool(
			{ ...input("mutation", head), base, revision: (await Changeset.resolve(repo, `${base}..${head}`)).revision },
			context,
		);
		expect(run.status).toBe("ran");
		expect(command.mock.calls).toHaveLength(13);
		for (const [, paths] of command.mock.calls)
			expect(paths.installs).toEqual([join(repo, "node_modules"), join(repo, "packages/b/node_modules")]);
		// Loopback is for Stryker's logging server alone: the command that runs it, never the housekeeping around it.
		const loopback = command.mock.calls.filter(([, paths]) => paths.loopback !== undefined);
		expect(loopback.map(([inner, paths]) => [inner.includes("mutation-runner.mjs"), paths.loopback])).toEqual([
			[true, true],
		]);
		expect(probed.mock.calls.map(([paths]) => paths.loopback)).toEqual([true]);
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
			...unconfinedNotes("biome"),
		]);
		expectCheckoutUntouched();
	});

	it("runs the tool with PATH, HOME, TMPDIR, and LANG only, so no secret reaches it", {
		timeout: 60_000,
	}, async () => {
		vi.stubEnv("MELIAN_TEST_SECRET", "hunter2");
		vi.stubEnv("NODE_V8_COVERAGE", "");
		// The fake records what it saw beside the repository, so this run is the unconfined one.
		vi.spyOn(Sandbox, "detect").mockResolvedValue(undefined);
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

	it.skipIf(hostSandbox === undefined)(
		"gives a confined tool the sandbox's variables and a scratch HOME and TMPDIR, and still no secret",
		{ timeout: 60_000 },
		async () => {
			vi.stubEnv("MELIAN_TEST_SECRET", "hunter2");
			vi.stubEnv("NODE_V8_COVERAGE", "");
			const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
			// A confined tool can leave nothing behind, so it prints what it saw and fails, and the error carries it.
			fakeTool(
				repo,
				"tsc",
				'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\necho seen:\nenv\nexit 3',
			);
			const failure = await runStaticTool(input("tsc", head), context).catch((error: CheckError) => error);
			expect(failure).toMatchObject({ code: "toolFailed" });
			const seen = new Map(
				(failure as CheckError).message
					.split("\n")
					.filter((line) => /^[A-Z_]+=/.test(line))
					.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
			);
			expect(seen.has("MELIAN_TEST_SECRET")).toBe(false);
			expect(
				[...seen.keys()]
					.filter((name) => !["PATH", "HOME", "TMPDIR", "LANG", "PWD", "OLDPWD", "SHLVL", "_"].includes(name))
					.sort(),
			).toEqual(process.platform === "darwin" ? ["DEVELOPER_DIR", "MELIAN_SANDBOX"] : ["MELIAN_SANDBOX"]);
			expect(seen.get("HOME")).toMatch(/melian-static-[^/]+$/);
			expect(seen.get("TMPDIR")).toBe(seen.get("HOME"));
			expect(seen.get("HOME")).not.toBe(process.env.HOME);
			expect(seen.get("PATH")).not.toBe(process.env.PATH);
		},
	);

	it.skipIf(hostSandbox === undefined)(
		"confines the tool: it cannot read a home, write beside scratch, or reach a local port",
		{ timeout: 60_000 },
		async () => {
			const head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": "export const a = 1;\n" });
			const home = join(dirname(repo), `melian-fake-home-${process.pid}`);
			mkdirSync(home);
			writeFileSync(join(home, "auth.json"), "credential");
			const connections: string[] = [];
			const server = createServer((socket) => {
				connections.push("connected");
				socket.end();
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const { port } = server.address() as AddressInfo;
			const attempts = [
				`cat '${home}/auth.json' > /dev/null 2>&1 && echo read-home=reached || echo read-home=refused`,
				`(echo 1 > '${home}/written') 2> /dev/null && echo write-outside=reached || echo write-outside=refused`,
				`(echo 1 > "$HOME/written") 2> /dev/null && echo write-scratch=reached || echo write-scratch=refused`,
				`node -e 'const s=require("node:net").connect(${port},"127.0.0.1");s.on("connect",()=>{console.log("socket=reached");s.destroy()});s.on("error",()=>console.log("socket=refused"))'`,
			];
			fakeTool(
				repo,
				"biome",
				[
					'if [ "$1" = "--version" ]; then echo 0.0.0; exit 0; fi',
					"exec 1>&2",
					"echo attempts:",
					...attempts,
					"exit 3",
				].join("\n"),
			);
			try {
				// Outside the sandbox the same script reaches all four, so a refusal below is the sandbox's doing.
				const outside = spawnSync(join(repo, "node_modules/.bin/biome"), ["lint"], {
					encoding: "utf8",
					env: { ...process.env, HOME: repo },
				});
				expect(outside.stderr.trim().split("\n").slice(1)).toEqual([
					"read-home=reached",
					"write-outside=reached",
					"write-scratch=reached",
					"socket=reached",
				]);
				rmSync(join(home, "written"));
				// The control run blocked this process, so its connection is accepted only now.
				while (connections.length === 0) await sleep(10);
				connections.length = 0;
				const failure = await runStaticTool(input("biome", head), context).catch((error: CheckError) => error);
				expect(failure).toMatchObject({ code: "toolFailed" });
				expect((failure as CheckError).message.split("\n").filter((line) => /^[a-z-]+=/.test(line))).toEqual([
					"read-home=refused",
					"write-outside=refused",
					"write-scratch=reached",
					"socket=refused",
				]);
				expect(existsSync(join(home, "written"))).toBe(false);
				expect(connections).toEqual([]);
			} finally {
				server.close();
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

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
			...unconfinedNotes("tsc"),
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

	it.each([
		["the host's", undefined, "worktree remove --force --force"],
		["the confined", unconfinedSandbox, ',"remove",'],
	] as const)(
		"reports the tool's own error when %s cleanup also fails",
		{ timeout: 60_000 },
		async (_name, sandbox, step) => {
			const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
			fakeTool(
				repo,
				"tsc",
				'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\necho "out of memory"\nexit 134',
			);
			vi.spyOn(Sandbox, "detect").mockResolvedValue(sandbox);
			const env = createNodeExecutionEnv(repo);
			const created = vi.spyOn(env, "createTempDir");
			const execute = env.exec.bind(env);
			const failed: string[] = [];
			vi.spyOn(env, "exec").mockImplementation(async (command, options, executionContext) => {
				if (command.includes(step)) {
					failed.push(command);
					return { ok: false, error: { name: "ExecutionError", code: "timeout", message: "cleanup timed out" } };
				}
				return execute(command, options, executionContext);
			});
			const error = await runStaticTool({ ...input("tsc", head), env }, context).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(failed.length).toBeGreaterThan(0);
			expect((error as CheckError).code).toBe("toolFailed");
			expect((error as CheckError).message).toContain("out of memory");
			rmSync(((await created.mock.results[0]!.value) as { value: string }).value, { recursive: true, force: true });
		},
	);

	it("fails a run whose confined teardown cannot finish, and keeps its registration for the next run", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, { "src/a.ts": "export const a = 1;\n" });
		vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
		const env = createNodeExecutionEnv(repo);
		const created = vi.spyOn(env, "createTempDir");
		const execute = env.exec.bind(env);
		vi.spyOn(env, "exec").mockImplementation(async (command, options, executionContext) =>
			command.includes(',"clean",')
				? { ok: false, error: { name: "ExecutionError", code: "timeout", message: "cleanup timed out" } }
				: execute(command, options, executionContext),
		);
		await expect(runStaticTool({ ...input("biome", head), env }, context)).rejects.toMatchObject({
			code: "toolFailed",
			message: expect.stringContaining("scratch operation refused"),
		});
		const scratch = ((await created.mock.results[0]!.value) as { value: string }).value;
		expect(gitIn(repo, "worktree", "list", "--porcelain")).toContain(`${realpathSync(scratch)}/tree`);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("tears a confined run down confined: host git removes no tree and the host deletes only the registration", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, { "src/a.ts": "export const a = 1;\n" });
		vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
		const env = createNodeExecutionEnv(repo);
		const execute = vi.spyOn(env, "exec");
		const remove = vi.spyOn(env, "remove");
		const created = vi.spyOn(env, "createTempDir");
		expect((await runStaticTool({ ...input("biome", head), env }, context)).status).toBe("ran");
		const scratch = ((await created.mock.results[0]!.value) as { value: string }).value;
		expect(execute.mock.calls.filter(([command]) => /worktree (remove|prune|unlock)/.test(command))).toEqual([]);
		expect(remove.mock.calls.map(([path]) => path)).toEqual([expect.stringMatching(/\/\.git\/worktrees\/tree\d*$/)]);
		expect(gitIn(repo, "worktree", "list", "--porcelain")).not.toContain("melian-static-");
		expect(existsSync(scratch)).toBe(false);
	});

	it("refuses a report that is a symlink, with the reason and none of its target", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": lines("a") });
		const big = join(repo, ".git", "big.sarif");
		writeFileSync(big, `{"marker":"credential-marker"}`);
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
		expect((error as CheckError).code).toBe("toolFailed");
		expect((error as CheckError).message).toMatch(/scratch operation refused .*\/biome\.sarif: .*non-file /);
		expect((error as CheckError).message).not.toContain("credential-marker");
	});

	it("fails with outputTooLarge at the limit, and reads a report one byte under it", {
		timeout: 120_000,
	}, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": lines("a") });
		const report = (bytes: number) =>
			fakeTool(
				repo,
				"biome",
				[
					'if [ "$1" = "--version" ]; then echo "Version: 9.9.9"; exit 0; fi',
					'for arg in "$@"; do case "$arg" in --reporter-file=*) out=$(printf %s "$arg" | cut -d= -f2-);; esac; done',
					`printf '%s' '${emptySarif}' > "$out"`,
					`printf '%${bytes - emptySarif.length}s' '' >> "$out"`,
					`[ "$(wc -c < "$out")" -eq ${bytes} ] || exit 9`,
				].join("\n"),
			);
		report(16 * 1024 * 1024 - 1);
		expect((await runStaticTool(input("biome", head), context)).status).toBe("ran");
		report(16 * 1024 * 1024);
		await expect(runStaticTool(input("biome", head), context)).rejects.toMatchObject({ code: "outputTooLarge" });
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

describe("runStaticTool and a stale worktree that cannot be removed", () => {
	it("still runs", { timeout: 60_000 }, async () => {
		const head = commit(repo, { "src/a.ts": lines("export const a = 1;") });
		const owner = join(dirname(repo), `melian-static-stale-${process.pid}`);
		mkdirSync(owner);
		gitIn(
			repo,
			"worktree",
			"add",
			"--quiet",
			"--detach",
			"--lock",
			"--reason",
			"melian-static pid 2147483646",
			join(owner, "tree"),
		);
		const env = createNodeExecutionEnv(repo);
		const execute = env.exec.bind(env);
		const attempted: string[] = [];
		vi.spyOn(env, "exec").mockImplementation(async (command, options, executionContext) => {
			if (command.includes("worktree remove --force --force") && command.includes(owner)) {
				attempted.push(command);
				return { ok: false, error: { name: "ExecutionError", code: "timeout", message: "cleanup timed out" } };
			}
			return execute(command, options, executionContext);
		});
		try {
			const result = await runStaticTool({ ...input("biome", head), env }, context);
			expect(result.status).toBe("ran");
			expect(attempted.length).toBeGreaterThan(0);
		} finally {
			vi.restoreAllMocks();
			gitIn(repo, "worktree", "remove", "--force", "--force", join(owner, "tree"));
			rmSync(owner, { recursive: true, force: true });
		}
	});
});

describe("runStaticTool and a worktree locked by pid 0", () => {
	it("treats the lock as dead rather than probing a process group", { timeout: 60_000 }, async () => {
		const head = commit(repo, { "src/a.ts": lines("export const a = 1;") });
		const owner = join(dirname(repo), `melian-static-lowpid-${process.pid}`);
		mkdirSync(owner);
		gitIn(
			repo,
			"worktree",
			"add",
			"--quiet",
			"--detach",
			"--lock",
			"--reason",
			"melian-static pid 0",
			join(owner, "tree"),
		);
		try {
			await log("biome", head);
			expect(gitIn(repo, "worktree", "list", "--porcelain")).not.toContain(join(owner, "tree"));
		} finally {
			rmSync(owner, { recursive: true, force: true });
			gitIn(repo, "worktree", "prune");
		}
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

// Seatbelt has no hold on a process once its command has exited, so a tool can leave one behind. bubblewrap ends every
// process in the namespace with the command, and a pid from inside it means nothing on the host, so this is macOS only.
describe.skipIf(hostSandbox?.backend !== "seatbelt")("a process a confined tool leaves behind", () => {
	it("cannot change what the host read, nor write outside scratch once teardown has removed it", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig, "src/a.ts": "a\n" });
		const outside = join(dirname(repo), `melian-survivor-${process.pid}`);
		mkdirSync(outside);
		// The child waits for the host to have read the output, rewrites it, says so, then tries to get out until it is
		// stopped or twenty seconds pass.
		const child = `
const fs = require("node:fs");
const [out, outside] = process.argv.slice(1);
const scratch = require("node:path").dirname(out);
const started = Date.now();
let tampered = false;
setInterval(() => {
  if (Date.now() - started > 20000) process.exit(0);
  if (!tampered && fs.existsSync(scratch + "/go")) {
    fs.writeFileSync(out, "src/a.ts(1,1): error TS1: altered after the read\\n");
    fs.writeFileSync(scratch + "/tampered", "");
    tampered = true;
  }
  try { fs.writeFileSync(outside + "/escaped", "survivor"); } catch {}
}, 10);`;
		fakeTool(
			repo,
			"tsc",
			[
				'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi',
				`node -e '${child}' "$(dirname "$PWD")/tsc-0.out" '${outside}' > /dev/null 2>&1 &`,
				'echo "src/a.ts(1,1): error TS9000: child $!"',
				"exit 1",
			].join("\n"),
		);
		const env = createNodeExecutionEnv(repo);
		const execute = env.exec.bind(env);
		const created = vi.spyOn(env, "createTempDir");
		let reads = 0;
		// Once the host has read the output, and only then, let the child rewrite it, and wait until it has.
		vi.spyOn(env, "exec").mockImplementation(async (command, options, at) => {
			const result = await execute(command, options, at);
			if (command.includes("tsc-0.out") && command.includes(',"read",')) {
				reads++;
				const scratch = ((await created.mock.results[0]!.value) as { value: string }).value;
				writeFileSync(join(realpathSync(scratch), "go"), "");
				while (!existsSync(join(realpathSync(scratch), "tampered"))) await sleep(10);
			}
			return result;
		});
		let pid = 0;
		try {
			const result = await runStaticTool({ ...input("tsc", head), env }, context);
			if (result.status !== "ran") throw new Error(result.reason);
			const messages = result.log.runs[0].results.map((each) => each.message.text);
			pid = Number(/^child (\d+)$/.exec(messages[0] ?? "")?.[1]);
			expect(messages).toEqual([`child ${pid}`]);
			expect(reads).toBe(1);
			expect(Number.isInteger(pid) && pid > 1).toBe(true);
			// The child is still running, still inside the sandbox, with scratch gone from under it.
			expect(() => process.kill(pid, 0)).not.toThrow();
			const scratch = ((await created.mock.results[0]!.value) as { value: string }).value;
			expect(existsSync(scratch)).toBe(false);
			expect(gitIn(repo, "worktree", "list", "--porcelain")).not.toContain("melian-static-");
			await sleep(300);
			expect(existsSync(join(outside, "escaped"))).toBe(false);
			expect(existsSync(scratch)).toBe(false);
		} finally {
			// Only the child this test's own fake started, by the pid that fake reported.
			if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
it.each([undefined, false])(
	"the exported mutation runner refuses trustedWriter=%s before creating a worktree",
	async (trustedWriter) => {
		const env = createNodeExecutionEnv(repo);
		const execute = vi.spyOn(env, "exec");
		const sandbox = vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
		const result = await runStaticTool({ ...input("mutation", "a".repeat(40)), env, trustedWriter }, context);
		expect(result).toMatchObject({ status: "skipped", cause: "untrustedWriter" });
		expect(execute).not.toHaveBeenCalled();
		expect(sandbox).not.toHaveBeenCalled();
	},
);
