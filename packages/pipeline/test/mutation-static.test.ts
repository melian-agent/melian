import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
	type ExecutionEnv,
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
import { MutationCache } from "../src/mutation-cache.ts";
import { MutationProcess } from "../src/mutation-process.ts";
import { MutationRun, strykerNotInstalled, strykerVersion } from "../src/mutation-static.ts";
import { Run, staticToolSource } from "../src/static.ts";
import { fakeMutationProcesses } from "./fixtures/mutation-process.ts";
import {
	commit as commitTo,
	createRepository,
	fakeTool,
	gitIn,
	lines,
	removeRepository,
	writeFiles,
} from "./fixtures/repo.ts";
import { RunV1, removeStaleWorktreesV1 } from "./fixtures/stale-worktrees-v1.ts";
import { emptyVitestInstall } from "./fixtures/vitest-listing.ts";

// The checkout's node_modules is never tracked, as in a real repository: a tracked one is ignored by the check.
function commit(root: string, files: Record<string, string>): string {
	return commitTo(root, { ".gitignore": "node_modules\n", ...files });
}

let repo: string;
let artifacts: string;
let opened: Harness[];

beforeEach(() => {
	fakeMutationProcesses();
	repo = createRepository();
	artifacts = realpathSync(mkdtempSync(join(tmpdir(), "melian-mutation-")));
	opened = [];
	writeFiles(repo, emptyVitestInstall);
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
	outsideTests?: boolean;
}

function report(files: Record<string, Mutant[]>, ignoreStatic = false): string {
	return JSON.stringify({
		schemaVersion: "1.0",
		config: { ignoreStatic },
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
						...(mutant.outsideTests === undefined ? {} : { static: mutant.outsideTests }),
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

async function mutate(
	base: string,
	head: string,
	extra: {
		maxLines?: number;
		timeout?: number;
		revision?: boolean;
		headCode?: "trusted" | undefined;
		policyCommit?: string;
		env?: ExecutionEnv;
		holdsAuthority?: () => Promise<boolean>;
	} = {},
) {
	const revision = await revisionOf(base, head);
	return runStaticTool(
		{
			env: extra.env ?? createNodeExecutionEnv(repo),
			repoRoot: repo,
			base,
			commit: head,
			tool: "mutation",
			headCode: "headCode" in extra ? extra.headCode : "trusted",
			policyCommit: extra.policyCommit,
			...(extra.holdsAuthority === undefined ? {} : { holdsAuthority: extra.holdsAuthority }),
			settings: {
				...defaultConfig.static.mutation,
				timeout: extra.timeout ?? 120,
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

// Stryker's command ends at the run's timeout, without waiting for one: a real one-second timeout also cuts the git
// commands before Stryker on a loaded machine, and the test then fails for a reason it is not about.
function strykerTimesOut(): void {
	vi.spyOn(MutationProcess.prototype, "execute").mockImplementation(async function (this: MutationProcess) {
		throw this.run.fail("timeout", `mutation ran past its ${this.run.input.settings.timeout}-second timeout`);
	});
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
	it.each([
		[60, 1],
		[7140, 119],
		[7141, 120],
		[7200, 120],
		[7201, 121],
	])("gives Stryker a dry-run limit no shorter than a %i-second timeout: %i minutes", async (timeout, minutes) => {
		const { base, head } = twoCommits();
		const selected = join(artifacts, "selected.json");
		fakeTool(
			repo,
			"stryker",
			`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\ncp "$2" '${selected}'\nmkdir -p reports/mutation\necho '{"schemaVersion":"1.0","files":{}}' > reports/mutation/mutation.json`,
		);
		await mutate(base, head, { timeout });
		expect(JSON.parse(readFileSync(selected, "utf8")).dryRunTimeoutMinutes).toBe(minutes);
	});

	it.each([
		"packages/core/src/git.ts",
		"packages/pipeline/src/cache-scratch.ts",
		"packages/pipeline/src/mutation-process.ts",
		"packages/pipeline/src/static.ts",
	])("keeps signal-sending %s outside automatic mutation, even beside other production changes", async (path) => {
		const { base, head } = twoCommits({
			"packages/p/src/a.ts": a.replace("x > 0", "x >= 0"),
			[path]: "export const harmless = 1;\n",
		});
		const fake = stryker({ report: report({}) });
		const result = await mutate(base, head);
		expect(result.status).toBe("ran");
		if (result.status !== "ran") throw new Error("skipped");
		expect(argumentsOf(fake.calls()[0]!).flag("--mutate")).toBe("packages/p/src/a.ts:2-2");
		expect(result.notes).toContain(`${path} was not mutated: it sends process signals; prove its guards with fakes.`);
	});

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

	it("runs Stryker once, in the head's worktree, with the changed lines, a JSON report, and the incremental file in the repository cache", async () => {
		const { base, head } = twoCommits();
		const fake = stryker({ report: report({}) });
		const result = await mutate(base, head);
		if (result.status !== "ran") throw new Error("skipped");
		const calls = fake.calls();
		expect(calls).toHaveLength(1);
		const { cwd, run, flag } = argumentsOf(calls[0]!);
		expect(cwd).toMatch(/\/melian-static-[^/]+\/tree$/);
		expect(run.slice(0, 2)).toEqual(["run", join(cwd, "../stryker.config.json")]);
		expect(flag("--reporters")).toBe("json");
		expect(run).toContain("--incremental");
		expect(run).toContain("--inPlace");
		expect(flag("--mutate")).toBe("packages/p/src/a.ts:2-2");
		expect(flag("--incrementalFile")).toMatch(/\/melian-static-[^/]+\/incremental\/incremental\.json$/);
		expect(result.log.runs[0].tool.driver).toEqual({ name: "Stryker", version: "10.0.0" });
		expect(result.baseLog?.runs).toEqual([{ tool: { driver: { name: "Stryker", version: "10.0.0" } }, results: [] }]);
		expect(result.notes).toContain("Stryker mutated 1 changed lines in 1 file(s); the base was not mutated.");
		expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		expect(gitIn(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
	});

	it("lets a second run read the first run's incremental identities", async () => {
		const { base, head } = twoCommits();
		const reads = join(artifacts, "incremental-reads.txt");
		fakeTool(
			repo,
			"stryker",
			`
if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--incrementalFile" ]; then shift; incremental="$1"; fi
  shift
done
if [ -e "$incremental" ]; then cat "$incremental" >> '${reads}'; fi
printf '%s' '{"schemaVersion":"1.0","files":{}}' > "$incremental"
mkdir -p reports/mutation
cp "$incremental" reports/mutation/mutation.json`,
		);
		await mutate(base, head);
		expect(existsSync(reads)).toBe(false);
		await mutate(base, head);
		expect(readFileSync(reads, "utf8")).toBe('{"schemaVersion":"1.0","files":{}}');
	});

	// A fake Stryker that appends what it finds in its incremental file to a log, then writes one of its own.
	function incrementalTool(stamp = "written") {
		const reads = join(artifacts, "incremental-reads.txt");
		fakeTool(
			repo,
			"stryker",
			`
if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--incrementalFile" ]; then shift; incremental="$1"; fi
  shift
done
if [ -e "$incremental" ]; then cat "$incremental" >> '${reads}'; echo >> '${reads}'; fi
printf '%s' '{"stamp":"${stamp}"}' > "$incremental"
mkdir -p reports/mutation
printf '%s' '{"schemaVersion":"1.0","files":{}}' > reports/mutation/mutation.json`,
		);
		return () => (existsSync(reads) ? readFileSync(reads, "utf8").trimEnd().split("\n") : []);
	}
	const partitions = () => {
		const root = join(repo, ".git", "melian", "mutation");
		return existsSync(root) ? readdirSync(root).map((name) => join(root, name, "incremental.json")) : [];
	};

	it("keys the cache by the review's policy commit, or by the base when it names none", async () => {
		const cache = vi.spyOn(MutationCache, "open");
		const { base, head } = twoCommits();
		incrementalTool();
		await mutate(base, head);
		await mutate(base, head, { policyCommit: head });
		expect(cache.mock.calls.map(([, key]) => key.policy)).toEqual([base, head]);
	});

	it("reuses identities for the same head and inputs only", async () => {
		const { base, head } = twoCommits();
		const reads = incrementalTool();
		await mutate(base, head);
		expect(reads()).toEqual([]);
		await mutate(base, head);
		expect(reads()).toEqual(['{"stamp":"written"}']);
		const next = commit(repo, { "NOTES.md": "a later head with the same changed lines\n" });
		await mutate(base, next);
		expect(reads()).toEqual(['{"stamp":"written"}']);
		expect(partitions()).toHaveLength(2);
	});

	it("starts cold at the same head after the checkout lockfile changes", async () => {
		const { base, head } = twoCommits();
		const reads = incrementalTool();
		writeFileSync(join(repo, "package-lock.json"), "{}");
		await mutate(base, head);
		await mutate(base, head);
		expect(reads()).toEqual(['{"stamp":"written"}']);
		writeFileSync(join(repo, "package-lock.json"), '{"packages":{"new":{}}}');
		await mutate(base, head);
		expect(reads()).toEqual(['{"stamp":"written"}']);
		expect(partitions()).toHaveLength(2);
	});

	it("gives a run with other Stryker input another partition", async () => {
		const { base, head } = twoCommits();
		const reads = incrementalTool();
		await mutate(base, head, { maxLines: 100 });
		await mutate(base, head, { maxLines: 100 });
		expect(reads()).toHaveLength(1);
		fakeTool(
			repo,
			"stryker",
			`if [ "$1" = "--version" ]; then echo 10.0.1; exit 0; fi\nmkdir -p reports/mutation\nprintf '%s' '{"schemaVersion":"1.0","files":{}}' > reports/mutation/mutation.json`,
		);
		await mutate(base, head, { maxLines: 100 });
		expect(partitions()).toHaveLength(2);
	});

	it("publishes the run's identities only while the run still holds authority", async () => {
		const { base, head } = twoCommits();
		const reads = incrementalTool();
		await mutate(base, head, { holdsAuthority: async () => false });
		expect(partitions().filter((file) => existsSync(file))).toEqual([]);
		await mutate(base, head, { holdsAuthority: async () => true });
		expect(partitions().filter((file) => existsSync(file))).toHaveLength(1);
		expect(reads()).toEqual([]);
	});

	it("does not publish a run that failed", async () => {
		const { base, head } = twoCommits();
		fakeTool(
			repo,
			"stryker",
			`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\nwhile [ "$#" -gt 0 ]; do [ "$1" = "--incrementalFile" ] && { shift; printf '%s' '{}' > "$1"; }; shift; done\nexit 1`,
		);
		await expect(mutate(base, head)).rejects.toMatchObject({ code: "toolFailed" });
		expect(partitions().filter((file) => existsSync(file))).toEqual([]);
	});

	describe("Vitest selection inside the command", () => {
		it("resolves installed Vitest even when the head names itself vitest", async () => {
			const { base, head } = twoCommits({
				"packages/p/src/a.ts": a.replace("x > 0", "x >= 0"),
				"package.json": JSON.stringify({ name: "vitest", exports: { "./node": "./missing.js" } }),
			});
			const fake = stryker({ report: report({}) });
			expect((await mutate(base, head)).status).toBe("ran");
			expect(fake.calls()).toHaveLength(1);
		});
		function relatedInstall() {
			writeFiles(repo, {
				"node_modules/vitest/node.js": `import { resolve } from "node:path";
export async function createVitest(mode, options) {
 if (mode !== "test" || options.config !== "custom-vitest.ts" || options.dir !== "checks" || options.watch !== false || options.coverage.enabled !== false) throw new Error("wrong listing request");
 const config = {};
 return { config, close: async () => {}, getRelevantTestSpecifications: async () => {
   if (config.related === undefined) return ["checks/a[1].spec.ts", "checks/other.spec.ts"].map(moduleId => ({ moduleId: resolve(moduleId) }));
   if (JSON.stringify(config.related) !== JSON.stringify([resolve("packages/p/src/a.ts")])) throw new Error("wrong related files");
   return [{ moduleId: resolve("checks/a[1].spec.ts") }];
 } };
}`,
			});
		}

		it.each(["killed", "NoCoverage", "exit error", "missing report", "corrupt report"])(
			"hands Stryker Vitest's files and confirms %s with the whole suite when needed",
			async (kind) => {
				const { base, head } = twoCommits({
					"packages/p/src/a.ts": a.replace("x > 0", "x >= 0"),
					"stryker.config.json": JSON.stringify({
						testRunner: "vitest",
						vitest: { configFile: "custom-vitest.ts", dir: "checks", related: true },
						custom: "kept",
					}),
				});
				relatedInstall();
				const saved = join(artifacts, "attempts.jsonl");
				const script = join(artifacts, "runner.mjs");
				writeFileSync(
					script,
					`import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("10.0.0"); process.exit(0); }
const config = JSON.parse(readFileSync(args[1], "utf8"));
const incremental = args[args.indexOf("--incrementalFile") + 1];
appendFileSync(${JSON.stringify(saved)}, JSON.stringify({ config, incremental: existsSync(incremental) }) + "\\n");
const subset = config.testFiles.length > 0;
writeFileSync(incremental, JSON.stringify({ subset }));
mkdirSync("reports/mutation", { recursive: true });
if (subset && ${JSON.stringify(kind)} === "exit error") process.exit(1);
if (subset && ${JSON.stringify(kind)} === "missing report") process.exit(0);
writeFileSync("reports/mutation/mutation.json", subset && ${JSON.stringify(kind)} === "corrupt report" ? "{broken" : JSON.stringify({ schemaVersion: "1.0", files: { "packages/p/src/a.ts": { language: "typescript", source: "", mutants: [{ id: "1", status: subset && ${JSON.stringify(kind)} === "NoCoverage" ? "NoCoverage" : "Killed", mutatorName: "EqualityOperator", replacement: "x > 0", location: { start: { line: 2, column: 0 }, end: { line: 2, column: 5 } } }] } } }));`,
				);
				fakeTool(repo, "stryker", `exec '${process.execPath}' '${script}' "$@"`);
				const result = await mutate(base, head);
				if (result.status !== "ran") throw new Error("skipped");
				const attempts = readFileSync(saved, "utf8")
					.trim()
					.split("\n")
					.map(
						(line) =>
							JSON.parse(line) as {
								config: {
									testFiles: string[];
									vitest: { related: boolean; configFile: string; dir: string };
									custom: string;
								};
								incremental: boolean;
							},
					);
				expect(attempts[0]!.config).toMatchObject({
					testFiles: ["checks/a\\[1\\].spec.ts"],
					vitest: { related: false, configFile: "custom-vitest.ts", dir: "checks" },
					custom: "kept",
				});
				expect(result.notes[0]).toBe("Mutation tests use 1 related test file(s) selected by Vitest.");
				expect(result.log.runs[0].results).toEqual([]);
				expect(attempts).toHaveLength(kind === "killed" ? 1 : 2);
				if (kind !== "killed") {
					expect(attempts[1]!.config.testFiles).toEqual([]);
					expect(attempts[1]!.incremental).toBe(false);
					expect(result.notes[1]).toContain("whole suite");
				}
			},
		);

		// A head whose changed file Vitest relates to one test of two, and a fake Stryker that runs `body` with the number
		// of the attempt in `$attempt`.
		function relatedRun(body: string) {
			const commits = twoCommits({
				"packages/p/src/a.ts": a.replace("x > 0", "x >= 0"),
				"stryker.config.json": JSON.stringify({
					testRunner: "vitest",
					vitest: { configFile: "custom-vitest.ts", dir: "checks", related: true },
				}),
			});
			relatedInstall();
			const attempts = join(artifacts, "attempts.txt");
			fakeTool(
				repo,
				"stryker",
				`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
echo attempt >> '${attempts}'
attempt=$(wc -l < '${attempts}' | tr -d ' ')
${body}`,
			);
			return { ...commits, attempts: () => readFileSync(attempts, "utf8").trim().split("\n").length };
		}

		it.each(["mutation-runner.mjs", "tree/stryker.config.json"])(
			"does not repeat with the whole suite once %s is gone, and says another process removed it",
			async (lost) => {
				const run = relatedRun(`rm -f "$(dirname "$PWD")/${lost}"\necho RELATED FAILURE\nexit 1`);
				const failure = (await mutate(run.base, run.head).catch((error: unknown) => error)) as CheckError;
				expect(run.attempts()).toBe(1);
				expect(failure).toMatchObject({ code: "worktreeFailed", check: "static.mutation" });
				const scratch = /scratch directory (\S+) lost files/.exec(failure.message)?.[1];
				expect(scratch).toMatch(/\/melian-static-[^/]+$/);
				expect(failure.message).toBe(
					`static.mutation's scratch directory ${scratch} lost files while Stryker ran: ${scratch}/${lost} is gone. They were there when the run began, so another process removed them while it was in progress: most likely a Melian review of this clone from a build that does not recognise this run's lock, or else the head's own tests. Stryker exited 1.`,
				);
			},
		);

		it("fails with the path and the reason when it cannot write its runner", async () => {
			const { base, head } = twoCommits();
			const fake = stryker({ report: report({}) });
			const env = createNodeExecutionEnv(repo);
			const write = env.writeFile.bind(env);
			vi.spyOn(env, "writeFile").mockImplementation(async (path, content, writeContext) =>
				path.endsWith("mutation-runner.mjs")
					? ({ ok: false, error: new Error("disk full") } as Awaited<ReturnType<ExecutionEnv["writeFile"]>>)
					: write(path, content, writeContext),
			);
			const failure = (await mutate(base, head, { env }).catch((error: unknown) => error)) as CheckError;
			expect(failure).toMatchObject({ code: "worktreeFailed", check: "static.mutation" });
			expect(failure.message).toMatch(/^could not write \S+\/mutation-runner\.mjs: disk full$/);
			expect(fake.calls()).toEqual([]);
		});

		it("names both files when the whole scratch was emptied, and that Stryker did not finish when it was cut", async () => {
			// The whole tree goes, as when another build's cleanup removes it.
			const run = relatedRun('rm -f "$(dirname "$PWD")/mutation-runner.mjs"\nrm -rf "$PWD"\nexit 1');
			const execute = vi.mocked(MutationProcess.prototype.execute).getMockImplementation()!;
			vi.spyOn(MutationProcess.prototype, "execute").mockImplementation(async function (
				this: MutationProcess,
				command,
			) {
				await execute.call(this, command);
				throw this.run.fail("timeout", "mutation ran past its 120-second timeout");
			});
			const failure = (await mutate(run.base, run.head).catch((error: unknown) => error)) as CheckError;
			expect(failure).toMatchObject({ code: "worktreeFailed" });
			expect(failure.message).toMatch(
				/lost files while Stryker ran: \S+\/mutation-runner\.mjs and \S+\/tree\/stryker\.config\.json are gone\. .* Stryker did not finish\.$/,
			);
		});

		it("does not take a runner or configuration the reader refuses for a lost one", async () => {
			const run = relatedRun(
				'rm -f "$(dirname "$PWD")/mutation-runner.mjs" stryker.config.json\nmkdir "$(dirname "$PWD")/mutation-runner.mjs" stryker.config.json\necho RELATED FAILURE\nexit 1',
			);
			await expect(mutate(run.base, run.head)).rejects.toMatchObject({
				code: "toolFailed",
				message: expect.stringContaining("RELATED FAILURE"),
			});
		});

		it("ends when the supervisor ends it, and starts no second Stryker once the first has been stopped", async () => {
			// The first Stryker ends its own parent, the runner, as the supervisor does at a timeout, then exits as an
			// interrupted Stryker does. It signals that one process, by pid, and only after checking it is the runner.
			const run = relatedRun(
				`if [ "$attempt" = 1 ]; then
  case "$(ps -o command= -p "$PPID")" in *mutation-runner.mjs*) ;; *) exit 9 ;; esac
  kill -TERM "$PPID"
  sleep 0.5
fi
exit 1`,
			);
			// A listing library that takes SIGTERM for itself, as Vitest does, leaves the runner alive unless it ends itself.
			const listing = join(repo, "node_modules/vitest/node.js");
			writeFileSync(listing, `process.on("SIGTERM", () => {});\n${readFileSync(listing, "utf8")}`);
			await expect(mutate(run.base, run.head)).rejects.toMatchObject({ code: "invalidOutput" });
			expect(run.attempts()).toBe(1);
		});

		it("keeps the related run's failure when the whole suite fails after it with more output than a message holds", async () => {
			const run = relatedRun(
				`if [ "$attempt" = 1 ]; then echo RELATED FAILURE; exit 1; fi\nyes x | tr -d '\\n' | head -c 5000\necho WHOLE FAILURE\nexit 1`,
			);
			const failure = (await mutate(run.base, run.head).catch((error: unknown) => error)) as CheckError;
			expect(run.attempts()).toBe(2);
			expect(failure).toMatchObject({ code: "toolFailed" });
			expect(failure.message).toMatch(
				/^Stryker exited 1: RELATED FAILURE\n\[melian\] the related tests did not settle the run; the whole suite follows\nx{4082}WHOLE FAILURE$/,
			);
		});

		it.each([
			[4096, true],
			[4097, false],
		])("keeps the last 4,096 characters of the related run's output (%s)", async (length, whole) => {
			const run = relatedRun(
				`if [ "$attempt" = 1 ]; then printf FIRST; yes x | tr -d '\\n' | head -c ${length - 9}; printf LAST; exit 1; fi\necho WHOLE FAILURE\nexit 1`,
			);
			const failure = (await mutate(run.base, run.head).catch((error: unknown) => error)) as CheckError;
			const related = failure.message.slice("Stryker exited 1: ".length).split("\n[melian]")[0]!;
			expect(related).toBe(`FIRST${"x".repeat(length - 9)}LAST`.slice(-4096));
			expect(related.startsWith("FIRST")).toBe(whole);
		});

		it("fails as toolFailed when Stryker cannot spawn", async () => {
			const { base, head } = twoCommits();
			stryker();
			const execute = vi.mocked(MutationProcess.prototype.execute).getMockImplementation()!;
			vi.spyOn(MutationProcess.prototype, "execute").mockImplementation(async function (
				this: MutationProcess,
				command,
			) {
				rmSync(join(repo, "node_modules/.bin/stryker"));
				return execute.call(this, command);
			});
			await expect(mutate(base, head)).rejects.toMatchObject({
				code: "toolFailed",
				message: expect.stringContaining("Stryker exited 1"),
			});
		});
	});

	it("runs Stryker with the environment every static tool gets, and none of the Melian process's other variables", async () => {
		const { base, head } = twoCommits();
		const seen = join(artifacts, "seen.txt");
		fakeTool(
			repo,
			"stryker",
			`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
printf '%s\\n' "$(pwd)" "$HOME" "\${MELIAN_CANARY:-unset}" "\${MELIAN_MUTATION:-unset}" > '${seen}'
mkdir -p reports/mutation
echo '{"files":{}}' > reports/mutation/mutation.json`,
		);
		process.env.MELIAN_CANARY = "a-secret";
		try {
			await mutate(base, head);
		} finally {
			delete process.env.MELIAN_CANARY;
		}
		const [cwd, home, canary, marker] = readFileSync(seen, "utf8").trimEnd().split("\n");
		expect(cwd).toMatch(/\/melian-static-[^/]+\/tree$/);
		expect(home).toBe(process.env.HOME);
		expect(canary).toBe("unset");
		// The one variable the run adds, so a test that starts Stryker itself knows not to.
		expect(marker).toBe("1");
	});

	it.each(["../stryker.log", "reports/mutation/mutation.json"])(
		"refuses a head-written output link at %s without exposing its target",
		async (name) => {
			const { base, head } = twoCommits();
			const secret = join(artifacts, "host-secret");
			writeFileSync(secret, "secret-only-on-host");
			fakeTool(
				repo,
				"stryker",
				`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
mkdir -p reports/mutation
rm -f '${name}'
ln -s '${secret}' '${name}'
exit 0`,
			);
			const error = await mutate(base, head).catch((error: unknown) => error);
			expect(error).toMatchObject({
				code: "toolFailed",
				message: expect.stringContaining("is a symbolic link, not a file"),
			});
			expect(String(error)).toContain(name.replace("../", ""));
			expect(String(error)).not.toContain("secret-only-on-host");
			expect(readFileSync(secret, "utf8")).toBe("secret-only-on-host");
		},
	);

	it("does not link the caches a tool writes into node_modules, so a write lands in the worktree, not the checkout", async () => {
		const { base, head } = twoCommits();
		const seen = join(artifacts, "modules.txt");
		for (const directory of [".vite-temp", ".vite", ".cache", "pkg"])
			mkdirSync(join(repo, "node_modules", directory), { recursive: true });
		fakeTool(
			repo,
			"stryker",
			`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
for entry in .bin pkg .vite-temp .vite .cache; do
  if [ -L node_modules/$entry ]; then echo "$entry link"; elif [ -e node_modules/$entry ]; then echo "$entry directory"; else echo "$entry absent"; fi
done > '${seen}'
mkdir -p reports/mutation
echo '{"files":{}}' > reports/mutation/mutation.json`,
		);
		await mutate(base, head);
		expect(readFileSync(seen, "utf8").trimEnd().split("\n")).toEqual([
			".bin link",
			"pkg link",
			".vite-temp absent",
			".vite absent",
			".cache absent",
		]);
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

		it("answers a change with no production line before it adds a worktree or looks for Stryker", async () => {
			const base = commit(repo, { "stryker.config.json": config, "packages/p/src/a.ts": a });
			const head = commit(repo, { "README.md": "docs only\n" });
			const env = createNodeExecutionEnv(repo);
			const execute = vi.spyOn(env, "exec");
			expect(await mutate(base, head, { env })).toEqual({
				status: "skipped",
				reason: mutationSkips.noProductionLines,
				cause: "noProductionLines",
			});
			expect(execute).not.toHaveBeenCalled();
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

		it.each([
			["packages/p/src/rules.config.ts", mutationUnmutated.configuration],
			["packages/pipeline/src/static.ts", mutationUnmutated.signals],
			["packages/p/src/a,b.ts", mutationUnmutated.comma],
		])(
			"raises an unmutated finding for %s when another file is mutated and its mutants die",
			async (path, reason) => {
				const base = commit(repo, { "stryker.config.json": config, [path]: lines("export const kept = 1;") });
				const head = commit(repo, {
					"packages/p/src/a.ts": a,
					[path]: lines("export const kept = 1;", "export function guard(x: number) {", "  return x > 0;", "}"),
				});
				stryker({ report: report({ "packages/p/src/a.ts": [{ status: "Killed", line: 2 }] }) });
				const result = await mutate(base, head);
				if (result.status !== "ran") throw new Error("skipped");
				expect(result.log.runs[0].results).toEqual([
					expect.objectContaining({
						ruleId: "unmutated",
						level: "error",
						message: { text: `Stryker did not judge lines 2-4 of ${path}: ${reason.why}.` },
						advice: expect.objectContaining({ whatToDo: reason.whatToDo }),
					}),
				]);
				const raised = await found(base, head);
				expect(
					raised.map((finding) => [finding.ruleId, finding.properties.severity, finding.properties.path]),
				).toEqual([["mutation/unmutated", "P2", path]]);
			},
		);

		it("names a file it set aside in the finding a run past its timeout raises", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": a,
				"packages/p/src/rules.config.ts": lines("export const x = 1;"),
			});
			stryker({ report: report({}) });
			strykerTimesOut();
			const result = await mutate(base, head);
			if (result.status !== "skipped") throw new Error("ran");
			expect(result.log?.runs[0].results.map((each) => each.message.text)).toEqual([
				`Stryker did not judge the changed lines of packages/p/src/a.ts, packages/p/src/rules.config.ts: ${mutationSkips.timeout(120)}.`,
			]);
		});

		it("says nothing of a test file, a declaration, or a verifier file changed beside the production files it mutates", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": a,
				"packages/p/test/a.test.ts": lines("// tests a"),
				"packages/p/src/types.d.ts": lines("export type T = number;"),
				"packages/evals/verifier/case/src/user.ts": lines("export const user = 1;"),
			});
			stryker({ report: report({}) });
			const result = await mutate(base, head);
			if (result.status !== "ran") throw new Error("skipped");
			expect(result.notes.filter((note) => note.includes(" was not mutated: "))).toEqual([]);
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

			it("raises no finding for those files beside a production change it mutates", async () => {
				const base = commit(repo, {
					"stryker.config.json": config,
					"packages/p/src/a.ts": a,
					"packages/p/src/gone.ts": binary,
				});
				stryker({ report: report({}) });
				const head = commitTo(
					repo,
					{
						"packages/p/src/a.ts": a.replace("x > 0", "x >= 0"),
						"packages/p/test/blob.test.ts": "\0\0 a test, unlike the deleted file\0",
						"packages/p/src/image.png": "\0PNG\0",
					},
					["packages/p/src/gone.ts"],
				);
				expect(await found(base, head)).toEqual([]);
			});

			it("judges a change only by a production file that is still there", () => {
				const file = (path: string, status: "added" | "deleted" = "added") => ({
					status,
					path,
					binary: true,
					hunks: [],
				});
				const judges = (...files: ReturnType<typeof file>[]) =>
					MutationRun.judges(Revision.from({ base: "b", head: "h", files }));
				expect(judges(file(path), file("packages/p/test/blob.test.ts"))).toBe(true);
				expect(judges(file(path, "deleted"))).toBe(false);
				expect(judges(file("packages/p/test/blob.test.ts"))).toBe(false);
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
						headCode: "trusted",
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
				stryker({ report: report({}) });
				strykerTimesOut();
				const result = await mutate(base, head);
				if (result.status !== "skipped") throw new Error("ran");
				expect(result.log?.runs[0].results.map((each) => each.message.text).join()).toContain(
					`packages/p/src/a.ts, ${path}`,
				);
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

		it("mutates a change of exactly the bound whole, and cuts one line past it at the bound, with one advisory naming the omitted count and budget", async () => {
			const fake = stryker({ report: report({}) });
			const bound = head(5, "bound");
			expect(await leftOut(bound.base, bound.head, 5)).toEqual([]);
			expect(lastEntries(fake)).toEqual(["packages/p/src/bound.ts:1-5"]);
			const past = head(6, "past");
			expect(await leftOut(past.base, past.head, 5)).toEqual([
				[
					"packages/p/src/past.ts",
					"P3",
					"Stryker left 1 changed production lines unmutated by maintainer policy: budget: 1 (static.mutation.maxLines is 5).",
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
			expect(await leftOut(base, head, 11)).toEqual([
				[
					"packages/p/src/a.ts",
					"P3",
					"Stryker left 11 changed production lines unmutated by maintainer policy: budget: 11 (static.mutation.maxLines is 11).",
				],
			]);
		});

		it("takes a missing share from the first largest donor when donors tie", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": rows("a", 49),
				"packages/p/src/b.ts": rows("b", 49),
				"packages/p/src/z.ts": rows("z", 1),
			});
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 20 });
			expect(lastEntries(fake)).toEqual([
				"packages/p/src/a.ts:1-9",
				"packages/p/src/b.ts:1-10",
				"packages/p/src/z.ts:1-1",
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

		it("orders spare lines by fractional remainder rather than file size", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, { "packages/p/src/a.ts": rows("a", 5), "packages/p/src/b.ts": rows("b", 3) });
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 5 });
			expect(lastEntries(fake)).toEqual(["packages/p/src/a.ts:1-3", "packages/p/src/b.ts:1-2"]);
		});

		it("allocates by changed range lengths rather than their line numbers", async () => {
			const original = Array.from({ length: 10 }, (_, index) => `export const a${index} = ${index};`);
			const base = commit(repo, { "stryker.config.json": config, "packages/p/src/a.ts": lines(...original) });
			const head = commit(repo, {
				"packages/p/src/a.ts": lines(...original.map((row, index) => (index >= 7 ? `${row} // changed` : row))),
				"packages/p/src/b.ts": rows("b", 3),
			});
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 4 });
			expect(lastEntries(fake)).toEqual(["packages/p/src/a.ts:8-9", "packages/p/src/b.ts:1-2"]);
		});

		it("takes a missing file share from the largest donor even when it sorts last", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": rows("a", 1),
				"packages/p/src/b.ts": rows("b", 1),
				"packages/p/src/z.ts": rows("z", 98),
			});
			const fake = stryker({ report: report({}) });
			await mutate(base, head, { maxLines: 20 });
			expect(lastEntries(fake)).toEqual([
				"packages/p/src/a.ts:1-1",
				"packages/p/src/b.ts:1-1",
				"packages/p/src/z.ts:1-18",
			]);
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
				"Stryker left 2 changed production lines unmutated by maintainer policy: budget: 2 (static.mutation.maxLines is 2).",
			]);
			expect((await leftOut(base, head, 3)).map(([, , what]) => what)).toEqual([
				"Stryker left 1 changed production lines unmutated by maintainer policy: budget: 1 (static.mutation.maxLines is 3).",
			]);
		});

		it("names every file, those past the bound too, when the run passes its timeout", async () => {
			const base = commit(repo, { "stryker.config.json": config });
			const head = commit(repo, {
				"packages/p/src/a.ts": lines("export const a = 1;"),
				"packages/p/src/b.ts": lines("export const b = 1;"),
				"packages/p/src/c.ts": lines("export const c = 1;"),
			});
			stryker({ report: report({}) });
			strykerTimesOut();
			const result = await mutate(base, head, { maxLines: 1 });
			if (result.status !== "skipped") throw new Error("ran");
			expect(result.log?.runs[0].results.map((each) => each.message.text)).toEqual([
				`Stryker did not judge the changed lines of packages/p/src/a.ts, packages/p/src/b.ts, packages/p/src/c.ts: ${mutationSkips.timeout(120)}.`,
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

		it.each(["missing", "directory", "symlink"])(
			"names a %s log and retains supervisor stderr without following it",
			async (kind) => {
				const { base, head } = twoCommits();
				stryker({ report: report({}) });
				vi.spyOn(MutationProcess.prototype, "execute").mockResolvedValue({
					code: 1,
					output: "supervisor stderr: runner could not start",
				});
				const secret = join(repo, "outside-log");
				writeFileSync(secret, "HOST SECRET MUST NOT BE READ");
				const env = createNodeExecutionEnv(repo);
				const info = env.fileInfo.bind(env);
				vi.spyOn(env, "fileInfo").mockImplementation((path, at) => {
					if (path.endsWith("/stryker.log") && !existsSync(path)) {
						if (kind === "directory") mkdirSync(path);
						if (kind === "symlink") symlinkSync(secret, path);
					}
					return info(path, at);
				});
				const failure = await mutate(base, head, { env }).catch((error: unknown) => error);
				expect(failure).toMatchObject({ code: "toolFailed", check: "static.mutation" });
				expect(String(failure)).toContain("Stryker exited 1:");
				expect(String(failure)).toContain(
					{
						missing: "log missing",
						directory: "is a directory, not a file",
						symlink: "is a symbolic link, not a file",
					}[kind],
				);
				expect(String(failure)).toContain("stryker.log");
				expect(String(failure)).toContain("supervisor stderr: runner could not start");
				expect(String(failure)).not.toContain("HOST SECRET");
			},
		);

		it.each([4096, 4097])("bounds supervisor stderr when the log is missing (%s)", async (length) => {
			const { base, head } = twoCommits();
			stryker({ report: report({}) });
			const stderr = `FIRST${"x".repeat(length - 9)}LAST`;
			vi.spyOn(MutationProcess.prototype, "execute").mockResolvedValue({ code: 1, output: stderr });
			const failure = await mutate(base, head).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(CheckError);
			expect((failure as CheckError).message.split("\n").at(-1)).toBe(stderr.slice(-4096));
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
yes | head -c 20000000 > big.bin
[ "$(wc -c < big.bin | tr -d ' ')" = 20000000 ] || exit 9
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

		it("records a run that passes static.mutation.timeout as a skip without leave, with a finding that names the file", async () => {
			const { base, head } = twoCommits();
			stryker({ report: report({}) });
			strykerTimesOut();
			const result = await mutate(base, head);
			expect(result).toMatchObject({ status: "skipped", reason: mutationSkips.timeout(120), cause: "timeout" });
			expect(mutationSkipHasLeave("timeout")).toBe(false);
			if (result.status !== "skipped") throw new Error("ran");
			expect(result.log?.runs[0].results.map((each) => [each.ruleId, each.message.text])).toEqual([
				[
					"unmutated",
					`Stryker did not judge the changed lines of packages/p/src/a.ts: ${mutationSkips.timeout(120)}.`,
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
						headCode: "trusted",
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
printf 'START'; yes x | tr -d '\\n' | head -c 6000; printf 'END\\n'
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

		it("refuses a completed run without selection notes", async () => {
			const { base, head } = twoCommits();
			stryker({ report: report({}) });
			const read = Run.prototype.readOutput;
			vi.spyOn(Run.prototype, "readOutput").mockImplementation(async function (this: Run, path) {
				if (path.endsWith("/test-selection.json")) return undefined;
				return read.call(this, path);
			});
			await expect(mutate(base, head)).rejects.toMatchObject({
				code: "invalidOutput",
				message: expect.stringContaining("no test-selection notes"),
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

		it("is looked up before the head's tests run, so a file they remove or plant does not change it", async () => {
			const base = commit(repo, { "stryker.config.json": config, "packages/p/test/a.test.ts": "// t\n" });
			const head = commit(repo, { "packages/p/src/a.ts": lines("export const x = 1;") });
			const canned = join(artifacts, "survivor.json");
			writeFileSync(canned, report({ "packages/p/src/a.ts": [{ status: "Survived", line: 1 }] }));
			fakeTool(
				repo,
				"stryker",
				`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
rm packages/p/test/a.test.ts
echo planted > packages/p/src/a.test.ts
mkdir -p reports/mutation
cp '${canned}' reports/mutation/mutation.json`,
			);
			const [finding] = await found(base, head);
			expect(finding!.properties.explanation.whatToDo).toContain("in packages/p/test/a.test.ts so");
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

		const trusted: WriterTrust = { trusted: true, by: "checkout" };

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
					notes: [
						"Mutation tests use the whole suite: Vitest related no test to packages/p/src/a.ts.",
						"Stryker mutated 1 changed lines in 1 file(s); the base was not mutated.",
					],
				},
			]);
			const findings = await readFindings(harness, root.id, revisionKey({ base, head }), context);
			expect(findings.map((finding) => finding.ruleId)).toEqual(["mutation/untested-behaviour"]);
			expect(fake.calls()).toHaveLength(1);
			expect(fake.heads()).toEqual([head]);
		});

		it("records budget and ignoreStatic as one policy advisory with both counts", async () => {
			const base = commit(repo, {
				"melian.yaml": policy.replace("timeout: 120", "timeout: 120, maxLines: 1"),
				"stryker.config.json": config,
			});
			const head = commit(repo, { "packages/p/src/a.ts": a });
			stryker({
				report: report({ "packages/p/src/a.ts": [{ status: "Ignored", line: 1, outsideTests: true }] }, true),
			});
			const { harness, root, run } = await checks(base, head);
			expect(run.records).toMatchObject([{ status: "ran", findings: 1 }]);
			const findings = await readFindings(harness, root.id, revisionKey({ base, head }), context);
			expect(findings).toHaveLength(1);
			expect(findings[0]!.resolved(defaultConfig).properties.resolution).toBe("advisory");
			expect(findings[0]).toMatchObject({
				ruleId: "mutation/unmutated",
				properties: {
					severity: "P3",
					explanation: {
						what: "Stryker left 4 changed production lines unmutated by maintainer policy: budget: 3 (static.mutation.maxLines is 1); ignoreStatic: 1.",
					},
				},
			});
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
						"Mutation tests use the whole suite: Vitest related no test to packages/p/src/a.ts.",
						"Stryker mutated 1 changed lines in 1 file(s); the base was not mutated.",
						"packages/p/src/a.ts produced no mutants, so nothing on its changed lines was judged.",
					],
				},
			]);
			const [left] = await readFindings(harness, root.id, revisionKey({ base, head }), context);
			expect(left).toMatchObject({
				ruleId: "mutation/unmutated",
				properties: { path: "packages/p/src/a.ts", severity: "P3" },
			});
			expect(left!.properties.explanation.what).toBe(
				"Stryker left 3 changed production lines unmutated by maintainer policy: budget: 3 (static.mutation.maxLines is 1).",
			);
			expect(fake.calls()).toHaveLength(1);
		});

		it("records a run past its timeout as a skip with leave that still raises one P2 mutation/unmutated finding naming the files", async () => {
			const base = commit(repo, {
				"melian.yaml": policy,
				"stryker.config.json": config,
				"packages/p/src/a.ts": a,
				"packages/p/src/b.ts": a.replace("function a", "function b"),
			});
			const head = commit(repo, {
				"packages/p/src/a.ts": a.replace("x > 0", "x >= 0"),
				"packages/p/src/b.ts": a.replace("function a", "function b").replace("x > 0", "x >= 0"),
			});
			stryker({ report: report({}) });
			strykerTimesOut();
			const { harness, root, run } = await checks(base, head);
			expect(run.records).toEqual([
				{
					name: "static.mutation",
					status: "skipped",
					reason: mutationSkips.timeout(120),
					cause: "timeout",
				},
			]);
			const findings = await readFindings(harness, root.id, revisionKey({ base, head }), context);
			expect(
				findings.map((finding) => [finding.ruleId, finding.properties.severity, finding.properties.path]),
			).toEqual([["mutation/unmutated", "P2", "packages/p/src/a.ts"]]);
			expect(findings[0]!.properties.explanation.what).toContain("packages/p/src/a.ts, packages/p/src/b.ts");
		});

		it("runs a timed-out mutation check again on a rerun, and leaves a skip of any other cause as it is", async () => {
			const base = commit(repo, { "melian.yaml": policy, "stryker.config.json": config, "packages/p/src/a.ts": a });
			const head = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
			const fake = stryker({ report: report({}) });
			const { harness, root } = await open();
			const changeset = await Changeset.resolve(repo, `${base}..${head}`);
			const source: RepositorySource = { kind: "revision", commit: base };
			const { config: loaded } = await loadConfig(repo, source, "");
			const request = { rootConversationId: root.id, changeset, config: loaded, source, tier: "full" };
			const timedOut = vi.spyOn(MutationProcess.prototype, "execute").mockImplementationOnce(async function (
				this: MutationProcess,
			) {
				throw this.run.fail("timeout", "mutation ran past its 120-second timeout");
			});
			const first = await runChecks(harness, { ...request, writer: trusted }, context);
			expect(first.records).toMatchObject([{ status: "skipped", cause: "timeout" }]);
			expect(timedOut).toHaveBeenCalledOnce();
			// Asked again without --rerun, the stored skip stands; with it, Stryker runs.
			expect((await runChecks(harness, { ...request, writer: trusted }, context)).records).toEqual(first.records);
			expect(fake.calls()).toEqual([]);
			const again = await runChecks(harness, { ...request, writer: trusted, rerunFailed: true }, context);
			expect(again.records).toMatchObject([{ name: "static.mutation", status: "ran" }]);
			expect(fake.calls()).toHaveLength(1);
			// A refused head is a skip too, and a rerun does not repeat it: nothing about it has changed.
			const refusedWriter: WriterTrust = { trusted: false, detail: "the head is from a fork" };
			const refusedRun = await runChecks(harness, { ...request, writer: refusedWriter }, context);
			const rerun = await runChecks(harness, { ...request, writer: refusedWriter, rerunFailed: true }, context);
			expect(rerun.identity.task).toBe(refusedRun.identity.task);
			expect(fake.calls()).toHaveLength(1);
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

			it("runs nothing, and records a skip without leave that says why, for a head the host refused", async () => {
				const { base, head: tip } = head();
				const fake = stryker({ report: report({}) });
				const detail = "octocat has read permission on the repository";
				const { run } = await checks(base, tip, { trusted: false, detail });
				expect(run.records).toEqual([
					{
						name: "static.mutation",
						status: "skipped",
						reason: mutationSkips.headNotAllowed(detail),
						cause: "headNotAllowed",
					},
				]);
				expect(run.records[0]).toMatchObject({
					reason: expect.stringMatching(
						/^octocat has read permission on the repository; .* which arrives with the Actions host$/,
					),
				});
				expect(mutationSkipHasLeave((run.records[0] as { cause?: string }).cause)).toBe(false);
				expect(fake.calls()).toEqual([]);
			});

			it.each(["checkout", "writer"] as const)("runs for a head allowed by %s", async (by) => {
				const { base, head: tip } = head();
				const fake = stryker({ report: report({}) });
				const { run } = await checks(base, tip, { trusted: true, by });
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
						reason: mutationSkips.headNotAllowed("the review did not say whose code the head is"),
						cause: "headNotAllowed",
					},
				]);
				expect(fake.calls()).toEqual([]);
			});

			it("passes a change with nothing to judge for any head, before the guard and before looking for Stryker", async () => {
				const base = commit(repo, {
					"melian.yaml": policy,
					"stryker.config.json": config,
					"packages/p/src/a.ts": a,
				});
				const docs = commit(repo, { "README.md": "docs only\n", "packages/p/test/a.test.ts": "// t\n" });
				rmSync(join(repo, "node_modules/.bin/stryker"), { force: true });
				const skip = { status: "skipped", reason: mutationSkips.noProductionLines, cause: "noProductionLines" };
				const refusedRun = await checks(base, docs, { trusted: false, detail: "the head is from a fork" });
				expect(refusedRun.run.records).toEqual([{ name: "static.mutation", ...skip }]);
				expect((await checks(base, docs, trusted)).run.records).toEqual([{ name: "static.mutation", ...skip }]);
				// A change that does touch production code still needs both.
				const code = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
				expect((await checks(docs, code, trusted)).run.records).toEqual([
					{ name: "static.mutation", status: "skipped", reason: strykerNotInstalled },
				]);
			});

			describe("where the repository's policy does not trust writers", () => {
				const distrusting = () => {
					const base = commit(repo, {
						"melian.yaml": `trust: { writers: false }\n${policy}`,
						"stryker.config.json": config,
						"packages/p/src/a.ts": a,
					});
					return { base, tip: commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") }) };
				};

				it("skips a writer's head", async () => {
					const { base, tip } = distrusting();
					const fake = stryker({ report: report({}) });
					const { run } = await checks(base, tip, { trusted: true, by: "writer" });
					expect(run.records).toEqual([
						{
							name: "static.mutation",
							status: "skipped",
							reason: mutationSkips.headNotAllowed("trust.writers is false in the repository's policy"),
							cause: "headNotAllowed",
						},
					]);
					expect(fake.calls()).toEqual([]);
				});

				it("still runs the reviewer's own checkout", async () => {
					const { base, tip } = distrusting();
					const fake = stryker({ report: report({}) });
					const { run } = await checks(base, tip, { trusted: true, by: "checkout" });
					expect(run.records[0]).toMatchObject({ name: "static.mutation", status: "ran" });
					expect(fake.calls()).toHaveLength(1);
				});
			});

			it("runs again when the writer's trust changes", async () => {
				const { base, head: tip } = head();
				stryker({ report: report({}) });
				const trustedRun = (await checks(base, tip, { trusted: true, by: "checkout" })).run.identity.policy;
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

		it("runs again in the same storage when the Node runtime changes", async () => {
			const base = commit(repo, { "melian.yaml": policy, "stryker.config.json": config, "packages/p/src/a.ts": a });
			const tip = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
			const fake = stryker({ report: report({}) });
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
			const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
			try {
				const first = await again();
				expect((await again()).identity.task).toBe(first.identity.task);
				expect(fake.calls()).toHaveLength(1);
				Object.defineProperty(process.versions, "node", { ...descriptor, value: "26.0.0" });
				const switched = await again();
				expect(switched.identity.policy).not.toBe(first.identity.policy);
				expect(switched.identity.task).not.toBe(first.identity.task);
				expect(fake.calls()).toHaveLength(2);
			} finally {
				Object.defineProperty(process.versions, "node", descriptor);
			}
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
	});
});

// Reviews from several worktrees of one clone run at once, each from its own build, and each starts by removing stale
// worktrees across the whole clone. Main's build at 22a821b2 removes any `melian-static-*` tree whose lock it cannot read
// or whose locking process is gone, on the host, with a recursive delete.
describe("a build from before static.mutation", { timeout: 60_000 }, () => {
	// A mutation run whose fake Stryker has written to its log and waits. The fake gives up after thirty seconds by itself:
	// when the old build does delete its scratch nothing can release it, and it must not run on.
	async function parked() {
		const { base, head } = twoCommits();
		fakeTool(
			repo,
			"stryker",
			[
				'if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi',
				"echo stryker is parked",
				`echo started > '${join(artifacts, "started")}'`,
				"waited=0",
				`while [ ! -f '${join(artifacts, "release")}' ]; do sleep 0.05; waited=$((waited + 1)); [ "$waited" -lt 600 ] || exit 9; done`,
				"mkdir -p reports/mutation",
				`echo '${report({})}' > reports/mutation/mutation.json`,
			].join("\n"),
		);
		const running = mutate(base, head);
		const settled = running.catch(() => undefined);
		for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(20))
			if (existsSync(join(artifacts, "started"))) break;
		const registered = gitIn(repo, "worktree", "list", "--porcelain").split("\n\n")[1]?.split("\n") ?? [];
		const tree = registered[0]?.slice("worktree ".length) ?? "";
		const old = mkdtempSync(join(artifacts, "old-build-"));
		const oldCleanup = () =>
			removeStaleWorktreesV1(
				new RunV1(
					{
						env: createNodeExecutionEnv(repo),
						repoRoot: repo,
						commit: head,
						tool: "biome",
						settings: defaultConfig.static.biome,
					},
					context,
				),
				old,
			);
		const intact = () => {
			expect(readFileSync(join(dirname(tree), "stryker.log"), "utf8")).toBe("stryker is parked\n");
			expect(readFileSync(join(tree, "packages/p/src/a.ts"), "utf8")).toBe(a.replace("x > 0", "x >= 0"));
			expect(existsSync(join(dirname(tree), "mutation-runner.mjs"))).toBe(true);
		};
		const finish = async () => {
			writeFileSync(join(artifacts, "release"), "");
			await settled;
			return running;
		};
		return { registered, oldCleanup, intact, finish };
	}

	it("leaves a live mutation run's scratch, log, and tree alone, and the run finishes", async () => {
		const run = await parked();
		try {
			expect(run.registered).toContain(`locked melian-static pid ${process.pid}`);
			await run.oldCleanup();
			run.intact();
		} finally {
			await run.finish().catch(() => undefined);
		}
		expect(await run.finish()).toMatchObject({ status: "ran" });
		expect(gitIn(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
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
