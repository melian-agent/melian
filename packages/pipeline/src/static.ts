import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, posix } from "node:path";
import {
	CheckError,
	type EnolaSnapshot,
	normaliseBiomeSarif,
	parseJsonc,
	parseTscDiagnostics,
	type StaticTool,
	type StaticToolSettings,
	type ToolLog,
	type TscSettings,
} from "@melian-agent/core";
import { EnolaRun } from "./enola-static.ts";
import { backgroundContext, type Context, type ExecutionEnv } from "./harness.ts";
import { MutationScratch } from "./mutation-scratch.ts";
import { nodeExecutable, Sandbox, type SandboxPaths } from "./sandbox.ts";
import { ToolProvisioning } from "./tool-provisioning.ts";

/** The most a static tool may write, its report included. Past it the run fails with `outputTooLarge`. */
export const staticOutputLimit = 16 * 1024 * 1024;

/** What {@link runStaticTool} runs. */
export interface StaticRunInput {
	/** Where the tool runs. Everything the run executes goes through it, never through the Melian process. */
	readonly env: ExecutionEnv;
	/** The repository's checkout, whose git directory the worktree is added to. It is never written to otherwise. */
	readonly repoRoot: string;
	readonly commit: string;
	readonly base?: string;
	/** Trusted Enola policy commit, separate from the comparison base. Defaults to base, then commit. */
	readonly policyCommit?: string;
	readonly tools?: ToolProvisioning;
	readonly tool: StaticTool;
	readonly settings: StaticToolSettings | TscSettings;
}

/** A tool's log for one revision, with anything the run set aside, or why the tool does not apply to it. */
export type StaticRun =
	| {
			readonly status: "ran";
			readonly log: ToolLog;
			readonly notes: readonly string[];
			readonly baseLog?: ToolLog;
			readonly snapshots?: EnolaSnapshot[];
	  }
	| { readonly status: "skipped"; readonly reason: string };

// Variables a git hook sets for its own repository; git would honour them over `-C`.
const gitVariables = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
];

// Everything the runner executes may be the revision's code, so it gets these variables and nothing else: never a token
// or key from the Melian process, even on a maintainer's own machine.
const passedVariables = ["PATH", "HOME", "TMPDIR", "LANG"] as const;

function toolEnvironment(replaced: Readonly<Record<string, string>>): {
	env: Record<string, string>;
	inheritEnv: false;
} {
	const env: Record<string, string> = {};
	for (const name of passedVariables) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return { env: { ...env, ...replaced }, inheritEnv: false };
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// Hooks and fsmonitor would run the revision's own programs during checkout, outside any tool's timeout.
function git(repoRoot: string, args: string): string {
	return `unset ${gitVariables.join(" ")}; git -C ${quote(repoRoot)} -c core.hooksPath=/dev/null -c core.fsmonitor=false ${args}`;
}

const toolBinaries: Readonly<
	Record<Exclude<StaticTool, "enola">, { readonly bin: string; readonly melian: () => string }>
> = {
	biome: { bin: "biome", melian: () => melianBinary("@biomejs/biome", "bin/biome") },
	tsc: { bin: "tsc", melian: () => melianBinary("typescript", "bin/tsc") },
};

function melianBinary(packageName: string, bin: string): string {
	return posix.join(dirname(createRequire(import.meta.url).resolve(`${packageName}/package.json`)), bin);
}

interface Shell {
	readonly code: number;
	readonly output: string;
}

export class Run {
	mutationScratch?: MutationScratch;
	#confinement?: { readonly sandbox: Sandbox; readonly paths: SandboxPaths; readonly profile: string | undefined };
	#outputs?: MutationScratch;
	/** What the run met on the way that its record should say, such as a worktree it would not remove. */
	readonly notes: string[] = [];
	readonly input: StaticRunInput;
	readonly context: Context;
	readonly check: string;

	constructor(input: StaticRunInput, context: Context) {
		this.input = input;
		this.context = context;
		this.check = `static.${input.tool}`;
	}

	git(args: string, root = this.input.repoRoot): string {
		return git(root, args);
	}

	fail(code: ConstructorParameters<typeof CheckError>[0], message: string, cause?: unknown): CheckError {
		return new CheckError(code, this.check, message, { cause });
	}

	// Runs a command, keeping the start of what it prints for error messages. `replaced` overrides a passed variable, such
	// as the `HOME` of a command that runs confined.
	async shell(
		command: string,
		timeout = this.input.settings.timeout,
		replaced: Readonly<Record<string, string>> = {},
	): Promise<Shell> {
		let output = "";
		const result = await this.input.env.exec(
			command,
			{
				...toolEnvironment(replaced),
				timeout,
				onOutput: (text) => {
					if (output.length < 8192) output += text;
				},
			},
			this.context,
		);
		if (!result.ok) {
			if (result.error.code === "timeout") {
				throw this.fail("timeout", `${this.input.tool} ran past its ${timeout}-second timeout`, result.error);
			}
			if (result.error.code === "aborted") {
				throw this.fail("aborted", `${this.input.tool} was cancelled before it finished`, result.error);
			}
			throw this.fail("toolFailed", `${this.input.tool} could not be run: ${result.error.message}`, result.error);
		}
		return { code: result.value.exitCode, output: output.trim() };
	}

	// Puts every later `tool` command inside the host's sandbox: no network, the reviewer's files unreadable, and writes
	// in scratch only. Returns a note when it cannot, and the tool then runs as it always has. That is safe to do because
	// Biome and tsc read the revision and never run it; the sandbox is there for a tool a crafted file subverts.
	async confine(root: string, scratch: string, installs: readonly string[]): Promise<string | undefined> {
		const sandbox = await Sandbox.detect(this.input.env, this.context);
		if (sandbox === undefined) return `${this.input.tool} ran unconfined: this host offers no sandbox.`;
		const paths = { worktree: root, scratch, installs, node: nodeExecutable() };
		const failure = await sandbox.runtimeFailure(paths, this.input.env, this.context);
		if (failure !== undefined) return `${this.input.tool} ran unconfined: ${failure}.`;
		this.#confinement = { sandbox, paths, profile: sandbox.profile(paths) };
		// From here the reader runs inside the sandbox too, under a profile built before the tool has run.
		this.#outputs = MutationScratch.open(this, scratch, sandbox, []);
	}

	// Runs the tool's own command, confined when `confine` found a sandbox. git, `ln`, and `rm` stay on `shell`.
	async tool(command: string): Promise<Shell> {
		const confinement = this.#confinement;
		if (confinement === undefined) return this.shell(command);
		const { sandbox, paths, profile } = confinement;
		return this.shell(sandbox.command(command, paths, "", profile), undefined, {
			...sandbox.environment(),
			HOME: paths.scratch,
			TMPDIR: paths.scratch,
		});
	}

	// Records beside a registration this run just made that it is this run's: see `marked`.
	async mark(root: string): Promise<void> {
		const admin = await this.shell(this.git("rev-parse --absolute-git-dir", root));
		if (admin.code !== 0) throw this.fail("worktreeFailed", `git rev-parse failed in ${root}: ${admin.output}`);
		const written = await this.input.env.writeFile(
			posix.join(admin.output, markerFile),
			JSON.stringify({ tree: root, pid: process.pid }),
			this.context,
		);
		if (!written.ok) throw this.fail("worktreeFailed", `could not mark ${root}: ${written.error.message}`);
	}

	// git reads every registered worktree's commondir while adding or listing one, so another run that has made its
	// admin directory but not yet written that file fails this command. The runs on base and head add four at once.
	async worktreeCommand(command: string): Promise<Shell> {
		let result = await this.shell(command);
		for (let attempt = 1; result.code !== 0 && /commondir/.test(result.output) && attempt <= 5; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
			result = await this.shell(command);
		}
		return result;
	}

	async exists(path: string): Promise<boolean> {
		const result = await this.input.env.exists(path, this.context);
		return result.ok && result.value;
	}

	async inWorktree<T>(use: (root: string, scratch: string) => Promise<T>): Promise<T> {
		const { env, commit } = this.input;
		if (!/^[0-9a-f]{40,64}$/.test(commit)) throw this.fail("worktreeFailed", `${commit} is not a full commit hash`);
		const created = await env.createTempDir(scratchPrefix, this.context);
		if (!created.ok) throw this.fail("worktreeFailed", `no temporary directory: ${created.error.message}`);
		// The reader refuses a link at any component and seatbelt matches real paths, so scratch is used by its real path
		// or not at all.
		const canonical = await env.canonicalPath(created.value, this.context);
		if (!canonical.ok) {
			await env.remove(created.value, { recursive: true, force: true }, backgroundContext);
			throw this.fail("worktreeFailed", `${created.value} could not be resolved: ${canonical.error.message}`);
		}
		const scratch = canonical.value;
		const root = posix.join(scratch, "tree");
		this.#outputs = MutationScratch.open(this, scratch, undefined, []);
		try {
			await removeStaleWorktrees(this, scratch);
			const added = await this.worktreeCommand(
				this.git(`worktree add --detach --quiet --lock --reason ${quote(lockReason)} ${quote(root)} ${commit}`),
			);
			if (added.code !== 0) throw this.fail("worktreeFailed", `git worktree add failed: ${added.output}`);
			await this.mark(root);
			return await use(root, scratch);
		} finally {
			await removeWorktree(this, scratch);
		}
	}

	// Reads a file under scratch, refusing one past the output limit rather than truncating it. This is the only way the
	// host reads there. A confined tool can leave a link, a FIFO, or a swapped directory where its output should be, so
	// the reader follows no link at any component, opens only a regular file, and reads it once; only a missing file
	// means no output. A refusal names the path and never holds what the path led to.
	async readOutput(path: string): Promise<string | undefined> {
		if (this.#outputs === undefined) throw this.fail("worktreeFailed", `${path} was read outside a run's scratch`);
		return this.#outputs.read(path, staticOutputLimit);
	}
}

// The paths git tracks in a working tree, read through a file because Shell.exec interleaves its streams.
async function trackedFiles(run: Run, tree: string, listing: string, pathspec = ""): Promise<string[]> {
	const listed = await run.shell(`${git(tree, `ls-files -z ${pathspec}`)} > ${quote(listing)}`);
	const files = listed.code === 0 ? await run.readOutput(listing) : undefined;
	if (files === undefined) throw run.fail("worktreeFailed", `git ls-files failed in ${tree}: ${listed.output}`);
	return files.split("\0").filter((file) => file !== "");
}

// Never a binary the revision's tree supplies: the head must not choose the tool that judges it, and running even its
// `--version` would run the head's code. `installed` is the checkout's node_modules, or undefined when there is none
// the runner may use; otherwise Melian's own tool runs.
async function binaryFor(run: Run, installed: string | undefined): Promise<string> {
	if (run.input.tool === "enola") return (await ToolProvisioning.open(run.input.repoRoot)).binary("enola");
	const { bin, melian } = toolBinaries[run.input.tool];
	const own = installed === undefined ? undefined : posix.join(installed, ".bin", bin);
	if (own !== undefined && (await run.exists(own))) return own;
	try {
		return melian();
	} catch (cause) {
		throw run.fail("toolMissing", `${bin} is in neither the checkout's node_modules nor Melian's`, cause);
	}
}

// Links the checkout's installed dependencies into the worktree entry by entry. Problem: one link to the checkout's
// node_modules made its workspace links, such as `node_modules/b -> ../packages/b`, resolve to the checkout's own
// sources, so base and head type-checked against one tree. Solution: an entry that resolves inside the checkout, outside
// any node_modules, is a workspace package, linked to the worktree's own copy; every other entry links to the install.
async function linkDependencies(run: Run, root: string, scratch: string, notes: string[]): Promise<string[]> {
	const { env, repoRoot, commit, tool } = run.input;
	const canonical = await env.canonicalPath(repoRoot, run.context);
	const checkout = canonical.ok ? canonical.value : repoRoot;
	const commands: string[] = [];
	const workspaces = new Set<string>();
	// The install directories the worktree links to, which a sandboxed command is allowed to read.
	const installs: string[] = [];
	const link = async (from: string, to: string): Promise<void> => {
		const listed = await env.listDir(from, run.context);
		if (!listed.ok) return;
		commands.push(`mkdir -p ${quote(to)}`);
		for (const entry of listed.value) {
			const source = posix.join(from, entry.name);
			const target = posix.join(to, entry.name);
			if (entry.kind === "directory" && entry.name.startsWith("@")) {
				await link(source, target);
				continue;
			}
			const real = entry.kind === "symlink" ? await env.canonicalPath(source, run.context) : undefined;
			const inside =
				real?.ok === true && real.value.startsWith(`${checkout}/`) ? real.value.slice(checkout.length + 1) : "";
			if (inside !== "" && !inside.split("/").includes("node_modules")) {
				workspaces.add(inside);
				commands.push(`ln -s ${quote(posix.join(root, inside))} ${quote(target)}`);
			} else {
				commands.push(`ln -s ${quote(source)} ${quote(target)}`);
			}
		}
	};
	installs.push(posix.join(checkout, "node_modules"));
	await link(posix.join(checkout, "node_modules"), posix.join(root, "node_modules"));
	// A workspace package's own node_modules holds the versions only it depends on.
	for (const workspace of workspaces) {
		const nested = posix.join(checkout, workspace, "node_modules");
		if ((await run.exists(nested)) && (await run.exists(posix.join(root, workspace)))) {
			installs.push(nested);
			await link(nested, posix.join(root, workspace, "node_modules"));
		}
	}
	const script = posix.join(scratch, "link.sh");
	const written = await env.writeFile(script, `${commands.join("\n")}\n`, run.context);
	if (!written.ok) throw run.fail("worktreeFailed", `could not write ${script}: ${written.error.message}`);
	const linked = await run.shell(`sh ${quote(script)}`);
	if (linked.code !== 0) throw run.fail("worktreeFailed", `linking dependencies failed: ${linked.output}`);
	// A dependency bump in the checkout but not at this revision is accepted; the lockfile is policy, reviewed as such.
	const lockfile = "package-lock.json";
	if (!(await run.exists(posix.join(checkout, lockfile)))) return installs;
	const differs = await run.shell(
		`cmp -s ${quote(posix.join(checkout, lockfile))} ${quote(posix.join(root, lockfile))}`,
	);
	if (differs.code !== 0) {
		notes.push(
			`${tool} resolved dependencies from the checkout's install, whose ${lockfile} differs from ${commit.slice(0, 12)}'s.`,
		);
	}
	return installs;
}

// Each directory named node_modules that the revision tracks, outermost only.
function trackedModules(files: readonly string[]): string[] {
	const directories = files.flatMap((file) => {
		const segments = file.split("/");
		const at = segments.indexOf("node_modules");
		return at === -1 ? [] : [segments.slice(0, at + 1).join("/")];
	});
	return [...new Set(directories)].sort();
}

async function versionOf(run: Run, binary: string): Promise<string> {
	const { code, output } = await run.tool(`${quote(binary)} --version`);
	if (code !== 0) throw run.fail("toolMissing", `${binary} --version failed with exit code ${code}: ${output}`);
	return /\d+\.\d+\.\d+[\w.+-]*/.exec(output)?.[0] ?? "unknown";
}

// `ulimit -f` counts 1,024-byte blocks in bash, or 512-byte blocks in POSIX mode, which only halves the bound.
const fileLimit = `ulimit -f ${staticOutputLimit / 1024}`;

async function runBiome(run: Run, root: string, scratch: string, binary: string, version: string): Promise<ToolLog> {
	const report = posix.join(scratch, "biome.sarif");
	const { code, output } = await run.tool(
		`cd ${quote(root)} && ${fileLimit} && ${quote(binary)} lint --reporter=sarif --reporter-file=${quote(report)} --max-diagnostics=none --colors=off --no-errors-on-unmatched . > /dev/null 2> ${quote(posix.join(scratch, "biome.err"))}`,
	);
	const text = await run.readOutput(report);
	// Biome exits 1 when it reports an error-level diagnostic; anything else without a report is a failure.
	if (text === undefined || (code !== 0 && code !== 1)) {
		const stderr = (await run.readOutput(posix.join(scratch, "biome.err")))?.slice(0, 4096) ?? output;
		throw run.fail(
			"toolFailed",
			`biome exited with code ${code} and ${text === undefined ? "no report" : "a report"}: ${stderr.trim()}`,
		);
	}
	return normaliseBiomeSarif(text, { root, version });
}

// The projects a tsconfig asks tsc to check. A solution-style tsconfig, with `references` and an empty `files` and no
// `include`, checks nothing itself, so each referenced project is checked in its place; a tsconfig with an empty
// `files`, no `include`, and no references checks nothing at all. With neither `files` nor `include`, tsc checks every
// file below the tsconfig, so it is checked as it is.
async function tscProjects(run: Run, root: string, project: string, seen = new Set<string>()): Promise<string[]> {
	if (seen.has(project)) return [];
	seen.add(project);
	// The head can commit this path as a link to any file on the host, so it is read like every file under scratch. A
	// project the reader refuses is left for tsc to open, which it does confined.
	const text = await run.readOutput(posix.join(root, project)).catch(() => undefined);
	const config = text === undefined ? undefined : parseJsonc(text);
	if (typeof config !== "object" || config === null) return [project];
	const { files, include, references } = config as { files?: unknown; include?: unknown; references?: unknown };
	const empty = (value: unknown) => Array.isArray(value) && value.length === 0;
	const own = !(empty(files) && (include === undefined || empty(include)));
	const referenced = Array.isArray(references)
		? references.flatMap((reference: { path?: unknown }) =>
				typeof reference?.path === "string" ? [reference.path] : [],
			)
		: [];
	if (own) return [project];
	const projects: string[] = [];
	for (const reference of referenced) {
		const resolved = posix.normalize(posix.join(posix.dirname(project), reference));
		if (resolved.startsWith("..") || posix.isAbsolute(resolved)) continue;
		const file = resolved.endsWith(".json") ? resolved : posix.join(resolved, "tsconfig.json");
		projects.push(...(await tscProjects(run, root, file, seen)));
	}
	return projects;
}

async function runTsc(
	run: Run,
	root: string,
	scratch: string,
	binary: string,
	version: string,
	tracked: ReadonlySet<string>,
	notes: string[],
): Promise<ToolLog> {
	const { project } = run.input.settings as TscSettings;
	const projects = await tscProjects(run, root, project);
	if (projects.length === 0) {
		throw run.fail("nothingToCheck", `${project} has no files, no include, and no references, so tsc checks nothing`);
	}
	if (projects.length > 1 || projects[0] !== project)
		notes.push(`tsc checked ${projects.join(", ")}, which ${project} references.`);
	const dropped: string[] = [];
	const results: ToolLog["runs"][0]["results"] = [];
	for (const [index, each] of projects.entries()) {
		const out = posix.join(scratch, `tsc-${index}.out`);
		const { code, output } = await run.tool(
			`cd ${quote(root)} && ${fileLimit} && ${quote(binary)} --noEmit --pretty false -p ${quote(each)} > ${quote(out)} 2>&1`,
		);
		const text = (await run.readOutput(out)) ?? "";
		// A diagnostic names its file by a prefix of its line; the revision's own file list says which prefix is a file.
		const before = dropped.length;
		const log = parseTscDiagnostics(
			text,
			{ root, version, project: each, exists: (path) => tracked.has(path) },
			dropped,
		);
		// tsc exits 1 or 2 when it reports diagnostics; a non-zero exit with none at all is a crash.
		const none = log.runs[0].results.length === 0 && dropped.length === before;
		if (code !== 0 && (none || (code !== 1 && code !== 2))) {
			throw run.fail(
				"toolFailed",
				`tsc exited with code ${code} on ${each}: ${(text || output).slice(0, 4096).trim()}`,
			);
		}
		results.push(...log.runs[0].results);
	}
	if (dropped.length > 0) {
		const dependencies = dropped.filter((path) => path.split(/[\\/]/).includes("node_modules")).length;
		const outside = dropped.length - dependencies;
		notes.push(
			`tsc reported ${dropped.length} diagnostic(s) Melian does not review: ${dependencies} in node_modules and ${outside} outside the repository.`,
		);
	}
	return { version: "2.1.0", runs: [{ tool: { driver: { name: "tsc", version } }, results }] };
}

/** Where {@link runStaticTool} would take a tool from: the checkout's install, Melian's own, or neither. */
export type StaticToolSource =
	| { readonly from: "checkout" | "melian"; readonly path: string }
	| { readonly from: "missing" };

/**
 * Where {@link runStaticTool} takes `tool` from for the checkout at `repoRoot`, by the rule it applies on every run:
 * the checkout's `node_modules/.bin/<tool>` when git does not track that `node_modules`, and otherwise Melian's own.
 * For a host that reports readiness, such as `melian doctor`. Runs git in the Melian process, so pass only a checkout
 * the user trusts, never a revision's tree.
 */
export function staticToolSource(repoRoot: string, tool: StaticTool): StaticToolSource {
	if (tool === "enola") return { from: "missing" };
	const { bin, melian } = toolBinaries[tool];
	const own = posix.join(repoRoot, "node_modules", ".bin", bin);
	const tracked = spawnSync("git", ["-C", repoRoot, "ls-files", "--", "node_modules"], { encoding: "utf8" });
	if (tracked.status === 0 && tracked.stdout === "" && existsSync(own)) return { from: "checkout", path: own };
	try {
		return { from: "melian", path: melian() };
	} catch {
		return { from: "missing" };
	}
}

/**
 * Runs one static tool on one commit, entirely inside `env`. Checks the commit out into a temporary worktree with
 * `git worktree add --detach`, runs the tool there, and removes the
 * worktree, whatever happens. The user's checkout is only read: its `node_modules` is linked into the worktree, so the
 * tool resolves the repository's dependencies. A `node_modules` the revision tracks is removed from the worktree and
 * named in the run's notes.
 *
 * Biome and tsc read that revision's configuration. They use the checkout's `node_modules/.bin/<tool>`, installed from
 * the lockfile, when the checkout does not track it, and otherwise Melian's dependency. Enola uses Melian's
 * manifest-pinned, verified cache executable and judges both revisions with policy copied from `input.base`
 * (or `input.commit` when no base is supplied), with executable providers disabled. Runtime is
 * bounded by `settings.timeout` and output by {@link staticOutputLimit}. tsc is skipped when the revision has no
 * `settings.project`.
 *
 * Biome and tsc run inside the host's sandbox when it has one: no network, a scratch `HOME`, and nothing readable but
 * the worktree and the installs. On a host with none they run unconfined and the run's notes say so.
 *
 * Throws core's `CheckError`: `worktreeFailed`, `toolMissing`, `toolFailed` for a crash or an unexpected exit,
 * `aborted` when `context` is cancelled, `timeout`, `outputTooLarge`, or `invalidOutput`. A failure never returns an empty log.
 */
export async function runStaticTool(input: StaticRunInput, context: Context): Promise<StaticRun> {
	const run = new Run(input, context);
	const { repoRoot, commit, tool } = input;
	return run.inWorktree(async (root, scratch) => {
		if (tool === "tsc") {
			const { project } = input.settings as TscSettings;
			if (posix.isAbsolute(project) || posix.normalize(project).startsWith("..")) {
				throw run.fail("toolFailed", `static.tsc.project ${project} is outside the repository`);
			}
			if (!(await run.exists(posix.join(root, project)))) {
				return { status: "skipped", reason: `${commit} has no ${project}` };
			}
		}
		if (tool === "enola") {
			const tools = input.tools ?? (await ToolProvisioning.open(repoRoot));
			const checked = await (await EnolaRun.open(run, root, scratch, tools)).check();
			return checked.status === "ran" ? { ...checked, notes: [...run.notes, ...checked.notes] } : checked;
		}
		const files = await trackedFiles(run, root, posix.join(scratch, "files"));
		const notes: string[] = [];
		// A tracked node_modules would let the head supply the dependencies, plugins, and type libraries the tool loads.
		for (const directory of trackedModules(files)) {
			notes.push(`${tool} ignored ${directory}, which ${commit.slice(0, 12)} tracks.`);
			await run.shell(`rm -rf ${quote(posix.join(root, directory))}`);
		}
		// The checkout's node_modules is an install from its lockfile, unless the checkout tracks it, as it does when the
		// head under review is what is checked out.
		const checkoutModules = posix.join(repoRoot, "node_modules");
		const checkoutTracked = await trackedFiles(run, repoRoot, posix.join(scratch, "checkout"), "-- node_modules");
		if (checkoutTracked.length > 0) notes.push(`${tool} ignored the checkout's node_modules, which git tracks.`);
		const installed =
			checkoutTracked.length === 0 && (await run.exists(checkoutModules)) ? checkoutModules : undefined;
		const installs = installed === undefined ? [] : await linkDependencies(run, root, scratch, notes);
		// The tool runs by its resolved path, the one the grants name. Reached through a linked checkout, the linked path
		// does not exist inside bubblewrap, and the tool would read as missing.
		const found = await binaryFor(run, installed);
		const real = await input.env.canonicalPath(found, context);
		const binary = real.ok ? real.value : found;
		// The tool's own install, when it is not one of the checkout's: Melian's copy, read from the outermost node_modules
		// above it, so the packages it loads beside itself are readable too.
		const segments = binary.split("/");
		const own = segments.slice(0, segments.indexOf("node_modules") + 1).join("/");
		if (own !== "" && !installs.includes(own)) installs.push(own);
		const unconfined = await run.confine(root, scratch, installs);
		if (unconfined !== undefined) notes.push(unconfined);
		const version = await versionOf(run, binary);
		const log =
			tool === "biome"
				? await runBiome(run, root, scratch, binary, version)
				: await runTsc(run, root, scratch, binary, version, new Set(files), notes);
		return { status: "ran", log, notes: [...run.notes, ...notes] };
	});
}

// Each worktree is locked with the adding process's ID, so a later run can tell a crashed run's worktree from a live one.
// The text and the directory prefix are read by every build that reviews this clone, the oldest with
// `/^melian-static pid (\d+)$/` under `melian-static-*`: a build that cannot parse a lock takes a live run for a
// crashed one and deletes its scratch. Neither may change.
const lockReason = `melian-static pid ${process.pid}`;
const scratchPrefix = "melian-static-";

/**
 * The directory prefix for scratch that only confined cleanup may remove, because head code ran in it. Older builds
 * remove a `melian-static-*` tree on the host, and skip every other name, so such scratch takes this prefix.
 */
export const confinedScratchPrefix = "melian-confined-";

// Cleanup runs even when the caller cancelled, so it never takes the caller's context: a cancelled context makes every
// command return at once, and the worktree would stay registered.
async function removeWorktree(run: Run, scratch: string, mutation = false): Promise<void> {
	const cleanup = new Run({ ...run.input, settings: { ...run.input.settings, timeout: 60 } }, backgroundContext);
	let files = run.mutationScratch;
	if (mutation) {
		const sandbox = await Sandbox.detect(run.input.env, backgroundContext);
		if (sandbox === undefined)
			throw run.fail("worktreeFailed", `cannot safely remove mutation scratch ${scratch}: no sandbox`);
		files = MutationScratch.open(cleanup, scratch, sandbox, []);
	}
	const roots = [posix.join(scratch, "base", "tree"), posix.join(scratch, "tree")];
	if (files !== undefined) {
		for (const root of roots) await files.remove(root);
		await files.close();
		for (const root of roots) await unregister(cleanup, root);
		return;
	}
	for (const root of roots) {
		try {
			await cleanup.worktreeCommand(cleanup.git(`worktree remove --force --force ${quote(root)}`));
		} catch {
			// Best effort: a cleanup failure must not replace the run's result or error.
		}
	}
	await run.input.env.remove(scratch, { recursive: true, force: true }, backgroundContext);
}

// Drops one worktree's registration: the entry under the repository's `worktrees` directory whose `gitdir` file names this
// tree. Never `git worktree prune`, which would also drop the user's own stale worktrees, and never `git worktree remove`,
// which deletes whatever sits at the path by then. The entry holds the lock that marks the tree as head-written, so it
// goes last: a crash before here leaves a locked registration, which the next run finds and replays confined.
async function unregister(cleanup: Run, root: string): Promise<void> {
	const admin = await registration(cleanup, root);
	if (admin === undefined) return;
	const removed = await cleanup.input.env.remove(admin, { recursive: true, force: true }, backgroundContext);
	if (!removed.ok) throw cleanup.fail("worktreeFailed", `could not remove ${admin}: ${removed.error.message}`);
}

// The entry under the repository's `worktrees` directory whose `gitdir` file names this tree, or undefined.
async function registration(cleanup: Run, root: string): Promise<string | undefined> {
	const { env } = cleanup.input;
	const common = await cleanup.shell(cleanup.git("rev-parse --path-format=absolute --git-common-dir"));
	if (common.code !== 0) throw cleanup.fail("worktreeFailed", `git rev-parse failed: ${common.output}`);
	const entries = posix.join(common.output, "worktrees");
	const listed = await env.listDir(entries, backgroundContext);
	if (!listed.ok) {
		if (listed.error.code === "not_found") return undefined;
		throw cleanup.fail("worktreeFailed", `could not list ${entries}: ${listed.error.message}`);
	}
	for (const entry of listed.value) {
		const admin = posix.join(entries, entry.name);
		const named = await env.readTextFile(posix.join(admin, "gitdir"), backgroundContext);
		if (named.ok && posix.resolve(admin, named.value.trim()) === posix.join(root, ".git")) return admin;
	}
}

// What this build writes beside a registration it makes: the tree it added and the process that added it. The file sits
// in the repository's git directory, which no confined command can write.
const markerFile = "melian-static";

// Whether the registration at `admin` carries this build's marker for this tree and this lock: true or false, or
// undefined when it carries none, as a tree added by a build from before the marker does.
async function marked(run: Run, admin: string | undefined, tree: string, pid: string): Promise<boolean | undefined> {
	if (admin === undefined) return undefined;
	const text = await run.input.env.readTextFile(posix.join(admin, markerFile), backgroundContext);
	if (!text.ok) return text.error.code === "not_found" ? undefined : false;
	try {
		const marker = JSON.parse(text.value) as { tree?: unknown; pid?: unknown };
		return marker.tree === tree && marker.pid === Number(pid);
	} catch {
		return false;
	}
}

// A run killed with SIGKILL leaves its worktree registered and its directory in place, which `git worktree prune`
// cannot remove. A worktree is this code's to remove only on proof: it sits where a run puts one, it carries the exact
// lock a run writes, the locking process is gone, and its marker, if it has one, names this tree and that process. A
// path that merely looks like a run's is a user's, left alone and named in the run's notes. Every build that reviews
// this clone reads these registrations, the oldest by lock text and directory name alone, so neither ever changes.
async function removeStaleWorktrees(run: Run, scratch: string): Promise<void> {
	const listing = posix.join(scratch, "worktrees");
	const listed = await run.worktreeCommand(
		`${git(run.input.repoRoot, "worktree list --porcelain -z")} > ${quote(listing)}`,
	);
	if (listed.code !== 0) throw run.fail("worktreeFailed", `git worktree list failed: ${listed.output}`);
	for (const record of ((await run.readOutput(listing)) ?? "").split("\0\0")) {
		const fields = record.split("\0");
		const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
		if (path === undefined || posix.basename(path) !== "tree") continue;
		const parent = posix.dirname(path);
		const owner = posix.basename(parent) === "base" ? posix.dirname(parent) : parent;
		const confined = posix.basename(owner).startsWith(confinedScratchPrefix);
		if ((!confined && !posix.basename(owner).startsWith(scratchPrefix)) || owner === scratch) continue;
		const left = (why: string) => run.notes.push(`${run.input.tool} left the worktree at ${path} alone: ${why}.`);
		// A lock with no reason is listed as the bare word.
		const lock = fields.find((field) => field === "locked" || field.startsWith("locked "))?.slice("locked ".length);
		const pid = /^melian-static pid (\d+)$/.exec(lock ?? "")?.[1];
		if (pid === undefined) {
			left(lock === undefined ? "it is not locked, so it is not a static run's" : "its lock is not a static run's");
			continue;
		}
		if (Number(pid) > 1 && (await run.shell(`kill -0 ${pid} 2> /dev/null`)).code === 0) continue;
		const cleanup = new Run(run.input, backgroundContext);
		const proof = await marked(run, await registration(cleanup, path), path, pid);
		if (proof === false || (proof === undefined && confined)) {
			left(proof === false ? "its marker names another tree or process" : "it has no marker");
			continue;
		}
		for (const component of [owner, parent, path]) {
			const info = await run.input.env.fileInfo(component, run.context);
			if (info.ok && info.value.kind === "symlink")
				throw run.fail("worktreeFailed", `refused symlink ${component} during stale worktree cleanup`);
		}
		if (confined && (await Sandbox.detect(run.input.env, backgroundContext)) === undefined) {
			left("only confined cleanup may remove it, and this host offers no sandbox");
			continue;
		}
		await removeWorktree(run, owner, confined);
	}
}
