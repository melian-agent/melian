import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
	type UnmutatedFile,
} from "@melian-agent/core";
import { type HeadTrust, type JudgedHead, MutationCache } from "./mutation-cache.ts";
import { MutationProcess } from "./mutation-process.ts";
import { mutationSelectionVersion, mutationVitestModule } from "./mutation-vitest.ts";
import type { Run, StaticRun } from "./static.ts";
import { CacheLocation } from "./tool-provisioning.ts";

const config = "stryker.config.json";
const runner = "mutation-runner.mjs";

// What the runner prints between a related run and its repeat with the whole suite, so a failure message can keep both.
const repeatMarker = "[melian] the related tests did not settle the run; the whole suite follows";

function tail(text: string): string {
	return text.slice(-4096).trim();
}

// The head's own tests run under this limit, and some write files past `staticOutputLimit`: Melian's own cache tests write
// 128 MiB archives, and a limit of 16 MiB ended their processes with SIGXFSZ and failed Stryker's initial run. A runaway
// write is what this stops, so it is set above what a test suite writes. bash counts 1,024-byte blocks.
const mutationFileLimit = 1024 * 1024 * 1024;
const report = "reports/mutation/mutation.json";

// Production TypeScript is what the tests are there to hold; a test, a fixture, a golden or verifier corpus, built output,
// or a declaration file is not. A `.config.ts` is production: it can hold logic. It is not mutated, though, because a tool
// loads it to run the mutants, so a change to one is a file the run did not judge.
const typescript = /\.[cm]?tsx?$/;
// Files a test run can load, and names Vitest's defaults give test files.
const code = /\.(?:[cm]?[jt]sx?|json)$/;
const namedAsTest = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
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

const signalFiles = new Set([
	"packages/core/src/git.ts",
	"packages/pipeline/src/cache-scratch.ts",
	"packages/pipeline/src/mutation-process.ts",
	"packages/pipeline/src/static.ts",
]);

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

export const strykerNotInstalled =
	"Stryker is not installed in the checkout, and Melian carries none: add @stryker-mutator/core and @stryker-mutator/vitest-runner to the reviewed repository's dev dependencies";

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

// The lockfiles of every package manager whose install Node runs Stryker from. Bun's two formats are here because Melian
// runs Stryker under Node whichever tool installed node_modules.
const mutationLockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"] as const;

export function mutationInstallation(repoRoot: string): string {
	const require = createRequire(posix.join(repoRoot, "package.json"));
	const versions = ["@stryker-mutator/core", "@stryker-mutator/vitest-runner", "vitest"].map((name) => {
		try {
			const { version } = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")) as {
				version: unknown;
			};
			if (typeof version === "string") return version;
		} catch {
			// Fake and incomplete installs still get a distinct identity when repaired.
		}
		return "unavailable";
	});
	const lockfiles = Object.fromEntries(
		mutationLockfiles.map((name) => {
			try {
				return [
					name,
					createHash("sha256")
						.update(readFileSync(posix.join(repoRoot, name)))
						.digest("hex"),
				];
			} catch {
				// A checkout without this lockfile cannot share a partition with one that has it.
				return [name, "unavailable"];
			}
		}),
	);
	return createHash("sha256")
		.update(
			JSON.stringify({
				lockfiles,
				versions,
				node: process.versions.node,
				selectionVersion: mutationSelectionVersion,
			}),
		)
		.digest("hex");
}

// Stryker logs how many results its incremental mode reused. The head's tests write to the same log, so the count is a
// note and decides nothing. chalk may colour the first number; the escape character is dropped before matching.
const reusedCount = /(?:\[\d{1,3}m)?(\d{1,9})(?:\[\d{1,3}m)? of (\d{1,9}) mutant result\(s\) are reused\./;

function reuseNote(earlier: { readonly judged: JudgedHead } | { readonly cold: string }, log: string): string {
	if ("cold" in earlier) return `Stryker started cold: ${earlier.cold}.`;
	const judged = earlier.judged.head.slice(0, 12);
	const counted = reusedCount.exec(log.replaceAll(String.fromCharCode(27), ""));
	if (counted === null)
		return `Stryker was given the results of ${judged}, the last judged head; its log does not say how many it reused.`;
	const [reused, total] = [Number(counted[1]), Number(counted[2])];
	return `Stryker reused ${reused} of ${total} mutant result(s) from ${judged}, the last judged head, and ran ${total - reused}.`;
}

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

	// The changed production lines Stryker is asked about, and the production files set aside: a configuration file, a
	// signal-sending file, and a path Stryker's comma-separated `--mutate` cannot name. Each file set aside is a note and,
	// when the run goes ahead on the others, an `unmutated` result: a well-tested neighbour must not hide it.
	#targets(revision: Revision): { changed: Record<string, [number, number][]>; aside: UnmutatedFile[] } {
		const changed: Record<string, [number, number][]> = {};
		const aside: UnmutatedFile[] = [];
		for (const [path, ranges] of Object.entries(revision.diffLines())) {
			if (!production(path)) continue;
			if (signalFiles.has(path)) {
				this.#notes.push(`${path} was not mutated: it sends process signals; prove its guards with fakes.`);
				aside.push({ path, ranges, ...mutationUnmutated.signals });
			} else if (configuration.test(path)) {
				this.#notes.push(`${path} was not mutated: a tool loads a configuration file to run the mutants.`);
				aside.push({ path, ranges, ...mutationUnmutated.configuration });
			} else if (path.includes(",")) {
				this.#notes.push(`${path} was not mutated: Stryker cannot take a path with a comma.`);
				aside.push({ path, ranges, ...mutationUnmutated.comma });
			} else changed[path] = ranges;
		}
		return { changed, aside };
	}

	// The production files the revision changes that `diffLines` cannot address: git calls them binary, or their names are not
	// UTF-8. They hold no line Stryker can be asked about, so the check cannot read them as having no production code.
	#unaddressable(revision: Revision): string[] {
		return revision.files
			.filter((file) => file.status !== "deleted" && (file.binary || file.percentEncoded === true))
			.map((file) => file.path)
			.filter(production);
	}

	// Whether `revision` changes any production TypeScript, mutable or not, binary or not. Read from the diff alone, so a
	// caller asks it before deciding whether the head's code may run: a change with nothing to judge needs no leave.
	static judges(revision: Revision): boolean {
		return (
			Object.keys(revision.diffLines()).some(production) ||
			revision.files.some(
				(file) =>
					file.status !== "deleted" && (file.binary || file.percentEncoded === true) && production(file.path),
			)
		);
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

	async #runner(
		entries: readonly string[],
		changed: readonly string[],
		{ staged: incremental, earlier }: { staged: string; earlier: string },
	): Promise<string> {
		const require = createRequire(posix.join(this.#run.input.repoRoot, "node_modules/vitest/package.json"));
		const module = posix.join(this.#scratch, posix.basename(fileURLToPath(mutationVitestModule)));
		await this.#write(module, readFileSync(fileURLToPath(mutationVitestModule), "utf8"));
		const script = posix.join(this.#scratch, runner);
		const selectedConfig = posix.join(this.#scratch, "stryker.config.json");
		// Melian reads the JSON report at one path, so the head's configuration cannot move it or switch its reporter off.
		// Stryker ends a dry run that passes its own limit, which the configuration may set below Melian's timeout; whole
		// minutes at or past Melian's leave the timeout the only one that ends the run.
		const dryRunMinutes = Math.ceil(this.#run.input.settings.timeout / 60);
		const text = `
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { relative } from "node:path";
import { createVitest } from ${JSON.stringify(pathToFileURL(require.resolve("vitest/node")).href)};
import { MutationVitest } from ${JSON.stringify(pathToFileURL(module).href)};
// The supervisor ends this process with SIGTERM, and it must end then. Waiting for Stryker synchronously held a handled
// signal until Stryker had exited, and the repeat below then started a second Stryker that no one had recorded.
process.on("SIGTERM", () => process.exit(143));
const config = JSON.parse(readFileSync("stryker.config.json", "utf8"));
const selection = await MutationVitest.open(() => createVitest("test", {
  config: config.vitest?.configFile, dir: config.vitest?.dir, watch: false, coverage: { enabled: false }
}), ${JSON.stringify(changed)});
const result = await selection.execute(async (tests, fresh) => {
  // A whole-suite fallback must not reuse the related run's coverage or mutant results; it starts again from the
  // earlier head's, when there were any.
  if (fresh) {
    rmSync(${JSON.stringify(incremental)}, { force: true });
    if (existsSync(${JSON.stringify(earlier)})) copyFileSync(${JSON.stringify(earlier)}, ${JSON.stringify(incremental)});
    writeSync(1, ${JSON.stringify(`\n${repeatMarker}\n`)});
  }
  rmSync(${JSON.stringify(report)}, { force: true });
  writeFileSync(${JSON.stringify(selectedConfig)}, JSON.stringify({ ...config,
    dryRunTimeoutMinutes: ${dryRunMinutes},
    reporters: ["json"],
    jsonReporter: { ...config.jsonReporter, fileName: ${JSON.stringify(report)} },
    vitest: { ...config.vitest, related: false },
    testFiles: tests?.map(file => relative(process.cwd(), file).replace(/[\\\\*?[\\]{}()!+@#]/g, "\\\\$&")) ?? []
  }));
  const run = spawn(${JSON.stringify(this.#binary)}, ["run", ${JSON.stringify(selectedConfig)},
    "--reporters", "json", "--incremental", "--incrementalFile", ${JSON.stringify(incremental)},
    "--inPlace", "--mutate", ${JSON.stringify(entries.join(","))}],
    // The marker tells the head's tests a mutation run is running them, so one that starts Stryker itself can skip.
    { stdio: "inherit", env: { ...process.env, MELIAN_MUTATION: "1" } });
  const code = await new Promise((resolve) => {
    run.on("error", () => resolve(1));
    run.on("exit", (status) => resolve(status ?? 1));
  });
  let report;
  try { report = readFileSync(${JSON.stringify(report)}, "utf8"); } catch {}
  return { code, report };
}, () => !existsSync(${JSON.stringify(script)}) || !existsSync("stryker.config.json"));
writeFileSync(${JSON.stringify(posix.join(this.#scratch, "test-selection.json"))}, JSON.stringify(selection.notes));
process.exitCode = result.code;
`;
		await this.#write(script, text);
		return `${quote(process.execPath)} ${quote(script)}`;
	}

	async #write(path: string, text: string): Promise<void> {
		const written = await this.#run.input.env.writeFile(path, text, this.#run.context);
		if (!written.ok) throw this.#run.fail("worktreeFailed", `could not write ${path}: ${written.error.message}`);
	}

	// Reads a file the run left. The head's tests ran beside it, and a link there would have the host read whatever it
	// names into a message or a report, so a link is refused by name before the runner's own reader takes the file.
	async #read(path: string): Promise<string | undefined> {
		const info = await this.#run.input.env.fileInfo(path, this.#run.context);
		if (info.ok && info.value.kind === "symlink")
			throw this.#run.fail("toolFailed", `${path} is a symbolic link, not a file`);
		return this.#run.readOutput(path);
	}

	// The files the run cannot do without that are gone: the runner Melian wrote into scratch, and the head's Stryker
	// configuration, which was in the worktree when the run began.
	async #gone(): Promise<string[]> {
		const gone: string[] = [];
		// Only a plain "no" counts: a cancelled run cannot be answered, and its files are not gone for that.
		for (const path of [posix.join(this.#scratch, runner), posix.join(this.#root, config)]) {
			const found = await this.#run.input.env.exists(path, this.#run.context);
			if (found.ok && !found.value) gone.push(path);
		}
		return gone;
	}

	// The run executes the head's own test files, setup files, and Vitest configuration, as an ordinary child process with
	// the environment every static tool gets. Nothing confines it: the caller decided this head's code may run here.
	// Whether `older` is in `newer`'s history. git answers 1 for no, and anything else it says counts as no.
	async #ancestor(older: string, newer: string): Promise<boolean> {
		const { code } = await this.#run.shell(this.#run.git(`merge-base --is-ancestor ${quote(older)} ${quote(newer)}`));
		return code === 0;
	}

	// Stryker's incremental mode diffs only the files it mutated and the test files it ran. A change to any other code since
	// the judged head, such as a configuration, a setup file, a test helper or a production file set aside, can change what
	// a reused kill meant, so the run starts cold. A new file named as a test is a test Stryker will see.
	async #steered(
		earlier: { readonly judged: JudgedHead; readonly report: string } | { readonly cold: string },
		mutated: readonly string[],
	): Promise<{ readonly judged: JudgedHead; readonly report: string } | { readonly cold: string }> {
		if ("cold" in earlier) return earlier;
		const judged = earlier.judged.head;
		const listing = posix.join(this.#scratch, "since-judged");
		const listed = await this.#run.shell(
			`${this.#run.git(`diff --name-only --no-renames -z ${quote(judged)} ${quote(this.#run.input.commit)}`)} > ${quote(listing)}`,
		);
		const names = listed.code === 0 ? await this.#run.readOutput(listing) : undefined;
		if (names === undefined) return { cold: `git could not list what changed since ${judged.slice(0, 12)}` };
		// A production file changed since is in the pull request's diff, so it is among the mutated ones.
		const { testFiles } = JSON.parse(earlier.report) as { testFiles?: Record<string, unknown> };
		const seen = new Set([...mutated, ...Object.keys(testFiles ?? {})]);
		const unseen = names.split("\0").find((path) => code.test(path) && !seen.has(path) && !namedAsTest.test(path));
		if (unseen === undefined) return earlier;
		return {
			cold: `${unseen} changed since the last judged head ${judged.slice(0, 12)}, and Stryker's incremental mode does not read it`,
		};
	}

	async #execute(
		entries: readonly string[],
		changed: readonly string[],
		trust: HeadTrust,
	): Promise<string | { skipped: string }> {
		const { repoRoot, base, commit, target, policyCommit } = this.#run.input;
		const cache = await MutationCache.open((await CacheLocation.open(repoRoot)).root, {
			base: base ?? commit,
			policy: policyCommit ?? base ?? commit,
			target: target ?? commit,
			installation: mutationInstallation(repoRoot),
			inputs: createHash("sha256")
				.update(JSON.stringify({ version: this.#version }))
				.digest("hex"),
		});
		const earlier = await this.#steered(
			await cache.earlier(trust, (judged) => this.#ancestor(judged, commit)),
			changed,
		);
		const incremental = await cache.stage(
			posix.join(this.#scratch, "incremental"),
			"report" in earlier ? earlier.report : undefined,
		);
		const log = posix.join(this.#scratch, "stryker.log");
		// A report the revision committed must not stand in for the one this run writes.
		const runner = await this.#runner(entries, changed, incremental);
		const command = [
			`cd ${quote(this.#root)}`,
			`ulimit -f ${mutationFileLimit / 1024}`,
			`rm -f ${quote(report)}`,
			`${runner} > ${quote(log)} 2>&1`,
		].join(" && ");
		let result: Awaited<ReturnType<Run["shell"]>> | undefined;
		let failure: unknown;
		try {
			result = await new MutationProcess(this.#run).execute(command);
		} catch (error) {
			failure = error;
		}
		// Checked before anything else is read: with these gone, every later symptom is a consequence, and the log that
		// would have explained it went with them.
		const gone = await this.#gone();
		if (gone.length > 0) {
			throw this.#run.fail(
				"worktreeFailed",
				`static.mutation's scratch directory ${this.#scratch} lost files while Stryker ran: ${gone.join(" and ")} ${gone.length === 1 ? "is" : "are"} gone. They were there when the run began, so another process removed them while it was in progress: most likely a Melian review of this clone from a build that does not recognise this run's lock, or else the head's own tests. ${result === undefined ? "Stryker did not finish" : `Stryker exited ${result.code}`}.`,
				failure,
			);
		}
		if (result === undefined) {
			// A change too slow to mutate is one the run could not judge, not one whose judgement failed.
			if (failure instanceof CheckError && failure.code === "timeout") {
				return { skipped: mutationSkips.timeout(this.#run.input.settings.timeout) };
			}
			throw failure;
		}
		const stderr = tail(result.output);
		// The head's tests can leave anything where the log should be; the reader refuses what is not a file.
		const logText = await this.#read(log).catch((error: unknown) => {
			throw this.#run.fail(
				"toolFailed",
				`Stryker exited ${result.code}: log unreadable at ${log}: ${String(error)}\n${stderr}`,
			);
		});
		if (logText === undefined)
			throw this.#run.fail("toolFailed", `Stryker exited ${result.code}: log missing at ${log}\n${stderr}`);
		// A repeat's output ends the log, so its tail alone would hide why the related run failed.
		const [related, ...repeats] = logText.split(`\n${repeatMarker}\n`);
		const output =
			repeats.length === 0 ? tail(logText) : `${tail(related!)}\n${repeatMarker}\n${tail(repeats.at(-1)!)}`;
		const notes = await this.#read(posix.join(this.#scratch, "test-selection.json"));
		if (notes === undefined) throw this.#run.fail("invalidOutput", "mutation runner wrote no test-selection notes");
		this.#notes.push(...(JSON.parse(notes) as string[]), reuseNote(earlier, repeats.at(-1) ?? related!));
		if (result.code === 1) throw this.#run.fail("toolFailed", `Stryker exited 1: ${output}`);
		if (result.code !== 0)
			throw this.#run.fail("invalidOutput", `Stryker exited ${result.code}, which it does not document: ${output}`);
		const text = await this.#read(posix.join(this.#root, report));
		if (text === undefined) throw this.#run.fail("invalidOutput", `Stryker wrote no report at ${report}`);
		// A run another review has retired may not leave identities for the next one to trust.
		if ((await this.#run.input.holdsAuthority?.()) ?? true)
			await cache.publish(incremental.staged, { head: commit, trust }, (held) => this.#ancestor(commit, held));
		return text;
	}

	async check(): Promise<StaticRun> {
		const { revision, settings, headCode } = this.#run.input;
		// runStaticTool refuses first; this keeps the leave a partition records from ever being a guess.
		if (headCode === undefined)
			throw this.#run.fail("toolFailed", "mutation testing needs the host's leave to run head code");
		if (revision === undefined) throw this.#run.fail("toolFailed", "mutation testing needs the revision it mutates");
		const { changed, aside } = this.#targets(revision);
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

		if (!(await this.#run.exists(posix.join(this.#root, config))))
			throw this.#run.fail("toolFailed", `the revision has no ${config}, which Stryker needs`);
		const entries = Object.entries(lines).flatMap(([path, ranges]) =>
			ranges.map(([first, last]) => `${literal(path)}:${first}-${last}`),
		);
		// Looked up before the head's tests run, which may move or remove a test file.
		const tests: Record<string, string> = {};
		for (const path of Object.keys(lines)) tests[path] = await this.#nearestTest(path);
		const text = await this.#execute(entries, Object.keys(lines), headCode);
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
							...Object.fromEntries(aside.map((file) => [file.path, file.ranges])),
							...Object.fromEntries(binary.map((file) => [file.path, [[1, 1]] as [number, number][]])),
						},
					},
					text.skipped,
				),
			};
		}
		const firstOmitted = Object.entries(omitted)[0];
		const read = normaliseMutationReport(text, {
			version: this.#version,
			lines,
			tests,
			unmutated: [...binary, ...aside],
			...(total > maxLines
				? { budget: { count: total - count, maxLines, path: firstOmitted![0], line: firstOmitted![1][0]![0] } }
				: {}),
		});
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
