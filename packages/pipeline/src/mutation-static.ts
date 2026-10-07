import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import {
	CheckError,
	type MutationSettings,
	mutationSkips,
	normaliseMutationReport,
	type Revision,
	type ToolLog,
} from "@melian-agent/core";
import type { Run, StaticRun } from "./static.ts";


// The head's own tests run under this limit, and some write files past `staticOutputLimit`: Melian's own cache tests write
// 128 MiB archives, and a limit of 16 MiB ended their processes with SIGXFSZ and failed Stryker's initial run. A runaway
// write is what this stops, so it is set above what a test suite writes. bash counts 1,024-byte blocks.
const mutationFileLimit = 1024 * 1024 * 1024;
const config = "stryker.config.json";
const report = "reports/mutation/mutation.json";

// Production TypeScript only: a test, a fixture, a golden, built output, or a tool's own configuration is not what the
// tests are there to hold.
const typescript = /\.[cm]?tsx?$/;
const notProduction = /\.(?:d|test|spec|config)\.[cm]?tsx?$/;
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

function mutable(path: string): boolean {
	return (
		typescript.test(path) &&
		!notProduction.test(path) &&
		!posix
			.dirname(path)
			.split("/")
			.some((segment) => notProductionDirectories.has(segment))
	);
}

function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The version of `@stryker-mutator/core` a run would use: the checkout's install, else Melian's own, else
 * `unavailable`. A run's identity holds it, so a bump runs the check again.
 */
export function strykerVersion(repoRoot: string): string {
	const own = createRequire(import.meta.url);
	for (const path of [posix.join(repoRoot, "node_modules/@stryker-mutator/core/package.json"), undefined]) {
		try {
			const file = path ?? own.resolve("@stryker-mutator/core/package.json");
			const { version } = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
			if (typeof version === "string") return version;
		} catch {
			// An absent install is not an error here: the run itself fails closed when it finds no Stryker.
		}
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

	constructor(run: Run, root: string, scratch: string, binary: string, version: string, notes: string[]) {
		this.#run = run;
		this.#root = root;
		this.#scratch = scratch;
		this.#binary = binary;
		this.#version = version;
		this.#notes = notes;
	}

	// The changed production lines, and the paths set aside because Stryker's comma-separated `--mutate` cannot name them.
	#targets(revision: Revision): Record<string, [number, number][]> {
		const targets: Record<string, [number, number][]> = {};
		for (const [path, ranges] of Object.entries(revision.diffLines())) {
			if (!mutable(path)) continue;
			if (path.includes(",")) {
				this.#notes.push(`${path} was not mutated: Stryker cannot take a path with a comma.`);
				continue;
			}
			targets[path] = ranges;
		}
		return targets;
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

	async #execute(entries: readonly string[]): Promise<string> {
		const log = posix.join(this.#scratch, "stryker.log");
		// A report the revision committed must not stand in for the one this run writes.
		const command = [
			`cd ${quote(this.#root)}`,
			`ulimit -f ${mutationFileLimit / 1024}`,
			`rm -f ${quote(report)}`,
			`${quote(this.#binary)} run ${quote(posix.join(this.#root, config))} --reporters json --incremental --incrementalFile ${quote(posix.join(this.#scratch, "incremental.json"))} --inPlace --mutate ${quote(entries.join(","))} > ${quote(log)} 2>&1`,
		].join(" && ");
		const result = await this.#run.shell(command);
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
		const lines = this.#targets(revision);
		const count = Object.values(lines).reduce(
			(sum, ranges) => sum + ranges.reduce((total, [first, last]) => total + last - first + 1, 0),
			0,
		);
		if (count === 0) return { status: "skipped", reason: "the change adds or edits no production TypeScript lines" };
		const { maxLines } = settings as MutationSettings;
		if (count > maxLines)
			return {
				status: "skipped",
				reason: `the change adds or edits ${count} production TypeScript lines, past static.mutation.maxLines of ${maxLines}`,
			};
		if (!(await this.#run.exists(posix.join(this.#root, config))))
			throw this.#run.fail("toolFailed", `the revision has no ${config}, which Stryker needs`);
		const entries = Object.entries(lines).flatMap(([path, ranges]) =>
			ranges.map(([first, last]) => `${path}:${first}-${last}`),
		);
		const text = await this.#execute(entries);
		// The base is not mutated, so it has nothing to subtract from the head's results.
		const empty: ToolLog = {
			version: "2.1.0",
			runs: [{ tool: { driver: { name: "Stryker", version: this.#version } }, results: [] }],
		};
		const tests: Record<string, string> = {};
		for (const path of Object.keys(lines)) tests[path] = await this.#nearestTest(path);
		const read = normaliseMutationReport(text, { version: this.#version, lines, tests });
		return {
			status: "ran",
			log: read.log,
			baseLog: empty,
			notes: [
				...this.#notes,
				`Stryker mutated ${count} changed lines in ${Object.keys(lines).length} file(s); the base was not mutated.`,
				...read.notes,
			],
		};
	}
}
