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
import { configuration, nonRegularEntry, production, signalFiles, typescript } from "./mutation-paths.ts";
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
const reusedCount = /(?:\[\d{1,3}m)?(\d{1,9})(?:\[\d{1,3}m)? of (\d{1,9}) mutant result\(s\) are reused\./g;

// The largest count of reused results the log states, as `[reused, total]`. The head's tests can print a count of their
// own beside Stryker's, so the first is not to be trusted, and the largest is what the belt must see.
function reusedOf(log: string): [number, number] | undefined {
	let largest: [number, number] | undefined;
	for (const [, reused, total] of log.replaceAll(String.fromCharCode(27), "").matchAll(reusedCount))
		if (largest === undefined || Number(reused) > largest[0]) largest = [Number(reused), Number(total)];
	return largest;
}

function reuseNote(earlier: { readonly judged: JudgedHead } | { readonly cold: string }, log: string): string {
	if ("cold" in earlier) return `Stryker started cold: ${earlier.cold}.`;
	const judged = earlier.judged.head.slice(0, 12);
	const counted = reusedOf(log);
	if (counted === undefined)
		return `Stryker was given the results of ${judged}, the last judged head; its log does not say how many it reused.`;
	const [reused, total] = counted;
	return `Stryker reused ${reused} of ${total} mutant result(s) from ${judged}, the last judged head, and ran ${total - reused}.`;
}

// What a run that built on an earlier head says in place of approval. Whether it is provisional is Melian's own fact,
// that it handed Stryker an earlier report; the count is the head-written log's and only words the reason.
function provisionalReason(log: string): string {
	const counted = reusedOf(log);
	const reused =
		counted === undefined
			? "Stryker was handed an earlier head's results, and its log does not say how many it reused"
			: `Stryker reused ${counted[0]} of ${counted[1]} results from an earlier head`;
	return `provisional: ${reused}; a cold run decides approval`;
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
	// signal-sending file, a non-regular head entry, and a path Stryker's comma-separated `--mutate` cannot name. Each file set aside is a note and,
	// when the run goes ahead on the others, an `unmutated` result: a well-tested neighbour must not hide it.
	#targets(revision: Revision): { changed: Record<string, [number, number][]>; aside: UnmutatedFile[] } {
		const changed: Record<string, [number, number][]> = {};
		const aside: UnmutatedFile[] = [];
		for (const [path, ranges] of Object.entries(revision.diffLines())) {
			if (!production(path)) continue;
			const kind = revision.files.find((file) => file.path === path)!.newKind;
			if (kind !== "file" && kind !== "executable") {
				const reason = nonRegularEntry(kind);
				this.#notes.push(`${path} was not mutated: ${reason.why}.`);
				aside.push({ path, ranges, ...reason });
			} else if (signalFiles.has(path)) {
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
		// Whether Melian handed the run an earlier head's report. Decided here, not by the file, which the head's tests could
		// write: a run handed none passes `--force`, and a whole-suite repeat restores nothing.
		reused: boolean,
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
    if (${JSON.stringify(reused)} && existsSync(${JSON.stringify(earlier)})) copyFileSync(${JSON.stringify(earlier)}, ${JSON.stringify(incremental)});
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
    "--reporters", "json", "--incremental", "--incrementalFile", ${JSON.stringify(incremental)},${reused ? "" : ` "--force",`}
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

	async #execute(
		entries: readonly string[],
		changed: readonly string[],
		trust: HeadTrust,
	): Promise<{ text: string; provisional?: string } | { skipped: string }> {
		const { repoRoot, base, commit, target, policyCommit } = this.#run.input;
		// A caller that does not say when its task was made never replaces another line's results.
		const created = this.#run.input.created ?? 0;
		const cache = await MutationCache.open((await CacheLocation.open(repoRoot)).root, {
			base: base ?? commit,
			policy: policyCommit ?? base ?? commit,
			target: target ?? commit,
			installation: mutationInstallation(repoRoot),
			inputs: createHash("sha256")
				.update(JSON.stringify({ version: this.#version }))
				.digest("hex"),
		});
		const earlier = this.#run.input.cold
			? { cold: "the review asked for a cold run with --cold" }
			: await cache.earlier(trust, (judged) => this.#ancestor(judged, commit));
		// Only a run from nothing may approve. Melian knows that from what it staged, never from the partition file, which
		// the head's tests can write.
		const cold = "cold" in earlier;
		const incremental = await cache.stage(
			posix.join(this.#scratch, "incremental"),
			"report" in earlier ? earlier.report : undefined,
		);
		const log = posix.join(this.#scratch, "stryker.log");
		// A report the revision committed must not stand in for the one this run writes.
		const runner = await this.#runner(entries, changed, incremental, !cold);
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
		const deciding = repeats.at(-1) ?? related!;
		this.#notes.push(...(JSON.parse(notes) as string[]), reuseNote(earlier, deciding));
		if (result.code === 1) throw this.#run.fail("toolFailed", `Stryker exited 1: ${output}`);
		if (result.code !== 0)
			throw this.#run.fail("invalidOutput", `Stryker exited ${result.code}, which it does not document: ${output}`);
		const text = await this.#read(posix.join(this.#root, report));
		if (text === undefined) throw this.#run.fail("invalidOutput", `Stryker wrote no report at ${report}`);
		// A run another review has retired may not leave identities for the next one to trust.
		if ((await this.#run.input.holdsAuthority?.()) ?? true)
			// The partition only speeds a later head, so a failure to store it leaves this run's result standing.
			await cache
				.publish(incremental.staged, { head: commit, trust }, created, (older, newer) =>
					this.#ancestor(older, newer),
				)
				.catch((error: unknown) =>
					this.#notes.push(
						`The mutation results were not stored for later heads: ${error instanceof Error ? error.message : String(error)}.`,
					),
				);
		// `--force` makes a cold run rerun every mutant; a log that still counts reused results means the run was not cold.
		const reusedAnyway = (reusedOf(deciding)?.[0] ?? 0) > 0;
		return cold && !reusedAnyway ? { text } : { text, provisional: provisionalReason(deciding) };
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
		const unmutated = [...binary, ...aside];
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
				log: mutationUnmutatedLog(this.#version, unmutated),
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
		const result = await this.#execute(entries, Object.keys(lines), headCode);
		if ("skipped" in result) {
			return {
				status: "skipped",
				reason: result.skipped,
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
					result.skipped,
				),
			};
		}
		const firstOmitted = Object.entries(omitted)[0];
		const read = normaliseMutationReport(result.text, {
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
			provisional: result.provisional,
			notes: [
				...this.#notes,
				`Stryker mutated ${count} changed lines in ${Object.keys(lines).length} file(s); the base was not mutated.`,
				...read.notes,
			],
		};
	}
}
