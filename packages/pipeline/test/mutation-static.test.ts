import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Changeset,
	CheckError,
	defaultConfig,
	type Finding,
	loadConfig,
	mutationSkipHasLeave,
	mutationSkips,
	mutationUnmutated,
	type RepositorySource,
	Revision,
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
	type WriterTrust,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strykerNotInstalled, strykerVersion } from "../src/mutation-static.ts";
import { Sandbox } from "../src/sandbox.ts";
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
import { unconfinedSandbox } from "./fixtures/sandbox.ts";

// The checkout's node_modules is never tracked, as in a real repository: a tracked one is ignored by the check.
function commit(root: string, files: Record<string, string>): string {
	return commitTo(root, { ".gitignore": "node_modules\n", ...files });
}

let repo: string;
let artifacts: string;
let opened: Harness[];

beforeEach(() => {
	vi.spyOn(Sandbox, "detect").mockReturnValue(unconfinedSandbox);
	repo = createRepository();
	artifacts = realpathSync(mkdtempSync(join(tmpdir(), "melian-mutation-")));
	opened = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
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
	reason?: string;
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
						...(mutant.reason === undefined ? {} : { statusReason: mutant.reason }),
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
function stryker(options: { report?: string; exit?: number; version?: string } = {}): {
	calls: () => string[][];
	heads: () => string[];
} {
	const canned = join(artifacts, "report.json");
	const record = join(artifacts, "calls.txt");
	const heads = join(artifacts, "heads.txt");
	if (options.report !== undefined) writeFileSync(canned, options.report);
	fakeTool(
		repo,
		"stryker",
		`if [ "$1" = "--version" ]; then echo ${options.version ?? "10.0.0"}; exit 0; fi
git rev-parse HEAD >> '${heads}'
printf 'CALL\\n%s\\n' "$(pwd)" >> '${record}'
printf '%s\\n' "$@" >> '${record}'
[ ! -e reports/mutation/mutation.json ] || echo PLANTED >> '${record}'
if [ -f '${canned}' ]; then mkdir -p reports/mutation; cp '${canned}' reports/mutation/mutation.json; fi
echo "stryker said something" >&2
exit ${options.exit ?? 0}`,
	);
	return {
		heads: () => (existsSync(heads) ? readFileSync(heads, "utf8").trimEnd().split("\n") : []),
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

async function found(base: string, head: string, extra: { maxLines?: number } = {}): Promise<readonly Finding[]> {
	const revision = await revisionOf(base, head);
	const result = await mutate(base, head, extra);
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
		expect(result.baseLog?.runs).toEqual([{ tool: { driver: { name: "Stryker", version: "10.0.0" } }, results: [] }]);
		expect(result.notes).toContain("Stryker mutated 1 changed lines in 1 file(s); the base was not mutated.");
		expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		expect(gitIn(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
	});

	it("runs Stryker with a home and a temporary directory in scratch, and with none of the Melian process's variables", async () => {
		const { base, head } = twoCommits();
		const seen = join(artifacts, "seen.txt");
		fakeTool(
			repo,
			"stryker",
			`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
printf '%s\\n' "$(pwd)" "$HOME" "$TMPDIR" "\${MELIAN_CANARY:-unset}" "$([ -d "$HOME" ] && echo home-exists)" "$([ -d "$TMPDIR" ] && echo tmp-exists)" > '${seen}'
mkdir -p reports/mutation
echo '{"files":{}}' > reports/mutation/mutation.json`,
		);
		process.env.MELIAN_CANARY = "a-secret";
		try {
			await mutate(base, head);
		} finally {
			delete process.env.MELIAN_CANARY;
		}
		const [cwd, home, temporary, canary, homeExists, tmpExists] = readFileSync(seen, "utf8").trimEnd().split("\n");
		const scratch = cwd!.replace(/\/tree$/, "");
		expect(scratch).toMatch(/\/melian-static-[^/]+$/);
		expect(home).toBe(`${scratch}/home`);
		expect(temporary).toBe(`${scratch}/tmp`);
		expect(home).not.toBe(process.env.HOME);
		expect([canary, homeExists, tmpExists]).toEqual(["unset", "home-exists", "tmp-exists"]);
	});

	describe("the sandbox", () => {
		const hostSandbox = Sandbox.detect();

		// A fake that reads a file outside the run, and fails with an exit code Stryker never gives if it can.
		function probing(secret: string): void {
			fakeTool(
				repo,
				"stryker",
				`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
if cat '${secret}' > /dev/null 2>&1; then exit 3; fi
mkdir -p reports/mutation
echo '{"files":{}}' > reports/mutation/mutation.json`,
			);
		}

		it.skipIf(hostSandbox === undefined)("runs Stryker where it can read no file outside the run", async () => {
			vi.restoreAllMocks();
			const { base, head } = twoCommits();
			const secret = join(artifacts, "auth.json");
			writeFileSync(secret, "{}");
			probing(secret);
			const result = await mutate(base, head);
			expect(result.status).toBe("ran");
		});

		it("proves the probe: unconfined, the same fake exits 3 and the check fails", async () => {
			const { base, head } = twoCommits();
			const secret = join(artifacts, "auth.json");
			writeFileSync(secret, "{}");
			probing(secret);
			await expect(mutate(base, head)).rejects.toMatchObject({ code: "invalidOutput" });
		});

		it("records a skip with leave and the cause noSandbox, running nothing, on a host with no sandbox", async () => {
			vi.spyOn(Sandbox, "detect").mockReturnValue(undefined);
			const { base, head } = twoCommits();
			const fake = stryker({ report: report({}) });
			expect(await mutate(base, head)).toEqual({
				status: "skipped",
				reason: mutationSkips.noSandbox,
				cause: "noSandbox",
			});
			expect(fake.calls()).toHaveLength(0);
			expect(mutationSkipHasLeave("noSandbox")).toBe(true);
		});
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
				cause: "noProductionLines",
			});
			expect(mutationSkipHasLeave(deletionOnly.status === "skipped" ? deletionOnly.cause : undefined)).toBe(true);
			expect(fake.calls()).toEqual([]);
		});

		it.each([
			"packages/p/src/a.d.ts",
			"packages/evals/verifier/case/src/user.ts",
			"packages/p/test/helper.ts",
			"packages/evals/goldens/case/src/user.ts",
			"packages/p/dist/a.ts",
			"packages/p/src/readme.md",
		])("keeps the leave for a change to %s alone, which holds no behaviour to judge", async (path) => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, { [path]: lines("export const x = 1;") });
			stryker({ report: report({}) });
			expect(await mutate(base, head)).toMatchObject({ status: "skipped", cause: "noProductionLines" });
		});

		it.each(["packages/p/vitest.config.ts", "packages/p/src/rules.config.mts"])(
			"gives the skip no leave, and names the file, when the change is to %s, a production file Stryker does not mutate",
			async (path) => {
				const base = commit(repo, { "stryker.config.json": config });
				const head = commit(repo, { [path]: lines("export default { run: () => 1 };") });
				const fake = stryker({ report: report({}) });
				const result = await mutate(base, head);
				expect(result).toEqual({
					status: "skipped",
					reason: mutationSkips.unmutated([path]),
					cause: "unmutated",
				});
				expect(result.status === "skipped" && mutationSkipHasLeave(result.cause)).toBe(false);
				expect(result.status === "skipped" && result.reason).toContain(path);
				expect(fake.calls()).toEqual([]);
			},
		);

		it("notes a configuration file beside the production files it does mutate", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": a,
				"packages/p/vitest.config.ts": lines("export default {};"),
			});
			const fake = stryker({ report: report({}) });
			const result = await mutate(base, head);
			expect(entries(fake.calls()[0]!)).toEqual(["packages/p/src/a.ts:1-4"]);
			if (result.status !== "ran") throw new Error("skipped");
			expect(result.notes).toContain(
				"packages/p/vitest.config.ts was not mutated: a tool loads a configuration file to run the mutants.",
			);
		});

		describe("a production file that lists no changed lines", () => {
			const binary = "export const x = 1;\0\n";
			const path = "packages/p/src/blob.ts";

			it("gives the skip no leave and raises an unmutated finding when the file is binary and nothing else changes", async () => {
				const base = commit(repo, { "stryker.config.json": config });
				const head = commit(repo, { [path]: binary });
				const fake = stryker({ report: report({}) });
				const result = await mutate(base, head);
				expect(result).toMatchObject({
					status: "skipped",
					cause: "unmutated",
					reason: mutationSkips.unmutated([path]),
				});
				if (result.status !== "skipped") throw new Error("ran");
				expect(mutationSkipHasLeave(result.cause)).toBe(false);
				expect(result.log?.runs[0].results.map((each) => [each.ruleId, each.message.text])).toEqual([
					["unmutated", `Stryker did not judge the changed lines of ${path}: ${mutationUnmutated.binary.why}.`],
				]);
				expect(fake.calls()).toEqual([]);
			});

			it("raises the finding beside the findings of the files it does mutate", async () => {
				const base = commit(repo, { "stryker.config.json": config });
				const head = commit(repo, { [path]: binary, "packages/p/src/a.ts": a });
				stryker({ report: report({ "packages/p/src/a.ts": [{ status: "Survived", line: 2 }] }) });
				expect(
					(await found(base, head)).map((finding) => [finding.ruleId, finding.properties.path]).sort(),
				).toEqual([
					["mutation/unmutated", path],
					["mutation/untested-behaviour", "packages/p/src/a.ts"],
				]);
			});

			it("keeps the leave for a binary test file, a deleted binary file, and a binary file that is not TypeScript", async () => {
				const base = commit(repo, {
					"stryker.config.json": config,
					"packages/p/src/gone.ts": binary,
				});
				stryker({ report: report({}) });
				const head = commitTo(
					repo,
					{
						"packages/p/test/blob.test.ts": "\0\0 a test, unlike the deleted file\0",
						"packages/p/src/image.png": "\0PNG\0",
					},
					["packages/p/src/gone.ts"],
				);
				expect(await mutate(base, head)).toMatchObject({ status: "skipped", cause: "noProductionLines" });
			});

			it("counts a file whose name is not UTF-8 text, which git lists without lines", async () => {
				const { base, head } = twoCommits();
				stryker({ report: report({}) });
				const revision = Revision.from({
					base,
					head,
					files: [
						{
							status: "added",
							path: "packages/p/src/%FF.ts",
							percentEncoded: true,
							binary: false,
							hunks: [],
						},
					],
				});
				const result = await runStaticTool(
					{
						env: createNodeExecutionEnv(repo),
						repoRoot: repo,
						base,
						commit: head,
						tool: "mutation",
						settings: { ...defaultConfig.static.mutation, timeout: 120 },
						revision,
					},
					context,
				);
				expect(result).toMatchObject({ status: "skipped", cause: "unmutated" });
			});

			it("names the file when the run passes its timeout", async () => {
				const base = commit(repo, { "stryker.config.json": config });
				const head = commit(repo, { [path]: binary, "packages/p/src/a.ts": a });
				fakeTool(repo, "stryker", `if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\nsleep 30`);
				const result = await runStaticTool(
					{
						env: createNodeExecutionEnv(repo),
						repoRoot: repo,
						base,
						commit: head,
						tool: "mutation",
						settings: { ...defaultConfig.static.mutation, timeout: 1 },
						revision: await revisionOf(base, head),
					},
					context,
				);
				if (result.status !== "skipped") throw new Error("ran");
				expect(result.log?.runs[0].results[0]!.message.text).toContain(`${"packages/p/src/a.ts"}, ${path}`);
			});
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

	describe("the paths it names", () => {
		function entries(call: string[]): string[] {
			return argumentsOf(call).flag("--mutate")!.split(",");
		}

		const route = "app/users/[id]/(group)/route.ts";

		it("escapes every glob character in a path, so Stryker reads the file and no other", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const odd = "packages/p/src/a*b?c{d}e!f+g@h#i\\j'k.ts";
			const head = commit(repo, { [route]: lines("export const x = 1;"), [odd]: lines("export const y = 1;") });
			const fake = stryker({ report: report({}) });
			await mutate(base, head);
			expect(entries(fake.calls()[0]!)).toEqual([
				"app/users/\\[id\\]/\\(group\\)/route.ts:1-1",
				"packages/p/src/a\\*b\\?c\\{d\\}e\\!f\\+g\\@h\\#i\\\\j'k.ts:1-1",
			]);
		});

		it("notes a requested file the report holds no mutants for, and only that one", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				[route]: lines("export const x = 1;"),
				"packages/p/src/b.ts": lines("export const y = 1;"),
			});
			stryker({ report: report({ "packages/p/src/b.ts": [{ status: "Killed", line: 1 }] }) });
			const result = await mutate(base, head);
			if (result.status !== "ran") throw new Error("skipped");
			expect(result.notes.filter((note) => note.includes("produced no mutants"))).toEqual([
				`${route} produced no mutants, so nothing on its changed lines was judged.`,
			]);
		});

		it("makes a survivor in a path with glob characters a finding at that path", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, { [route]: lines("export const x = 1;") });
			stryker({ report: report({ [route]: [{ status: "Survived", line: 1 }] }) });
			const findings = await found(base, head);
			expect(findings.map((finding) => finding.properties.path)).toEqual([route]);
		});

		it("makes an Ignored mutant on a changed line a P2 mutation/ignored-mutant finding with Stryker's reason, and nothing off it", async () => {
			const { base, head } = twoCommits();
			stryker({
				report: report({
					"packages/p/src/a.ts": [
						{ status: "Ignored", line: 2, reason: "Ignored by a Stryker disable comment" },
						{ status: "Ignored", line: 500, reason: "Static mutant" },
					],
				}),
			});
			const findings = await found(base, head);
			expect(
				findings.map((finding) => [
					finding.ruleId,
					finding.properties.severity,
					finding.properties.path,
					finding.locations[0]!.physicalLocation.region.startLine,
					finding.properties.explanation.what,
				]),
			).toEqual([
				[
					"mutation/ignored-mutant",
					"P2",
					"packages/p/src/a.ts",
					2,
					"Stryker ignored the mutants of this changed line, so no test was asked about them (Ignored by a Stryker disable comment).",
				],
			]);
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

		const lastEntries = (fake: { calls: () => string[][] }) =>
			argumentsOf(fake.calls().at(-1)!).flag("--mutate")!.split(",");
		// What the run left out, as the findings of rule mutation/unmutated name it.
		const leftOut = async (base: string, head: string, maxLines: number) =>
			(await found(base, head, { maxLines }))
				.filter((finding) => finding.ruleId === "mutation/unmutated")
				.map((finding) => [
					finding.properties.path,
					finding.properties.severity,
					finding.properties.explanation.what,
				]);

		it("mutates a change of exactly the bound whole, and cuts one line past it at the bound, with a finding for the line", async () => {
			const fake = stryker({ report: report({}) });
			const bound = head(5, "bound");
			expect(await leftOut(bound.base, bound.head, 5)).toEqual([]);
			expect(lastEntries(fake)).toEqual(["packages/p/src/bound.ts:1-5"]);
			const past = head(6, "past");
			expect(await leftOut(past.base, past.head, 5)).toEqual([
				[
					"packages/p/src/past.ts",
					"P2",
					"Stryker did not judge line 6 of packages/p/src/past.ts: the change is past static.mutation.maxLines of 5, so the run mutated other lines and left these out.",
				],
			]);
			expect(lastEntries(fake)).toEqual(["packages/p/src/past.ts:1-5"]);
			expect(fake.calls()).toHaveLength(2);
		});

		// n lines of code in one file, as the head adds them.
		const rows = (name: string, count: number) =>
			lines(...Array.from({ length: count }, (_, index) => `export const ${name}${index} = ${index};`));

		it("shares the bound across the files in proportion, so a risky file last in path order is mutated too", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": rows("a", 10),
				"packages/p/src/b.ts": rows("b", 10),
				"packages/p/src/z.ts": rows("z", 2),
			});
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 11 });
			expect(lastEntries(fake)).toEqual([
				"packages/p/src/a.ts:1-5",
				"packages/p/src/b.ts:1-5",
				"packages/p/src/z.ts:1-1",
			]);
			expect((await leftOut(base, head, 11)).map(([path, , what]) => [path, what])).toEqual([
				["packages/p/src/a.ts", expect.stringContaining("lines 6-10 of packages/p/src/a.ts")],
				["packages/p/src/b.ts", expect.stringContaining("lines 6-10 of packages/p/src/b.ts")],
				["packages/p/src/z.ts", expect.stringContaining("line 2 of packages/p/src/z.ts")],
			]);
		});

		it("gives a file with a single changed line one line of the bound, taking it from the largest share", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": rows("a", 99),
				"packages/p/src/z.ts": rows("z", 1),
			});
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 20 });
			expect(lastEntries(fake)).toEqual(["packages/p/src/a.ts:1-19", "packages/p/src/z.ts:1-1"]);
		});

		it("gives every file a line when the bound is exactly the number of files", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": rows("a", 5),
				"packages/p/src/b.ts": rows("b", 1),
				"packages/p/src/c.ts": rows("c", 1),
			});
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 3 });
			expect(lastEntries(fake)).toEqual([
				"packages/p/src/a.ts:1-1",
				"packages/p/src/b.ts:1-1",
				"packages/p/src/c.ts:1-1",
			]);
		});

		it("gives the line the shares leave over to the file with the largest remainder, whatever its path", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, { "packages/p/src/a.ts": rows("a", 3), "packages/p/src/b.ts": rows("b", 4) });
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 3 });
			expect(lastEntries(fake)).toEqual(["packages/p/src/a.ts:1-1", "packages/p/src/b.ts:1-2"]);
		});

		it("breaks a tie between equal remainders in path order", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, { "packages/p/src/a.ts": rows("a", 3), "packages/p/src/b.ts": rows("b", 3) });
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 3 });
			expect(lastEntries(fake)).toEqual(["packages/p/src/a.ts:1-2", "packages/p/src/b.ts:1-1"]);
		});

		it("leaves whole files out, last in path order first, when there are more files than lines in the bound", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": rows("a", 1),
				"packages/p/src/b.ts": rows("b", 1),
				"packages/p/src/c.ts": rows("c", 1),
			});
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 2 });
			expect(lastEntries(fake)).toEqual(["packages/p/src/a.ts:1-1", "packages/p/src/b.ts:1-1"]);
			expect((await leftOut(base, head, 2)).map(([path]) => path)).toEqual(["packages/p/src/c.ts"]);
		});

		it("cuts a range the bound falls in, and counts every range of a file that changes in two places", async () => {
			const ten = Array.from({ length: 10 }, (_, index) => `export const n${index} = ${index};`);
			const base = commit(repo, { "stryker.config.json": config, "packages/p/src/a.ts": lines(...ten) });
			const head = commit(repo, {
				"packages/p/src/a.ts": lines(
					...ten.map((row, index) =>
						index >= 1 && index <= 3 ? `${row} // edited` : index === 7 ? `${row} // edited` : row,
					),
				),
			});
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 4 });
			expect(lastEntries(fake)).toEqual(["packages/p/src/a.ts:2-4", "packages/p/src/a.ts:8-8"]);
			expect(await leftOut(base, head, 4)).toEqual([]);
			await mutate(base, head, { maxLines: 2 });
			expect(lastEntries(fake)).toEqual(["packages/p/src/a.ts:2-3"]);
			expect((await leftOut(base, head, 2)).map(([, , what]) => what)).toEqual([
				expect.stringContaining("lines 4, 8 of packages/p/src/a.ts"),
			]);
			expect((await leftOut(base, head, 3)).map(([, , what]) => what)).toEqual([
				expect.stringContaining("line 8 of packages/p/src/a.ts"),
			]);
		});

		it("names every file, those past the bound too, when the run passes its timeout", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": lines("export const a = 1;"),
				"packages/p/src/b.ts": lines("export const b = 1;"),
				"packages/p/src/c.ts": lines("export const c = 1;"),
			});
			fakeTool(repo, "stryker", `if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\nsleep 30`);
			const result = await runStaticTool(
				{
					env: createNodeExecutionEnv(repo),
					repoRoot: repo,
					base,
					commit: head,
					tool: "mutation",
					settings: { ...defaultConfig.static.mutation, timeout: 1, maxLines: 1 },
					revision: await revisionOf(base, head),
				},
				context,
			);
			if (result.status !== "skipped") throw new Error("ran");
			expect(result.log?.runs[0].results.map((each) => each.message.text)).toEqual([
				`Stryker did not judge the changed lines of packages/p/src/a.ts, packages/p/src/b.ts, packages/p/src/c.ts: ${mutationSkips.timeout(1)}.`,
			]);
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

		it("records a run that passes static.mutation.timeout as a skip with leave, not a failure", async () => {
			const { base, head } = twoCommits();
			fakeTool(repo, "stryker", `if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\nsleep 30`);
			const revision = await revisionOf(base, head);
			const result = await runStaticTool(
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
			);
			expect(result).toMatchObject({ status: "skipped", reason: mutationSkips.timeout(1), cause: "timeout" });
			expect(mutationSkipHasLeave("timeout")).toBe(true);
			if (result.status !== "skipped") throw new Error("ran");
			expect(result.log?.runs[0].results.map((each) => [each.ruleId, each.message.text])).toEqual([
				[
					"unmutated",
					`Stryker did not judge the changed lines of packages/p/src/a.ts: ${mutationSkips.timeout(1)}.`,
				],
			]);
		});

		it("fails a cancelled run as aborted, never as a timeout skip", async () => {
			const { base, head } = twoCommits();
			fakeTool(repo, "stryker", `if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\nsleep 30`);
			const revision = await revisionOf(base, head);
			const controller = new AbortController();
			const cancellable = { abortSignal: controller.signal, value: () => undefined, toString: () => "cancellable" };
			setTimeout(() => controller.abort(), 2_000);
			await expect(
				runStaticTool(
					{
						env: createNodeExecutionEnv(repo),
						repoRoot: repo,
						base,
						commit: head,
						tool: "mutation",
						settings: { ...defaultConfig.static.mutation, timeout: 120 },
						revision,
					},
					cancellable,
				),
			).rejects.toMatchObject({ code: "aborted", check: "static.mutation" });
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

		const trusted: WriterTrust = { trusted: true };

		async function checks(base: string, head: string, writer: WriterTrust | null = trusted) {
			const { harness, root } = await open();
			const changeset = await Changeset.resolve(repo, `${base}..${head}`);
			const source: RepositorySource = { kind: "revision", commit: base };
			const { config: loaded } = await loadConfig(repo, source, "");
			const run = await runChecks(
				harness,
				{
					rootConversationId: root.id,
					changeset,
					config: loaded,
					source,
					tier: "full",
					...(writer === null ? {} : { writer }),
				},
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
			expect(fake.heads()).toEqual([head]);
		});

		it("mutates the first lines of a change past the bound, and records the lines it left out as a finding, never as a clean check", async () => {
			const base = commit(repo, {
				"melian.yaml": policy.replace("timeout: 120", "timeout: 120, maxLines: 1"),
				"stryker.config.json": config,
			});
			const head = commit(repo, { "packages/p/src/a.ts": a });
			const fake = stryker({ report: report({}) });
			const { harness, root, run } = await checks(base, head);
			expect(run.records).toEqual([
				{
					name: "static.mutation",
					status: "ran",
					version: "10.0.0",
					findings: 1,
					notes: [
						"Stryker mutated 1 changed lines in 1 file(s); the base was not mutated.",
						"packages/p/src/a.ts produced no mutants, so nothing on its changed lines was judged.",
					],
				},
			]);
			const [left] = await readFindings(harness, root.id, revisionKey({ base, head }), context);
			expect(left).toMatchObject({ ruleId: "mutation/unmutated", properties: { path: "packages/p/src/a.ts" } });
			expect(left!.properties.explanation.what).toContain("lines 2-4 of packages/p/src/a.ts");
			expect(fake.calls()).toHaveLength(1);
		});

		it("records a run past its timeout as a skip with leave that still raises one P2 mutation/unmutated finding naming the files", async () => {
			const base = commit(repo, {
				"melian.yaml": policy.replace("timeout: 120", "timeout: 1"),
				"stryker.config.json": config,
				"packages/p/src/a.ts": a,
				"packages/p/src/b.ts": a.replace("function a", "function b"),
			});
			const head = commit(repo, {
				"packages/p/src/a.ts": a.replace("x > 0", "x >= 0"),
				"packages/p/src/b.ts": a.replace("function a", "function b").replace("x > 0", "x >= 0"),
			});
			fakeTool(repo, "stryker", `if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\nsleep 30`);
			const { harness, root, run } = await checks(base, head);
			expect(run.records).toEqual([
				{
					name: "static.mutation",
					status: "skipped",
					reason: mutationSkips.timeout(1),
					cause: "timeout",
				},
			]);
			const findings = await readFindings(harness, root.id, revisionKey({ base, head }), context);
			expect(
				findings.map((finding) => [finding.ruleId, finding.properties.severity, finding.properties.path]),
			).toEqual([["mutation/unmutated", "P2", "packages/p/src/a.ts"]]);
			expect(findings[0]!.properties.explanation.what).toContain("packages/p/src/a.ts, packages/p/src/b.ts");
		});

		describe("for the writer of the head", () => {
			const head = () => {
				const base = commit(repo, {
					"melian.yaml": policy,
					"stryker.config.json": config,
					"packages/p/src/a.ts": a,
				});
				return { base, head: commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") }) };
			};

			it("runs nothing, and records a skip with leave that says the writer is not trusted, for an untrusted writer", async () => {
				const { base, head: tip } = head();
				const fake = stryker({ report: report({}) });
				const detail = "octocat has read permission on the repository";
				const { run } = await checks(base, tip, { trusted: false, detail });
				expect(run.records).toEqual([
					{
						name: "static.mutation",
						status: "skipped",
						reason: mutationSkips.untrustedWriter(detail),
						cause: "untrustedWriter",
					},
				]);
				expect(run.records[0]).toMatchObject({
					reason: expect.stringContaining("the writer is not a trusted one"),
				});
				expect(mutationSkipHasLeave((run.records[0] as { cause?: string }).cause)).toBe(true);
				expect(fake.calls()).toEqual([]);
			});

			it("runs for a trusted writer", async () => {
				const { base, head: tip } = head();
				const fake = stryker({ report: report({}) });
				const { run } = await checks(base, tip, { trusted: true });
				expect(run.records[0]).toMatchObject({ name: "static.mutation", status: "ran" });
				expect(fake.calls()).toHaveLength(1);
			});

			it("skips when the review names no writer", async () => {
				const { base, head: tip } = head();
				const fake = stryker({ report: report({}) });
				const { run } = await checks(base, tip, null);
				expect(run.records).toEqual([
					{
						name: "static.mutation",
						status: "skipped",
						reason: mutationSkips.untrustedWriter("the review named no writer for this head"),
						cause: "untrustedWriter",
					},
				]);
				expect(fake.calls()).toEqual([]);
			});

			it("skips, even for a trusted writer, when the repository's policy does not trust writers", async () => {
				const base = commit(repo, {
					"melian.yaml": `trust: { writers: false }\n${policy}`,
					"stryker.config.json": config,
					"packages/p/src/a.ts": a,
				});
				const tip = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
				const fake = stryker({ report: report({}) });
				const { run } = await checks(base, tip, { trusted: true });
				expect(run.records).toEqual([
					{
						name: "static.mutation",
						status: "skipped",
						reason: mutationSkips.untrustedWriter("trust.writers is false in the repository's policy"),
						cause: "untrustedWriter",
					},
				]);
				expect(fake.calls()).toEqual([]);
			});

			it("runs again when the writer's trust changes", async () => {
				const { base, head: tip } = head();
				stryker({ report: report({}) });
				const trustedRun = (await checks(base, tip, { trusted: true })).run.identity.policy;
				const untrustedRun = (await checks(base, tip, { trusted: false, detail: "x" })).run.identity.policy;
				expect(trustedRun).not.toBe(untrustedRun);
			});
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

		it("records the same skip when the checkout has an install but no Stryker in it", async () => {
			const base = commit(repo, {
				"melian.yaml": policy,
				"stryker.config.json": config,
				"packages/p/src/a.ts": a,
			});
			const tip = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
			fakeTool(repo, "other", "exit 0");
			const { run } = await checks(base, tip);
			expect(run.records).toEqual([{ name: "static.mutation", status: "skipped", reason: strykerNotInstalled }]);
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
			expect(strykerNotInstalled).toContain("@stryker-mutator/core and @stryker-mutator/vitest-runner");
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

		it("runs again, in the same storage, once a missing Stryker executable is restored with no change of version", async () => {
			const base = commit(repo, {
				"melian.yaml": policy,
				"stryker.config.json": config,
				"packages/p/src/a.ts": a,
			});
			const tip = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
			writeFiles(repo, { "node_modules/@stryker-mutator/core/package.json": JSON.stringify({ version: "10.0.0" }) });
			const { harness, root } = await open();
			const changeset = await Changeset.resolve(repo, `${base}..${tip}`);
			const source: RepositorySource = { kind: "revision", commit: base };
			const { config: loaded } = await loadConfig(repo, source, "");
			const again = () =>
				runChecks(
					harness,
					{ rootConversationId: root.id, changeset, config: loaded, source, tier: "full", writer: trusted },
					context,
				);
			const missing = await again();
			expect(missing.records).toEqual([{ name: "static.mutation", status: "skipped", reason: strykerNotInstalled }]);
			stryker({ report: report({}) });
			const repaired = await again();
			expect(repaired.records).toMatchObject([{ name: "static.mutation", status: "ran" }]);
			expect(repaired.identity.policy).not.toBe(missing.identity.policy);
		});

		it("runs again when the host's sandbox changes, and not when the check is off", async () => {
			const identities = async (yaml: string) => {
				const base = commit(repo, { "melian.yaml": yaml, "stryker.config.json": config, "packages/p/src/a.ts": a });
				const head = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
				stryker({ report: report({}) });
				const policies: string[] = [];
				for (const found of [unconfinedSandbox, undefined]) {
					vi.spyOn(Sandbox, "detect").mockReturnValue(found);
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

describe("staticToolSource for a tool Melian carries", () => {
	it.each(["biome", "tsc"] as const)("is Melian's own %s when the checkout has none", (tool) => {
		const source = staticToolSource(repo, tool);
		expect(source).toEqual({ from: "melian", path: expect.stringContaining(`/${tool}`) });
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
