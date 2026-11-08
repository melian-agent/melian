import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { Run, staticToolSource } from "../src/static.ts";
import { fakeMutationProcesses } from "./fixtures/mutation-process.ts";
import { commit, createRepository, fakeTool, gitIn, lines, removeRepository, writeFiles } from "./fixtures/repo.ts";
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

it("uses the created scratch path when canonicalisation fails", { timeout: 60_000 }, async () => {
	const head = commit(repo, { "a.ts": "function a() {}\n" });
	const env = createNodeExecutionEnv(repo);
	vi.spyOn(env, "canonicalPath").mockResolvedValueOnce({
		ok: false,
		error: Object.assign(new Error("canonicalisation refused"), { code: "permission_denied" as const }),
	});
	const run = new Run({ ...input("biome", head), env }, context);
	await expect(
		run.inWorktree(async (root, scratch) => {
			expect(root).toBe(join(scratch, "tree"));
			expect(existsSync(root)).toBe(true);
			return "done";
		}),
	).resolves.toBe("done");
});

const tsconfig = JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext" },
});

// A fake tsc answers Melian's question about the project's effective files before its own run.
const answerShowConfig = `if [ "$1" = "--showConfig" ]; then echo '{"files":["./a.ts"]}'; exit 0; fi`;

function input(tool: StaticRunInput["tool"], commitId: string, timeout = 120): StaticRunInput {
	return {
		env: createNodeExecutionEnv(repo),
		repoRoot: repo,
		commit: commitId,
		tool,
		headCode: "writer",
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
		const env = createNodeExecutionEnv(repo);
		const execute = env.exec.bind(env);
		const cleanup: string[] = [];
		vi.spyOn(env, "exec").mockImplementation(async (command, options, executionContext) => {
			if (typeof command === "string" && command.includes("worktree remove --force --force")) {
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
		expect(result.notes).toEqual(["tsc checked a/tsconfig.json, b/tsconfig.json, which tsconfig.json references."]);
		// tsc reports an empty files list as an error of the project itself, so that error is the finding.
		const empty = commit(repo, { "tsconfig.json": JSON.stringify({ files: [] }) });
		const emptied = await runStaticTool(input("tsc", empty), context);
		if (emptied.status !== "ran") throw new Error(emptied.reason);
		expect(results(emptied.log)).toEqual([["TS18002", "tsconfig.json", 1]]);
	});

	it("follows a tsconfig that links to a solution inside the checkout to the projects it references", {
		timeout: 60_000,
	}, async () => {
		writeFiles(repo, {
			"solution.json": JSON.stringify({ files: [], references: [{ path: "./a" }] }),
			"a/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, composite: true } }),
			"a/index.ts": lines("export const n: number = 'a';"),
		});
		symlinkSync("solution.json", join(repo, "tsconfig.json"));
		const head = commit(repo, {});
		const result = await runStaticTool(input("tsc", head), context);
		if (result.status !== "ran") throw new Error(result.reason);
		expect(results(result.log)).toEqual([["TS2322", "a/index.ts", 1]]);
		expect(result.notes).toEqual(["tsc checked a/tsconfig.json, which tsconfig.json references."]);
	});

	it("refuses a project file linked outside the checkout without reading it", { timeout: 60_000 }, async () => {
		const outside = join(repo, ".git", "outside.json");
		writeFileSync(outside, JSON.stringify({ files: [], references: [{ path: "ghp_FAKEoutsideTOKEN281" }] }));
		symlinkSync(outside, join(repo, "tsconfig.json"));
		const head = commit(repo, { "a.ts": lines("export const a = 1;") });
		await expect(runStaticTool(input("tsc", head), context)).rejects.toMatchObject({
			code: "toolFailed",
			message: "tsconfig.json links outside the checkout, so Melian ran no tsc on it",
		});
	});

	it("follows a reference to a linked solution inside the checkout", { timeout: 60_000 }, async () => {
		writeFiles(repo, {
			"tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./linked.json" }] }),
			"solution.json": JSON.stringify({ files: [], references: [{ path: "./a" }] }),
			"a/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, composite: true } }),
			"a/index.ts": lines("export const n: number = 'a';"),
		});
		symlinkSync("solution.json", join(repo, "linked.json"));
		const head = commit(repo, {});
		const result = await runStaticTool(input("tsc", head), context);
		if (result.status !== "ran") throw new Error(result.reason);
		expect(results(result.log)).toEqual([["TS2322", "a/index.ts", 1]]);
	});

	// tsc inherits no `references` through `extends`, so tsc -p and tsc -b check nothing here, and neither does Melian.
	it("refuses a tsconfig whose only references come from its base, as tsc checks nothing there", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, {
			"base.json": JSON.stringify({ files: [], references: [{ path: "./a" }] }),
			"tsconfig.json": JSON.stringify({ extends: "./base.json" }),
			"a/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, composite: true } }),
			"a/index.ts": lines("export const n: number = 'a';"),
		});
		await expect(runStaticTool(input("tsc", head), context)).rejects.toMatchObject({ code: "nothingToCheck" });
	});

	it("checks a project whose include comes from the base it extends", { timeout: 60_000 }, async () => {
		const head = commit(repo, {
			"base.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*.ts"] }),
			"tsconfig.json": JSON.stringify({ extends: "./base.json", files: [] }),
			"src/a.ts": lines("export const n: number = 'a';"),
		});
		const result = await runStaticTool(input("tsc", head), context);
		if (result.status !== "ran") throw new Error(result.reason);
		expect(results(result.log)).toEqual([["TS2322", "src/a.ts", 1]]);
		expect(result.notes).toEqual([]);
	});

	it("checks each project of a solution whose projects take their include from a shared base", {
		timeout: 60_000,
	}, async () => {
		const project = JSON.stringify({ extends: "../base.json", files: [] });
		const head = commit(repo, {
			"base.json": JSON.stringify({
				compilerOptions: { strict: true, noEmit: true, composite: true },
				// biome-ignore lint/suspicious/noTemplateCurlyInString: tsc substitutes its own ${configDir} placeholder.
				include: ["${configDir}/**/*.ts"],
			}),
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
	});

	it("refuses a project whose effective files lie outside the checkout, by extends or by a link", {
		timeout: 60_000,
	}, async () => {
		const outside = join(repo, ".git", "outside");
		writeFiles(outside, {
			"base.json": JSON.stringify({ include: ["src/**/*.ts"] }),
			"src/ghp_FAKEoutsideTOKEN312.ts": lines("export const n: number = 'a';"),
		});
		const refused = {
			code: "toolFailed",
			message: "tsconfig.json resolves a file outside the checkout, so Melian ran no tsc on it",
		};
		const extended = commit(repo, {
			"tsconfig.json": JSON.stringify({ extends: join(outside, "base.json"), files: [] }),
		});
		await expect(runStaticTool(input("tsc", extended), context)).rejects.toMatchObject(refused);
		symlinkSync(join(outside, "src"), join(repo, "linked"));
		const linked = commit(repo, { "tsconfig.json": JSON.stringify({ include: ["linked/**/*.ts"] }) });
		await expect(runStaticTool(input("tsc", linked), context)).rejects.toMatchObject(refused);
	});

	it("fails the check when tsc cannot resolve a referenced project's configuration", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, {
			"tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./missing.json" }] }),
		});
		await expect(runStaticTool(input("tsc", head), context)).rejects.toMatchObject({
			code: "toolFailed",
			message: expect.stringMatching(
				/^tsc --showConfig exited with code 1 on missing\.json; run tsc --showConfig -p missing\.json at [0-9a-f]{12} to see why, since Melian keeps none of its output$/,
			),
		});
	});

	it("checks a referenced project in a folder whose name starts with two dots, and refuses one above the checkout", {
		timeout: 60_000,
	}, async () => {
		const project = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, composite: true } });
		const head = commit(repo, {
			"tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./..config" }] }),
			"..config/tsconfig.json": project,
			"..config/index.ts": lines("export const n: number = 'a';"),
		});
		const result = await runStaticTool(input("tsc", head), context);
		if (result.status !== "ran") throw new Error(result.reason);
		expect(results(result.log)).toEqual([["TS2322", "..config/index.ts", 1]]);
		for (const path of ["../outside", ".."]) {
			const above = commit(repo, { "tsconfig.json": JSON.stringify({ files: [], references: [{ path }] }) });
			await expect(runStaticTool(input("tsc", above), context)).rejects.toMatchObject({ code: "nothingToCheck" });
		}
	});

	it("refuses a configured project above the checkout, and checks one in a folder that starts with two dots", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, {
			"..config/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
			"..config/index.ts": lines("export const n: number = 'a';"),
		});
		const at = (project: string): StaticRunInput => ({
			...input("tsc", head),
			settings: { ...defaultConfig.static.tsc, timeout: 120, project },
		});
		for (const project of ["/etc/tsconfig.json", "../tsconfig.json", ".."]) {
			await expect(runStaticTool(at(project), context)).rejects.toMatchObject({
				code: "toolFailed",
				message: `static.tsc.project ${project} is outside the repository`,
			});
		}
		const result = await runStaticTool(at("..config/tsconfig.json"), context);
		if (result.status !== "ran") throw new Error(result.reason);
		expect(results(result.log)).toEqual([["TS2322", "..config/index.ts", 1]]);
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
			],
		});
	});

	it("links a workspace's own dependencies where the mutation run's tests find them", async () => {
		writeFiles(repo, emptyVitestInstall);
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
		// The fake exits 1 unless it reads the nested package through the worktree's own link.
		expect(run.status).toBe("ran");
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
		vi.stubEnv("NODE_V8_COVERAGE", "");
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		const seen = join(repo, ".git", "tool-env.txt");
		fakeTool(
			repo,
			"tsc",
			`if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\n${answerShowConfig}\nenv > '${seen}'`,
		);
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
		fakeTool(
			repo,
			"tsc",
			`if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\n${answerShowConfig}\nsleep 30`,
		);
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
				`if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\n${answerShowConfig}`,
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

	it("fails with toolFailed when the tool crashes, keeping its exit code and none of what it printed", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		fakeTool(
			repo,
			"tsc",
			`if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\n${answerShowConfig}\necho "out of memory"\nexit 134`,
		);
		const error = await runStaticTool(input("tsc", head), context).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as CheckError).code).toBe("toolFailed");
		expect((error as CheckError).message).toBe(
			`tsc exited with code 134 on tsconfig.json; run tsc --noEmit -p tsconfig.json at ${head.slice(0, 12)} to see why, since Melian keeps none of its output`,
		);
		expectCheckoutUntouched();
	});

	it("fails when tsc replaces its output with a FIFO, rather than reading no output as clean", {
		timeout: 60_000,
	}, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		fakeTool(
			repo,
			"tsc",
			`if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\n${answerShowConfig}\nrm -f ../tsc-0.out\nmkfifo ../tsc-0.out`,
		);
		const error = await runStaticTool(input("tsc", head), context).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as CheckError).code).toBe("toolFailed");
		expectCheckoutUntouched();
	});

	it("reports the tool's own error when worktree cleanup also fails", { timeout: 60_000 }, async () => {
		const head = commit(repo, { ".gitignore": lines("node_modules"), "tsconfig.json": tsconfig });
		fakeTool(
			repo,
			"tsc",
			`if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\n${answerShowConfig}\necho "out of memory"\nexit 134`,
		);
		const env = createNodeExecutionEnv(repo);
		const execute = env.exec.bind(env);
		vi.spyOn(env, "exec").mockImplementation(async (command, options, executionContext) => {
			if (typeof command === "string" && command.includes("worktree remove --force --force")) {
				return { ok: false, error: { name: "ExecutionError", code: "timeout", message: "cleanup timed out" } };
			}
			return execute(command, options, executionContext);
		});
		const error = await runStaticTool({ ...input("tsc", head), env }, context).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as CheckError).code).toBe("toolFailed");
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
		// Biome quotes a file it cannot parse under the name of the file that extended it (issue #281).
		expect((error as CheckError).message).not.toContain("bad config");
		expect((error as CheckError).message).toBe(
			`biome exited with code 1 and no report; run biome lint at ${head.slice(0, 12)} to see why, since Melian keeps none of its stderr`,
		);
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
			if (
				typeof command === "string" &&
				command.includes("worktree remove --force --force") &&
				command.includes(owner)
			) {
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
		fakeTool(
			repo,
			"tsc",
			`if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\n${answerShowConfig}\nsleep 30`,
		);
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

it("the exported mutation runner refuses a head the caller gave no leave for, before creating a worktree", async () => {
	const env = createNodeExecutionEnv(repo);
	const execute = vi.spyOn(env, "exec");
	const { headCode: _leave, ...refusedInput } = input("mutation", "a".repeat(40));
	const result = await runStaticTool({ ...refusedInput, env }, context);
	expect(result).toMatchObject({ status: "skipped", cause: "headNotAllowed" });
	expect(execute).not.toHaveBeenCalled();
});
