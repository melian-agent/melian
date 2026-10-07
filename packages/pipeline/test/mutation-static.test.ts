import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Changeset,
	CheckError,
	defaultConfig,
	type Finding,
	loadConfig,
	type RepositorySource,
	staticFindings,
	type ToolLog,
} from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	type Harness,
	openHarness,
	readFindings,
	revisionKey,
	runChecks,
	runStaticTool,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strykerNotInstalled, strykerVersion } from "../src/mutation-static.ts";
import { staticToolSource } from "../src/static.ts";
import {
	commit as commitTo,
	createRepository,
	fakeTool,
	gitIn,
	lines,
	removeRepository,
	writeFiles,
} from "./fixtures/repo.ts";

// The checkout's node_modules is never tracked, as in a real repository: a tracked one is ignored by the check.
function commit(root: string, files: Record<string, string>): string {
	return commitTo(root, { ".gitignore": "node_modules\n", ...files });
}

let repo: string;
let artifacts: string;
let opened: Harness[];

beforeEach(() => {
	repo = createRepository();
	artifacts = realpathSync(mkdtempSync(join(tmpdir(), "melian-mutation-")));
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	removeRepository(repo);
	rmSync(artifacts, { recursive: true, force: true });
});

interface Mutant {
	status: string;
	line: number;
	endLine?: number;
	mutatorName?: string;
	replacement?: string;
}

function report(files: Record<string, Mutant[]>): string {
	return JSON.stringify({
		schemaVersion: "1.0",
		files: Object.fromEntries(
			Object.entries(files).map(([path, mutants]) => [
				path,
				{
					language: "typescript",
					source: "",
					mutants: mutants.map((mutant, index) => ({
						id: String(index),
						mutatorName: mutant.mutatorName ?? "ConditionalExpression",
						replacement: mutant.replacement ?? "true",
						status: mutant.status,
						location: {
							start: { line: mutant.line, column: 3 },
							end: { line: mutant.endLine ?? mutant.line, column: 9 },
						},
					})),
				},
			]),
		),
	});
}

// A fake `stryker` as the checkout's installed binary. It records each call's arguments and its working directory, and
// writes the canned report where Stryker's JSON reporter does.
function stryker(options: { report?: string; exit?: number; version?: string } = {}): { calls: () => string[][] } {
	const canned = join(artifacts, "report.json");
	const record = join(artifacts, "calls.txt");
	if (options.report !== undefined) writeFileSync(canned, options.report);
	fakeTool(
		repo,
		"stryker",
		`if [ "$1" = "--version" ]; then echo ${options.version ?? "10.0.0"}; exit 0; fi
printf 'CALL\\n%s\\n' "$(pwd)" >> '${record}'
printf '%s\\n' "$@" >> '${record}'
[ ! -e reports/mutation/mutation.json ] || echo PLANTED >> '${record}'
if [ -f '${canned}' ]; then mkdir -p reports/mutation; cp '${canned}' reports/mutation/mutation.json; fi
echo "stryker said something" >&2
exit ${options.exit ?? 0}`,
	);
	return {
		calls: () =>
			existsSync(record)
				? readFileSync(record, "utf8")
						.split("CALL\n")
						.slice(1)
						.map((call) => call.trimEnd().split("\n"))
				: [],
	};
}

const config = JSON.stringify({ testRunner: "vitest" });
const a = lines("export function a(x: number) {", "  if (x > 0) return 1;", "  return 0;", "}");

// The arguments of one call to the fake: its working directory and the value that follows each flag.
function argumentsOf(call: string[]) {
	const flag = (name: string) => call[call.indexOf(name) + 1];
	return { cwd: call[0]!, run: call.slice(1), flag };
}

async function revisionOf(base: string, head: string) {
	return (await Changeset.resolve(repo, `${base}..${head}`)).revision;
}

async function mutate(base: string, head: string, extra: { maxLines?: number; revision?: boolean } = {}) {
	const revision = await revisionOf(base, head);
	return runStaticTool(
		{
			env: createNodeExecutionEnv(repo),
			repoRoot: repo,
			base,
			commit: head,
			tool: "mutation",
			settings: {
				...defaultConfig.static.mutation,
				timeout: 120,
				...(extra.maxLines === undefined ? {} : { maxLines: extra.maxLines }),
			},
			...(extra.revision === false ? {} : { revision }),
		},
		context,
	);
}

async function found(base: string, head: string): Promise<readonly Finding[]> {
	const revision = await revisionOf(base, head);
	const result = await mutate(base, head);
	if (result.status !== "ran") throw new Error(`skipped: ${result.reason}`);
	const empty: ToolLog = { ...result.log, runs: [{ ...result.log.runs[0], results: [] }] };
	return (
		await staticFindings({
			repoRoot: repo,
			revision,
			tool: "mutation",
			settings: defaultConfig.static.mutation,
			base: result.baseLog ?? empty,
			head: result.log,
		})
	).findings;
}

function twoCommits(headFiles: Record<string, string> = { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") }) {
	const base = commit(repo, {
		"stryker.config.json": config,
		"packages/p/src/a.ts": a,
		"packages/p/test/a.test.ts": lines("// tests a"),
	});
	return { base, head: commit(repo, headFiles) };
}

describe("static.mutation", { timeout: 60_000 }, () => {
	it("makes a survived mutant on a changed line a P2 untested-behaviour finding that names the mutator and the mutated text", async () => {
		const { base, head } = twoCommits();
		stryker({
			report: report({
				"packages/p/src/a.ts": [
					{ status: "Survived", line: 2, mutatorName: "EqualityOperator", replacement: "x > 0" },
				],
			}),
		});
		const findings = await found(base, head);
		expect(findings).toHaveLength(1);
		const [finding] = findings;
		expect(finding!.ruleId).toBe("mutation/untested-behaviour");
		expect(finding!.properties).toMatchObject({
			path: "packages/p/src/a.ts",
			severity: "P2",
			cause: "introduced",
			source: { check: "static.mutation", version: "10.0.0" },
			explanation: {
				what: "EqualityOperator mutant survived: with this code changed to `x > 0`, every test still passed.",
				whatToDo: expect.stringContaining("Add or tighten a test in packages/p/test/a.test.ts so it fails"),
			},
		});
		expect(finding!.locations[0]!.physicalLocation.region.startLine).toBe(2);
	});

	it("reports no finding for a survivor outside the changed lines or in a file the change left alone", async () => {
		const { base, head } = twoCommits();
		stryker({
			report: report({
				"packages/p/src/a.ts": [
					{ status: "Survived", line: 1 },
					{ status: "Survived", line: 3 },
				],
				"packages/p/src/untouched.ts": [{ status: "Survived", line: 2 }],
			}),
		});
		expect(await found(base, head)).toEqual([]);
	});

	it("makes a NoCoverage mutant on a changed line a finding", async () => {
		const { base, head } = twoCommits();
		stryker({ report: report({ "packages/p/src/a.ts": [{ status: "NoCoverage", line: 2 }] }) });
		const findings = await found(base, head);
		expect(findings.map((finding) => finding.properties.explanation.whyHere)).toEqual([
			"No test runs this changed line, so no test fails when this behaviour changes.",
		]);
	});

	it("records a Timeout mutant as a note, not a finding", async () => {
		const { base, head } = twoCommits();
		stryker({ report: report({ "packages/p/src/a.ts": [{ status: "Timeout", line: 2 }] }) });
		const result = await mutate(base, head);
		if (result.status !== "ran") throw new Error("skipped");
		expect(result.log.runs[0].results).toEqual([]);
		expect(result.notes).toContain(
			"1 Timeout mutant(s) on changed lines were set aside: a hang or a crash is not a survivor, so no finding is raised for it.",
		);
	});

	it("runs Stryker once, in the head's worktree, with the changed lines, a JSON report, and the incremental file in scratch", async () => {
		const { base, head } = twoCommits();
		const fake = stryker({ report: report({}) });
		const result = await mutate(base, head);
		if (result.status !== "ran") throw new Error("skipped");
		const calls = fake.calls();
		expect(calls).toHaveLength(1);
		const { cwd, run, flag } = argumentsOf(calls[0]!);
		expect(cwd).toMatch(/\/melian-static-[^/]+\/tree$/);
		expect(run.slice(0, 2)).toEqual(["run", `${cwd}/stryker.config.json`]);
		expect(flag("--reporters")).toBe("json");
		expect(run).toContain("--incremental");
		expect(run).toContain("--inPlace");
		expect(flag("--mutate")).toBe("packages/p/src/a.ts:2-2");
		expect(flag("--incrementalFile")).toBe(`${cwd.replace(/\/tree$/, "")}/incremental.json`);
		expect(result.log.runs[0].tool.driver).toEqual({ name: "Stryker", version: "10.0.0" });
		expect(result.baseLog?.runs[0].results).toEqual([]);
		expect(result.notes).toContain("Stryker mutated 1 changed lines in 1 file(s); the base was not mutated.");
		expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		expect(gitIn(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
	});

	describe("the lines it mutates", () => {
		function entries(call: string[]): string[] {
			return argumentsOf(call).flag("--mutate")!.split(",");
		}

		it("mutates an added block, a modified line, and nothing for a deletion-only hunk", async () => {
			const ten = lines(...Array.from({ length: 10 }, (_, index) => `export const n${index + 1} = ${index + 1};`));
			const base = commit(repo, {
				"stryker.config.json": config,
				"packages/p/src/a.ts": ten,
				"packages/p/src/b.ts": ten,
				"packages/p/src/c.ts": ten,
			});
			const edit = (change: (rows: string[]) => string[]) => lines(...change(ten.trimEnd().split("\n")));
			const head = commit(repo, {
				// A modified line, and a block of three added lines after line 6.
				"packages/p/src/a.ts": edit((rows) => [
					...rows.slice(0, 1),
					"export const modified = 2;",
					...rows.slice(2, 6),
					"export const added1 = 1;",
					"export const added2 = 2;",
					"export const added3 = 3;",
					...rows.slice(6),
				]),
				// Two lines deleted and nothing else.
				"packages/p/src/b.ts": edit((rows) => rows.slice(0, 4).concat(rows.slice(6))),
				// A deletion and an addition together at the end.
				"packages/p/src/c.ts": edit((rows) => [
					...rows.slice(0, 9),
					"export const last = 10;",
					"export const more = 11;",
				]),
			});
			const fake = stryker({ report: report({}) });
			await mutate(base, head);
			expect(entries(fake.calls()[0]!)).toEqual([
				"packages/p/src/a.ts:2-2",
				"packages/p/src/a.ts:7-9",
				"packages/p/src/c.ts:10-11",
			]);
		});

		it("never mutates a test, a fixture, a golden, built output, a declaration, a config file, or a file that is not TypeScript", async () => {
			const files = [
				"packages/p/src/a.ts",
				"packages/p/src/a.test.ts",
				"packages/p/src/a.spec.ts",
				"packages/p/src/a.d.ts",
				"packages/p/src/vitest.config.ts",
				"packages/p/test/helper.ts",
				"packages/p/src/tests/helper.ts",
				"packages/p/src/__tests__/helper.ts",
				"packages/p/src/__mocks__/helper.ts",
				"packages/p/test/fixtures/repo.ts",
				"packages/p/src/fixtures/repo.ts",
				"packages/evals/goldens/case/src/user.ts",
				"packages/p/dist/a.ts",
				"packages/p/src/readme.md",
				"packages/p/src/a.js",
				"packages/p/src/b.mts",
				"packages/p/src/c.tsx",
			];
			const base = commit(repo, { "stryker.config.json": config, "packages/p/README.md": "x\n" });
			const head = commit(repo, Object.fromEntries(files.map((path) => [path, lines("export const x = 1;")])));
			const fake = stryker({ report: report({}) });
			await mutate(base, head);
			expect(entries(fake.calls()[0]!)).toEqual([
				"packages/p/src/a.ts:1-1",
				"packages/p/src/b.mts:1-1",
				"packages/p/src/c.tsx:1-1",
			]);
		});

		it("never mutates a file under a node_modules the revision tracks", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			writeFiles(repo, {
				"packages/p/node_modules/dep/index.ts": lines("export const dep = 1;"),
				"packages/p/src/a.ts": lines("export const a = 1;"),
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "add", "--force", "packages/p/node_modules/dep/index.ts");
			gitIn(repo, "commit", "--quiet", "-m", "head");
			const head = gitIn(repo, "rev-parse", "HEAD");
			// The checkout stays at the base, whose node_modules is not tracked, so the fake below is the Stryker that runs.
			gitIn(repo, "checkout", "--quiet", "--detach", base);
			const fake = stryker({ report: report({}) });
			await mutate(base, head);
			expect(entries(fake.calls()[0]!)).toEqual(["packages/p/src/a.ts:1-1"]);
		});

		it("skips with a reason, and runs no Stryker, when the change leaves no production line to mutate", async () => {
			const base = commit(repo, { "stryker.config.json": config, "packages/p/src/a.ts": a });
			const head = commit(repo, {
				"packages/p/src/a.test.ts": lines("// a test"),
				"packages/p/src/a.ts": a.split("\n").slice(0, 2).join("\n").concat("\n}\n"),
			});
			const fake = stryker({ report: report({}) });
			const deletionOnly = await mutate(base, head);
			expect(deletionOnly).toEqual({
				status: "skipped",
				reason: "the change adds or edits no production TypeScript lines",
			});
			expect(fake.calls()).toEqual([]);
		});

		it("keeps a path with a comma out of --mutate, which splits on commas, and says so", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a,b.ts": lines("export const x = 1;"),
				"packages/p/src/c.ts": lines("export const y = 1;"),
			});
			const fake = stryker({ report: report({}) });
			const result = await mutate(base, head);
			expect(entries(fake.calls()[0]!)).toEqual(["packages/p/src/c.ts:1-1"]);
			if (result.status !== "ran") throw new Error("skipped");
			expect(result.notes).toContain(
				"packages/p/src/a,b.ts was not mutated: Stryker cannot take a path with a comma.",
			);
		});
	});

	describe("the bound on changed lines", () => {
		function head(lineCount: number, name: string) {
			const base = commit(repo, { "stryker.config.json": config });
			return {
				base,
				head: commit(repo, {
					[`packages/p/src/${name}.ts`]: lines(
						...Array.from({ length: lineCount }, (_, index) => `export const n${index} = ${index};`),
					),
				}),
			};
		}

		it("mutates a change of exactly the bound, and skips one line past it without running Stryker", async () => {
			const bound = head(5, "bound");
			const fake = stryker({ report: report({}) });
			expect((await mutate(bound.base, bound.head, { maxLines: 5 })).status).toBe("ran");
			expect(fake.calls()).toHaveLength(1);
			const past = head(6, "past");
			expect(await mutate(past.base, past.head, { maxLines: 5 })).toEqual({
				status: "skipped",
				reason: "the change adds or edits 6 production TypeScript lines, past static.mutation.maxLines of 5",
			});
			expect(fake.calls()).toHaveLength(1);
		});

		it("counts every range of a file that changes in two places", async () => {
			const ten = Array.from({ length: 10 }, (_, index) => `export const n${index} = ${index};`);
			const base = commit(repo, { "stryker.config.json": config, "packages/p/src/a.ts": lines(...ten) });
			const head = commit(repo, {
				"packages/p/src/a.ts": lines(
					...ten.map((row, index) => (index === 1 || index === 7 ? `${row} // edited` : row)),
				),
			});
			stryker({ report: report({}) });
			expect((await mutate(base, head, { maxLines: 2 })).status).toBe("ran");
			expect((await mutate(base, head, { maxLines: 1 })).status).toBe("skipped");
		});

		it("counts the lines of every range in every file", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const two = commit(repo, {
				"packages/p/src/a.ts": lines("export const a = 1;", "export const b = 2;"),
				"packages/p/src/b.ts": lines("export const c = 3;"),
			});
			stryker({ report: report({}) });
			expect((await mutate(base, two, { maxLines: 3 })).status).toBe("ran");
			expect((await mutate(base, two, { maxLines: 2 })).status).toBe("skipped");
		});
	});

	describe("when Stryker does not give a report", () => {
		it("fails closed, as invalidOutput, when it exits 0 and writes no report", async () => {
			const { base, head } = twoCommits();
			stryker();
			await expect(mutate(base, head)).rejects.toMatchObject({
				code: "invalidOutput",
				check: "static.mutation",
				message: expect.stringContaining("wrote no report"),
			});
		});

		it("does not read a report the revision committed in place of the one the run writes", async () => {
			const clean = report({ "packages/p/src/a.ts": [{ status: "Killed", line: 2 }] });
			const base = commit(repo, {
				"stryker.config.json": config,
				"packages/p/src/a.ts": a,
				"reports/mutation/mutation.json": clean,
			});
			const head = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
			const fake = stryker();
			await expect(mutate(base, head)).rejects.toMatchObject({ code: "invalidOutput" });
			expect(fake.calls()[0]).not.toContain("PLANTED");
		});

		it("fails as toolFailed, with Stryker's output, when it exits 1", async () => {
			const { base, head } = twoCommits();
			stryker({ exit: 1, report: report({}) });
			const failure = await mutate(base, head).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(CheckError);
			expect(failure).toMatchObject({ code: "toolFailed", check: "static.mutation" });
			expect((failure as CheckError).message).toContain("Stryker exited 1: stryker said something");
		});

		it("fails as invalidOutput when it exits with a code it does not document, whatever it wrote", async () => {
			const { base, head } = twoCommits();
			stryker({ exit: 2, report: report({}) });
			await expect(mutate(base, head)).rejects.toMatchObject({
				code: "invalidOutput",
				message: expect.stringContaining("Stryker exited 2, which it does not document"),
			});
		});

		it("fails as invalidOutput when the report is not one it can read", async () => {
			const { base, head } = twoCommits();
			stryker({ report: "not json" });
			await expect(mutate(base, head)).rejects.toMatchObject({ code: "invalidOutput", check: "static.mutation" });
		});

		it("lets the head's tests write a file past the 16 MiB a static tool's output may hold", async () => {
			const { base, head } = twoCommits();
			fakeTool(
				repo,
				"stryker",
				`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
head -c 20000000 /dev/zero > big.bin || exit 9
mkdir -p reports/mutation
echo '{"files":{}}' > reports/mutation/mutation.json
exit 0`,
			);
			expect((await mutate(base, head)).status).toBe("ran");
		});

		it("bounds what Stryker's process tree may write to one file at 1 GiB, so a runaway run fails rather than fills the disk", async () => {
			const { base, head } = twoCommits();
			const seen = join(artifacts, "limit.txt");
			fakeTool(
				repo,
				"stryker",
				`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
bash -c 'ulimit -f' > '${seen}'
mkdir -p reports/mutation
echo '{"files":{}}' > reports/mutation/mutation.json
exit 0`,
			);
			await mutate(base, head);
			expect(readFileSync(seen, "utf8").trim()).toBe(String(1024 * 1024));
		});

		it("stops a run that passes the timeout in static.mutation.timeout, as a timeout", async () => {
			const { base, head } = twoCommits();
			fakeTool(repo, "stryker", `if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\nsleep 30`);
			const revision = await revisionOf(base, head);
			await expect(
				runStaticTool(
					{
						env: createNodeExecutionEnv(repo),
						repoRoot: repo,
						base,
						commit: head,
						tool: "mutation",
						settings: { ...defaultConfig.static.mutation, timeout: 1 },
						revision,
					},
					context,
				),
			).rejects.toMatchObject({ code: "timeout", check: "static.mutation" });
		});

		it("keeps the end of Stryker's output in the error, not the start", async () => {
			const { base, head } = twoCommits();
			fakeTool(
				repo,
				"stryker",
				`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
printf 'START'; head -c 6000 /dev/zero | tr '\\0' x; printf 'END\\n'
exit 1`,
			);
			const failure = (await mutate(base, head).catch((error: unknown) => error)) as CheckError;
			expect(failure.message).toMatch(/END$/);
			expect(failure.message).not.toContain("START");
			expect(failure.message.length).toBeLessThan(4096 + 100);
		});

		it("fails as toolFailed when the revision has no stryker.config.json", async () => {
			const base = commit(repo, { "packages/p/src/a.ts": a });
			const head = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
			const fake = stryker({ report: report({}) });
			await expect(mutate(base, head)).rejects.toMatchObject({
				code: "toolFailed",
				message: "the revision has no stryker.config.json, which Stryker needs",
			});
			expect(fake.calls()).toEqual([]);
		});

		it("fails as toolFailed when it is given no revision to mutate", async () => {
			const { base, head } = twoCommits();
			stryker({ report: report({}) });
			await expect(mutate(base, head, { revision: false })).rejects.toMatchObject({
				code: "toolFailed",
				message: "mutation testing needs the revision it mutates",
			});
		});
	});

	describe("the test file a finding names", () => {
		async function whatToDo(sourcePath: string, tests: string[]): Promise<string> {
			const base = commit(repo, {
				"stryker.config.json": config,
				...Object.fromEntries(tests.map((path) => [path, "// t\n"])),
			});
			const head = commit(repo, { [sourcePath]: lines("export const x = 1;") });
			stryker({ report: report({ [sourcePath]: [{ status: "Survived", line: 1 }] }) });
			const [finding] = await found(base, head);
			return finding!.properties.explanation.whatToDo;
		}

		it("is the one beside the source when there is one, ahead of the package's test directory", async () => {
			expect(
				await whatToDo("packages/p/src/a.ts", ["packages/p/src/a.test.ts", "packages/p/test/a.test.ts"]),
			).toContain("in packages/p/src/a.test.ts so");
		});

		it("is the mirror of the source's path under the package's test directory, ahead of a flat one", async () => {
			expect(
				await whatToDo("packages/p/src/deep/a.ts", ["packages/p/test/deep/a.test.ts", "packages/p/test/a.test.ts"]),
			).toContain("in packages/p/test/deep/a.test.ts so");
		});

		it("is the flat file under the package's test directory when nothing mirrors the path", async () => {
			expect(await whatToDo("packages/p/src/deep/a.ts", ["packages/p/test/a.test.ts"])).toContain(
				"in packages/p/test/a.test.ts so",
			);
		});

		it("is a new file in the package's test directory when no test exists", async () => {
			expect(await whatToDo("packages/p/src/deep/a.ts", [])).toContain("in a new packages/p/test/a.test.ts so");
		});

		it("is a new file beside the source when the source is not under a src directory", async () => {
			expect(await whatToDo("lib/a.ts", [])).toContain("in a new lib/a.test.ts so");
		});
	});

	describe("as a check of a tier", () => {
		async function open() {
			const fake = createFakeModels();
			const registry = createReviewRegistry();
			registry.install(checksExtension);
			const harness = await openHarness(createMemoryStorage(), {
				models: fake.models,
				registry,
				env: () => createNodeExecutionEnv(repo),
			});
			opened.push(harness);
			return { harness, root: await harness.root(context, { agent: { model: fake.ref() } }) };
		}

		async function checks(base: string, head: string) {
			const { harness, root } = await open();
			const changeset = await Changeset.resolve(repo, `${base}..${head}`);
			const source: RepositorySource = { kind: "revision", commit: base };
			const { config: loaded } = await loadConfig(repo, source, "");
			const run = await runChecks(
				harness,
				{ rootConversationId: root.id, changeset, config: loaded, source, tier: "full" },
				context,
			);
			return { harness, root, run };
		}

		const policy = lines(
			"tiers:",
			"  full: [static.mutation]",
			"static:",
			"  mutation: { enabled: true, timeout: 120 }",
		);

		it("records the finding and the Stryker version, and does not mutate the base", async () => {
			const base = commit(repo, {
				"melian.yaml": policy,
				"stryker.config.json": config,
				"packages/p/src/a.ts": a,
			});
			const head = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
			const fake = stryker({ report: report({ "packages/p/src/a.ts": [{ status: "Survived", line: 2 }] }) });
			const { harness, root, run } = await checks(base, head);
			expect(run.records).toEqual([
				{
					name: "static.mutation",
					status: "ran",
					version: "10.0.0",
					findings: 1,
					notes: ["Stryker mutated 1 changed lines in 1 file(s); the base was not mutated."],
				},
			]);
			const findings = await readFindings(harness, root.id, revisionKey({ base, head }), context);
			expect(findings.map((finding) => finding.ruleId)).toEqual(["mutation/untested-behaviour"]);
			expect(fake.calls()).toHaveLength(1);
		});

		it("records a skip, with its reason, when the change is past the bound", async () => {
			const base = commit(repo, {
				"melian.yaml": policy.replace("timeout: 120", "timeout: 120, maxLines: 1"),
				"stryker.config.json": config,
			});
			const head = commit(repo, { "packages/p/src/a.ts": a });
			const fake = stryker({ report: report({}) });
			const { run } = await checks(base, head);
			expect(run.records).toEqual([
				{
					name: "static.mutation",
					status: "skipped",
					reason: "the change adds or edits 4 production TypeScript lines, past static.mutation.maxLines of 1",
				},
			]);
			expect(fake.calls()).toEqual([]);
		});

		it("is off unless a melian.yaml turns it on", async () => {
			const base = commit(repo, {
				"melian.yaml": policy.replace("enabled: true", "enabled: false"),
				"stryker.config.json": config,
			});
			const head = commit(repo, { "packages/p/src/a.ts": a });
			const fake = stryker({ report: report({}) });
			const { run } = await checks(base, head);
			expect(run.records).toEqual([
				{ name: "static.mutation", status: "skipped", reason: "static.mutation.enabled is false" },
			]);
			expect(fake.calls()).toEqual([]);
		});

		it("records a skip, not a pass, when the checkout has no Stryker, and Melian carries none", async () => {
			const base = commit(repo, {
				"melian.yaml": policy,
				"stryker.config.json": config,
				"packages/p/src/a.ts": a,
			});
			const tip = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
			const { run } = await checks(base, tip);
			expect(run.records).toEqual([{ name: "static.mutation", status: "skipped", reason: strykerNotInstalled }]);
			expect(mutationSkipHasLeave(strykerNotInstalled)).toBe(false);
		});

		it("runs again when the installed Stryker version changes, and not when the check is off", async () => {
			const installed = (version: string) =>
				writeFiles(repo, { "node_modules/@stryker-mutator/core/package.json": JSON.stringify({ version }) });
			const identities = async (yaml: string) => {
				const base = commit(repo, { "melian.yaml": yaml, "stryker.config.json": config, "packages/p/src/a.ts": a });
				const head = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
				stryker({ report: report({}) });
				const policies: string[] = [];
				for (const version of ["10.0.0", "10.0.1"]) {
					installed(version);
					policies.push((await checks(base, head)).run.identity.policy);
				}
				return policies;
			};
			const [first, second] = await identities(policy);
			expect(first).not.toBe(second);
			const [offFirst, offSecond] = await identities(policy.replace("enabled: true", "enabled: false"));
			expect(offFirst).toBe(offSecond);
		});
	});
});

describe("staticToolSource for Stryker", () => {
	it("is the checkout's install when it has one, and missing otherwise, since Melian carries none", () => {
		expect(staticToolSource(repo, "mutation")).toEqual({ from: "missing" });
		stryker();
		expect(staticToolSource(repo, "mutation")).toEqual({
			from: "checkout",
			path: join(repo, "node_modules", ".bin", "stryker"),
		});
	});
});

describe("strykerVersion", () => {
	it("reads the checkout's install, and is unavailable when it has none or none that names a version", () => {
		expect(strykerVersion(repo)).toBe("unavailable");
		mkdirSync(join(repo, "node_modules/@stryker-mutator/core"), { recursive: true });
		writeFileSync(
			join(repo, "node_modules/@stryker-mutator/core/package.json"),
			JSON.stringify({ version: "9.9.9" }),
		);
		expect(strykerVersion(repo)).toBe("9.9.9");
		writeFileSync(
			join(repo, "node_modules/@stryker-mutator/core/package.json"),
			JSON.stringify({ name: "no version" }),
		);
		expect(strykerVersion(repo)).toBe("unavailable");
		writeFileSync(join(repo, "node_modules/@stryker-mutator/core/package.json"), "not json");
		expect(strykerVersion(repo)).toBe("unavailable");
		expect(strykerVersion(join(repo, "missing"))).toBe("unavailable");
	});
});
