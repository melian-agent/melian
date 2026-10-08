import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CheckError,
	type MutationSettings,
	mutationNotJudged,
	mutationSkips,
	mutationUnmutated,
	mutationUnmutatedLog,
	normaliseMutationReport,
	type Revision,
	type ToolLog,
} from "@melian-agent/core";
import { backgroundContext } from "./harness.ts";
import { MutationCache } from "./mutation-cache.ts";
import { type MutationTestSelection, MutationTests } from "./mutation-tests.ts";
import { nodeInstallation, type Sandbox } from "./sandbox.ts";
import type { Run, StaticRun } from "./static.ts";
import { CacheLocation } from "./tool-provisioning.ts";

const config = "stryker.config.json";

// The head's own tests run under this limit, and some write files past `staticOutputLimit`: Melian's own cache tests write
// 128 MiB archives, and a limit of 16 MiB ended their processes with SIGXFSZ and failed Stryker's initial run. A runaway
// write is what this stops, so it is set above what a test suite writes. bash counts 1,024-byte blocks.
const mutationFileLimit = 1024 * 1024 * 1024;
const report = "reports/mutation/mutation.json";

// Production TypeScript is what the tests are there to hold; a test, a fixture, a golden or verifier corpus, built output,
// or a declaration file is not. A `.config.ts` is production: it can hold logic. It is not mutated, though, because a tool
// loads it to run the mutants, so a change to one is a file the run did not judge.
const typescript = /\.[cm]?tsx?$/;
const notProduction = /\.(?:d|test|spec)\.[cm]?tsx?$/;
const configuration = /\.config\.[cm]?tsx?$/;
const notProductionPrefix = "packages/evals/verifier/";
const notProductionDirectories: ReadonlySet<string> = new Set([
	"test",
	"tests",
	"__tests__",
	"__mocks__",
	"fixtures",
	"goldens",
	"dist",
	"node_modules",
]);

function production(path: string): boolean {
	return (
		typescript.test(path) &&
		!notProduction.test(path) &&
		!path.startsWith(notProductionPrefix) &&
		!posix
			.dirname(path)
			.split("/")
			.some((segment) => notProductionDirectories.has(segment))
	);
}

function mutable(path: string): boolean {
	return production(path) && !configuration.test(path);
}

// Stryker reads each `--mutate` entry as a glob, so a file name with a glob character in it, such as `[id]` or `(group)`
// in a Next.js route, names other files or none unless each character is escaped.
function literal(path: string): string {
	return path.replace(/[\\*?[\]{}()!+@#]/g, "\\$&");
}

// How many of its lines each file may have mutated when the change is past the bound. Problem: taking the first lines in path
// order let an author spend the bound on harmless lines in files that sort early and leave a risky file last in path order
// unjudged. Solution: every file gets a share in proportion to its changed lines, by largest remainder with ties in path
// order, and no file is left with none while the bound has a line for each.
function shares(sizes: ReadonlyMap<string, number>, maxLines: number): Map<string, number> {
	const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
	const share = new Map<string, number>();
	const remainder = new Map<string, number>();
	for (const [path, size] of sizes) {
		share.set(path, Math.floor((maxLines * size) / total));
		remainder.set(path, (maxLines * size) % total);
	}
	const paths = [...sizes.keys()];
	const byRemainder = [...paths].sort((x, y) => remainder.get(y)! - remainder.get(x)!);
	let spare = maxLines - [...share.values()].reduce((sum, each) => sum + each, 0);
	for (const path of byRemainder) {
		if (spare === 0) break;
		share.set(path, share.get(path)! + 1);
		spare--;
	}
	if (paths.length <= maxLines) {
		for (const path of paths.filter((each) => share.get(each) === 0)) {
			const donor = paths.reduce((most, each) => (share.get(each)! > share.get(most)! ? each : most));
			share.set(donor, share.get(donor)! - 1);
			share.set(path, 1);
		}
	}
	return share;
}

// The lines the run mutates, and the lines it leaves out, when the change has more than `maxLines`. A range the file's
// share falls in is cut at it.
function withinBound(
	lines: Readonly<Record<string, readonly (readonly [number, number])[]>>,
	maxLines: number,
): { kept: Record<string, [number, number][]>; omitted: Record<string, [number, number][]> } {
	const sizes = new Map(
		Object.entries(lines).map(([path, ranges]) => [
			path,
			ranges.reduce((sum, [first, last]) => sum + last - first + 1, 0),
		]),
	);
	const kept: Record<string, [number, number][]> = {};
	const omitted: Record<string, [number, number][]> = {};
	const share = shares(sizes, maxLines);
	for (const [path, ranges] of Object.entries(lines)) {
		let room = share.get(path)!;
		for (const [first, last] of ranges) {
			const taken = Math.min(room, last - first + 1);
			if (taken > 0) kept[path] = [...(kept[path] ?? []), [first, first + taken - 1]];
			if (taken < last - first + 1) omitted[path] = [...(omitted[path] ?? []), [first + taken, last]];
			room -= taken;
		}
	}
	return { kept, omitted };
}

function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Why a checkout with no Stryker install gets no mutation run: Melian carries no copy of its own. */
export const strykerNotInstalled =
	"Stryker is not installed in the checkout, and Melian carries none: add @stryker-mutator/core and @stryker-mutator/vitest-runner to the reviewed repository's dev dependencies";

/**
 * The version of `@stryker-mutator/core` the checkout has installed, else `unavailable`. A run's identity holds it, so a
 * bump runs the check again.
 */
export function strykerVersion(repoRoot: string): string {
	try {
		const file = posix.join(repoRoot, "node_modules/@stryker-mutator/core/package.json");
		const { version } = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
		if (typeof version === "string") return version;
	} catch {
		// An absent install is not an error here: the run itself skips when it finds no Stryker.
	}
	return "unavailable";
}

/**
 * Mutation testing of one revision's changed lines: Stryker on Vitest, run in the head's worktree. A mutant that no test
 * caught, on a line the change added or edited, becomes a result of rule `untested-behaviour`.
 */
export class MutationRun {
	readonly #run: Run;
	readonly #root: string;
	readonly #scratch: string;
	readonly #binary: string;
	readonly #version: string;
	readonly #notes: string[];
	readonly #sandbox: Sandbox;
	readonly #installs: readonly string[];

	constructor(
		run: Run,
		root: string,
		scratch: string,
		binary: string,
		version: string,
		notes: string[],
		sandbox: Sandbox,
		installs: readonly string[],
	) {
		this.#run = run;
		this.#root = root;
		this.#scratch = scratch;
		this.#binary = binary;
		this.#version = version;
		this.#notes = notes;
		this.#sandbox = sandbox;
		this.#installs = installs;
	}

	// The changed production lines, and the paths set aside because Stryker's comma-separated `--mutate` cannot name them.
	#targets(revision: Revision): Record<string, [number, number][]> {
		const targets: Record<string, [number, number][]> = {};
		for (const [path, ranges] of Object.entries(revision.diffLines())) {
			if (!mutable(path)) {
				if (production(path))
					this.#notes.push(`${path} was not mutated: a tool loads a configuration file to run the mutants.`);
				continue;
			}
			if (path.includes(",")) {
				this.#notes.push(`${path} was not mutated: Stryker cannot take a path with a comma.`);
				continue;
			}
			targets[path] = ranges;
		}
		return targets;
	}

	// The production files the revision changes that `diffLines` cannot address: git calls them binary, or their names are not
	// UTF-8. They hold no line Stryker can be asked about, so the check cannot read them as having no production code.
	#unaddressable(revision: Revision): string[] {
		return revision.files
			.filter((file) => file.status !== "deleted" && (file.binary || file.percentEncoded === true))
			.map((file) => file.path)
			.filter(production);
	}

	// The test file that tests `path`, found beside it or under its package's `test` directory, and otherwise the one to add.
	async #nearestTest(path: string): Promise<string> {
		const name = posix.basename(path).replace(typescript, "");
		const segments = posix.dirname(path).split("/");
		const candidates = [posix.join(...segments, `${name}.test.ts`)];
		const source = segments.lastIndexOf("src");
		if (source !== -1) {
			const tests = [...segments.slice(0, source), "test"];
			candidates.push(posix.join(...tests, ...segments.slice(source + 1), `${name}.test.ts`));
			candidates.push(posix.join(...tests, `${name}.test.ts`));
		}
		for (const candidate of candidates)
			if (await this.#run.exists(posix.join(this.#root, candidate))) return candidate;
		return `a new ${candidates.at(-1)}`;
	}

	// The worktree's `.git` file names the checkout's git directory, which the sandbox hides, so a test that asks git about the
	// tree it runs in would fail. For the run the tree holds a repository of its own, shallow at the head, with none of the
	// checkout's configuration or history; `restore` puts the link back so git can remove the worktree.
	async #ownGit(): Promise<() => Promise<void>> {
		const { env, repoRoot, commit } = this.#run.input;
		const file = posix.join(this.#root, ".git");
		const link = await env.readTextFile(file, this.#run.context);
		if (!link.ok) throw this.#run.fail("worktreeFailed", `could not read ${file}: ${link.error.message}`);
		// Cleanup runs even when the caller cancelled, so it takes no caller context, as removing the worktree does.
		const restore = async () => {
			await env.remove(file, { recursive: true, force: true }, backgroundContext);
			await env.writeFile(file, link.value, backgroundContext);
		};
		const upload = quote("git -c uploadpack.allowAnySHA1InWant=true upload-pack");
		const git = (args: string) => this.#run.git(args, this.#root);
		try {
			const made = await this.#run.shell(
				[
					"set -e",
					`rm -f ${quote(file)}`,
					git("init --quiet --template="),
					git(
						`fetch --quiet --no-tags --depth=1 --upload-pack=${upload} ${quote(`file://${repoRoot}`)} ${commit}`,
					),
					git(`update-ref --no-deref HEAD ${commit}`),
					git("read-tree HEAD"),
				].join("\n"),
			);
			if (made.code !== 0) {
				throw this.#run.fail(
					"worktreeFailed",
					`could not give the worktree a git directory of its own: ${made.output}`,
				);
			}
		} catch (error) {
			await restore();
			throw error;
		}
		return restore;
	}

	async #uncovered(lines: Record<string, [number, number][]>): Promise<string> {
		const instrumenter = createRequire(posix.join(this.#run.input.repoRoot, "package.json")).resolve(
			"@stryker-mutator/instrumenter",
		);
		const script = posix.join(this.#scratch, "uncovered.mjs");
		const text = `
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Instrumenter } from ${JSON.stringify(pathToFileURL(instrumenter).href)};
const lines = ${JSON.stringify(lines)};
const config = JSON.parse(readFileSync("stryker.config.json", "utf8"));
const logger = Object.fromEntries(["trace", "debug", "info", "warn", "error", "fatal"].flatMap(name => [[name, () => {}], ["is" + name[0].toUpperCase() + name.slice(1) + "Enabled", () => false]]));
const files = Object.entries(lines).map(([name, ranges]) => ({ name, content: readFileSync(name, "utf8"), mutate: ranges.map(([first, last]) => ({ start: { line: first - 1, column: 0 }, end: { line: last - 1, column: Number.MAX_SAFE_INTEGER } })) }));
const result = await new Instrumenter(logger).instrument(files, { plugins: null, ignorers: [], excludedMutations: config.mutator?.excludedMutations ?? [] });
const report = { schemaVersion: "1.0", config, files: Object.fromEntries(files.map(file => [file.name, { language: "typescript", source: file.content, mutants: result.mutants.filter(mutant => mutant.fileName === file.name).map(mutant => ({ ...mutant, status: mutant.status ?? "NoCoverage", location: { start: { ...mutant.location.start, line: mutant.location.start.line + 1 }, end: { ...mutant.location.end, line: mutant.location.end.line + 1 } } })) }])) };
mkdirSync("reports/mutation", { recursive: true });
writeFileSync("reports/mutation/mutation.json", JSON.stringify(report));
`;
		const written = await this.#run.input.env.writeFile(script, text, this.#run.context);
		if (!written.ok) throw this.#run.fail("toolFailed", `could not write ${script}: ${written.error.message}`);
		return `${quote(process.execPath)} ${quote(script)}`;
	}

	// The run executes the head's own test files, setup files, and Vitest configuration, so it gets a home and a temporary
	// directory of its own in scratch, where the reviewer's credential files are not, and none of the Melian process's
	// variables. It also runs in the host's sandbox: no network, and nothing readable or writable outside the worktree,
	// scratch, and the installs it needs.
	async #execute(
		entries: readonly string[],
		selection: MutationTestSelection,
		lines: Record<string, [number, number][]>,
	): Promise<string | { skipped: string }> {
		const { repoRoot, policyCommit, base, commit, trustedWriter } = this.#run.input;
		const cache = await MutationCache.open(
			(await CacheLocation.open(repoRoot)).root,
			policyCommit ?? base ?? commit,
			trustedWriter === true,
		);
		const includeFile = posix.join(this.#scratch, "test-include.json");
		if ("include" in selection) {
			const written = await this.#run.input.env.writeFile(
				includeFile,
				JSON.stringify(selection.include.map(literal)),
				this.#run.context,
			);
			if (!written.ok)
				throw this.#run.fail("toolFailed", `could not write ${includeFile}: ${written.error.message}`);
		}
		const log = posix.join(this.#scratch, "stryker.log");
		const home = posix.join(this.#scratch, "home");
		const temporary = posix.join(this.#scratch, "tmp");
		// A report the revision committed must not stand in for the one this run writes.
		const runner =
			"tests" in selection && selection.tests.length === 0
				? await this.#uncovered(lines)
				: `${quote(this.#binary)} run ${quote(posix.join(this.#root, config))} --reporters json --incremental --incrementalFile ${quote(cache.file)} --inPlace --mutate ${quote(entries.join(","))}`;
		const command = [
			`mkdir -p ${quote(home)} ${quote(temporary)}`,
			`cd ${quote(this.#root)}`,
			`ulimit -f ${mutationFileLimit / 1024}`,
			`rm -f ${quote(report)}`,
			`${runner} > ${quote(log)} 2>&1`,
		].join(" && ");
		const paths = {
			worktree: this.#root,
			scratch: this.#scratch,
			installs: this.#installs,
			node: nodeInstallation(),
			incremental: cache.directory,
		};
		const profile = this.#sandbox.profile(paths);
		const profileFile = posix.join(this.#scratch, "sandbox.sb");
		if (profile !== undefined) {
			const written = await this.#run.input.env.writeFile(profileFile, profile, this.#run.context);
			if (!written.ok)
				throw this.#run.fail("toolFailed", `could not write ${profileFile}: ${written.error.message}`);
		}
		let result: Awaited<ReturnType<Run["shell"]>>;
		const restore = await this.#ownGit();
		try {
			result = await this.#run.shell(this.#sandbox.command(command, paths, profileFile), undefined, {
				...this.#sandbox.environment(),
				HOME: home,
				TMPDIR: temporary,
				...("include" in selection ? { MELIAN_MUTATION_TEST_INCLUDE: includeFile } : {}),
			});
		} catch (error) {
			// A change too slow to mutate is one the run could not judge, not one whose judgement failed.
			if (error instanceof CheckError && error.code === "timeout") {
				return { skipped: mutationSkips.timeout(this.#run.input.settings.timeout) };
			}
			throw error;
		} finally {
			await restore();
		}
		const output = ((await this.#run.readOutput(log)) ?? result.output).slice(-4096).trim();
		if (result.code === 1) throw this.#run.fail("toolFailed", `Stryker exited 1: ${output}`);
		if (result.code !== 0)
			throw this.#run.fail("invalidOutput", `Stryker exited ${result.code}, which it does not document: ${output}`);
		const text = await this.#run.readOutput(posix.join(this.#root, report));
		if (text === undefined) throw this.#run.fail("invalidOutput", `Stryker wrote no report at ${report}`);
		return text;
	}

	async check(): Promise<StaticRun> {
		const { revision, settings } = this.#run.input;
		if (revision === undefined) throw this.#run.fail("toolFailed", "mutation testing needs the revision it mutates");
		const changed = this.#targets(revision);
		const total = Object.values(changed).reduce(
			(sum, ranges) => sum + ranges.reduce((count, [first, last]) => count + last - first + 1, 0),
			0,
		);
		const binary = this.#unaddressable(revision).map((path) => ({
			path,
			ranges: [] as [number, number][],
			...mutationUnmutated.binary,
		}));
		if (total === 0) {
			// A production file that was changed but not mutated, such as a `.config.ts`, a path with a comma, or a binary file,
			// means the change did have behaviour to judge, so the skip has no leave.
			const held = [...Object.keys(revision.diffLines()).filter(production), ...binary.map((file) => file.path)];
			if (held.length === 0) {
				return { status: "skipped", reason: mutationSkips.noProductionLines, cause: "noProductionLines" };
			}
			return {
				status: "skipped",
				reason: mutationSkips.unmutated(held),
				cause: "unmutated",
				...(binary.length === 0 ? {} : { log: mutationUnmutatedLog(this.#version, binary) }),
			};
		}
		const { maxLines } = settings as MutationSettings;
		const { kept: lines, omitted } = withinBound(changed, maxLines);
		const count = Math.min(total, maxLines);
		const unmutated = [
			...Object.entries(omitted).map(([path, ranges]) => ({
				path,
				ranges,
				...mutationUnmutated.pastBound(maxLines),
			})),
			...binary,
		];
		if (!(await this.#run.exists(posix.join(this.#root, config))))
			throw this.#run.fail("toolFailed", `the revision has no ${config}, which Stryker needs`);
		const entries = Object.entries(lines).flatMap(([path, ranges]) =>
			ranges.map(([first, last]) => `${literal(path)}:${first}-${last}`),
		);
		const selection = (await MutationTests.open(this.#run, this.#root, this.#scratch, Object.keys(lines))).toJSON();
		this.#notes.push(selection.note);
		if ("tests" in selection && selection.tests.length === 0)
			this.#notes.push(
				"No test reaches the changed production files; no dry run was started. Their mutants are NoCoverage.",
			);
		const text = await this.#execute(entries, selection, lines);
		if (typeof text !== "string") {
			return {
				status: "skipped",
				reason: text.skipped,
				cause: "timeout",
				log: mutationNotJudged(
					{
						version: this.#version,
						lines: {
							...changed,
							...Object.fromEntries(binary.map((file) => [file.path, [[1, 1]] as [number, number][]])),
						},
					},
					text.skipped,
				),
			};
		}
		const tests: Record<string, string> = {};
		for (const path of Object.keys(lines)) tests[path] = await this.#nearestTest(path);
		const read = normaliseMutationReport(text, { version: this.#version, lines, tests, unmutated });
		// The base is not mutated, so it has nothing to subtract from the head's results.
		const baseLog: ToolLog = { ...read.log, runs: [{ ...read.log.runs[0], results: [] }] };
		return {
			status: "ran",
			log: read.log,
			baseLog,
			notes: [
				...this.#notes,
				`Stryker mutated ${count} changed lines in ${Object.keys(lines).length} file(s); the base was not mutated.`,
				...read.notes,
			],
		};
	}
}
