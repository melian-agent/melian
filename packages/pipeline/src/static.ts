import { createRequire } from "node:module";
import { dirname, posix } from "node:path";
import {
	CheckError,
	normaliseBiomeSarif,
	parseTscDiagnostics,
	type StaticTool,
	type StaticToolSettings,
	type ToolLog,
	type TscSettings,
} from "@melian-agent/core";
import { backgroundContext, type Context, type ExecutionEnv } from "./harness.ts";

/** The most a static tool may write, its report included. Past it the run fails with `outputTooLarge`. */
export const staticOutputLimit = 16 * 1024 * 1024;

/** What {@link runStaticTool} runs. */
export interface StaticRunInput {
	/** Where the tool runs. Everything the run executes goes through it, never through the Melian process. */
	readonly env: ExecutionEnv;
	/** The repository's checkout, whose git directory the worktree is added to. It is never written to otherwise. */
	readonly repoRoot: string;
	readonly commit: string;
	readonly tool: StaticTool;
	readonly settings: StaticToolSettings | TscSettings;
}

/** A tool's log for one revision, with anything the run set aside, or why the tool does not apply to it. */
export type StaticRun =
	| { readonly status: "ran"; readonly log: ToolLog; readonly notes: readonly string[] }
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

function toolEnvironment(): { env: Record<string, string>; inheritEnv: false } {
	const env: Record<string, string> = {};
	for (const name of passedVariables) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return { env, inheritEnv: false };
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// Hooks and fsmonitor would run the revision's own programs during checkout, outside any tool's timeout.
function git(repoRoot: string, args: string): string {
	return `unset ${gitVariables.join(" ")}; git -C ${quote(repoRoot)} -c core.hooksPath=/dev/null -c core.fsmonitor=false ${args}`;
}

const toolBinaries: Readonly<Record<StaticTool, { readonly bin: string; readonly melian: () => string }>> = {
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

class Run {
	readonly input: StaticRunInput;
	readonly context: Context;
	readonly check: string;

	constructor(input: StaticRunInput, context: Context) {
		this.input = input;
		this.context = context;
		this.check = `static.${input.tool}`;
	}

	fail(code: ConstructorParameters<typeof CheckError>[0], message: string, cause?: unknown): CheckError {
		return new CheckError(code, this.check, message, { cause });
	}

	// Runs a command, keeping the start of what it prints for error messages.
	async shell(command: string): Promise<Shell> {
		let output = "";
		const result = await this.input.env.exec(
			command,
			{
				...toolEnvironment(),
				timeout: this.input.settings.timeout,
				onOutput: (text) => {
					if (output.length < 8192) output += text;
				},
			},
			this.context,
		);
		if (!result.ok) {
			if (result.error.code === "timeout") {
				throw this.fail(
					"timeout",
					`${this.input.tool} ran past its ${this.input.settings.timeout}-second timeout`,
					result.error,
				);
			}
			if (result.error.code === "aborted") {
				throw this.fail("aborted", `${this.input.tool} was cancelled before it finished`, result.error);
			}
			throw this.fail("toolFailed", `${this.input.tool} could not be run: ${result.error.message}`, result.error);
		}
		return { code: result.value.exitCode, output: output.trim() };
	}

	async exists(path: string): Promise<boolean> {
		const result = await this.input.env.exists(path, this.context);
		return result.ok && result.value;
	}

	// Reads a file the tool wrote, refusing one past the output limit rather than truncating it.
	// The tool can replace its output with a symlink or a FIFO, so the target is checked and the read is capped; only a
	// missing file means no output.
	async readOutput(path: string): Promise<string | undefined> {
		const { env, tool } = this.input;
		const unreadable = (detail: string) => this.fail("toolFailed", `${tool}'s output ${path} ${detail}`);
		const target = await env.canonicalPath(path, this.context);
		if (!target.ok) {
			if (target.error.code === "not_found") return undefined;
			throw unreadable(`could not be read: ${target.error.message}`);
		}
		const info = await env.fileInfo(target.value, this.context);
		if (!info.ok) throw unreadable(`could not be read: ${info.error.message}`);
		if (info.value.kind !== "file") throw unreadable(`is a ${info.value.kind}, not a file`);
		const tooLarge = (size: number) =>
			this.fail("outputTooLarge", `${tool} wrote ${size} bytes or more; the limit is ${staticOutputLimit}`);
		if (info.value.size >= staticOutputLimit) throw tooLarge(info.value.size);
		const reader = await env.openTextLineReader(target.value, this.context);
		if (!reader.ok) throw unreadable(`could not be read: ${reader.error.message}`);
		let text = "";
		let bytes = 0;
		try {
			for (;;) {
				const line = await reader.value.readLine(this.context);
				if (!line.ok) throw unreadable(`could not be read: ${line.error.message}`);
				if (line.value === undefined) return text;
				const read = line.value.terminated ? `${line.value.text}\n` : line.value.text;
				text += read;
				bytes += Buffer.byteLength(read);
				if (bytes >= staticOutputLimit) throw tooLarge(bytes);
			}
		} finally {
			await reader.value.close(this.context);
		}
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
async function linkDependencies(run: Run, root: string, scratch: string, notes: string[]): Promise<void> {
	const { env, repoRoot, commit, tool } = run.input;
	const canonical = await env.canonicalPath(repoRoot, run.context);
	const checkout = canonical.ok ? canonical.value : repoRoot;
	const commands: string[] = [];
	const workspaces = new Set<string>();
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
	await link(posix.join(checkout, "node_modules"), posix.join(root, "node_modules"));
	// A workspace package's own node_modules holds the versions only it depends on.
	for (const workspace of workspaces) {
		const nested = posix.join(checkout, workspace, "node_modules");
		if ((await run.exists(nested)) && (await run.exists(posix.join(root, workspace)))) {
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
	if (!(await run.exists(posix.join(checkout, lockfile)))) return;
	const differs = await run.shell(
		`cmp -s ${quote(posix.join(checkout, lockfile))} ${quote(posix.join(root, lockfile))}`,
	);
	if (differs.code !== 0) {
		notes.push(
			`${tool} resolved dependencies from the checkout's install, whose ${lockfile} differs from ${commit.slice(0, 12)}'s.`,
		);
	}
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
	const { code, output } = await run.shell(`${quote(binary)} --version`);
	if (code !== 0) throw run.fail("toolMissing", `${binary} --version failed with exit code ${code}: ${output}`);
	return /\d+\.\d+\.\d+[\w.+-]*/.exec(output)?.[0] ?? "unknown";
}

// `ulimit -f` counts 1,024-byte blocks in bash, or 512-byte blocks in POSIX mode, which only halves the bound.
const fileLimit = `ulimit -f ${staticOutputLimit / 1024}`;

async function runBiome(run: Run, root: string, scratch: string, binary: string, version: string): Promise<ToolLog> {
	const report = posix.join(scratch, "biome.sarif");
	const { code, output } = await run.shell(
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

async function runTsc(
	run: Run,
	root: string,
	scratch: string,
	binary: string,
	version: string,
	tracked: ReadonlySet<string>,
): Promise<ToolLog> {
	const { project } = run.input.settings as TscSettings;
	const out = posix.join(scratch, "tsc.out");
	const { code, output } = await run.shell(
		`cd ${quote(root)} && ${fileLimit} && ${quote(binary)} --noEmit --pretty false -p ${quote(project)} > ${quote(out)} 2>&1`,
	);
	const text = (await run.readOutput(out)) ?? "";
	// A diagnostic names its file by a prefix of its line; the revision's own file list says which prefix is a file.
	const log = parseTscDiagnostics(text, { root, version, project, exists: (path) => tracked.has(path) });
	// tsc exits 1 or 2 when it reports diagnostics; a non-zero exit with none reported is a crash.
	if (code !== 0 && (log.runs[0].results.length === 0 || (code !== 1 && code !== 2))) {
		throw run.fail("toolFailed", `tsc exited with code ${code}: ${(text || output).slice(0, 4096).trim()}`);
	}
	return log;
}

/**
 * Runs one static tool on one commit, entirely inside `env`. Checks the commit out into a temporary worktree with
 * `git worktree add --detach`, runs the tool there, so it reads that revision's own configuration, and removes the
 * worktree, whatever happens. The user's checkout is only read: its `node_modules` is linked into the worktree, so the
 * tool resolves the repository's dependencies. A `node_modules` the revision tracks is removed from the worktree and
 * named in the run's notes.
 *
 * The tool is never a binary from the revision's tree: it is the checkout's `node_modules/.bin/<tool>`, installed from
 * the lockfile, when the checkout does not track it, and otherwise the one Melian depends on. Runtime is
 * bounded by `settings.timeout` and output by {@link staticOutputLimit}. tsc is skipped when the revision has no
 * `settings.project`.
 *
 * Throws core's `CheckError`: `worktreeFailed`, `toolMissing`, `toolFailed` for a crash or an unexpected exit,
 * `aborted` when `context` is cancelled, `timeout`, `outputTooLarge`, or `invalidOutput`. A failure never returns an empty log.
 */
export async function runStaticTool(input: StaticRunInput, context: Context): Promise<StaticRun> {
	const run = new Run(input, context);
	const { env, repoRoot, commit, tool } = input;
	if (!/^[0-9a-f]{40,64}$/.test(commit)) throw run.fail("worktreeFailed", `${commit} is not a full commit hash`);
	const scratchDir = await env.createTempDir("melian-static-", context);
	if (!scratchDir.ok) throw run.fail("worktreeFailed", `no temporary directory: ${scratchDir.error.message}`);
	const canonical = await env.canonicalPath(scratchDir.value, context);
	const scratch = canonical.ok ? canonical.value : scratchDir.value;
	const root = posix.join(scratch, "tree");
	try {
		await removeStaleWorktrees(run, scratch);
		const added = await run.shell(
			git(repoRoot, `worktree add --detach --quiet --lock --reason ${quote(lockReason)} ${quote(root)} ${commit}`),
		);
		if (added.code !== 0) throw run.fail("worktreeFailed", `git worktree add failed: ${added.output}`);
		if (tool === "tsc") {
			const { project } = input.settings as TscSettings;
			if (posix.isAbsolute(project) || posix.normalize(project).startsWith("..")) {
				throw run.fail("toolFailed", `static.tsc.project ${project} is outside the repository`);
			}
			if (!(await run.exists(posix.join(root, project)))) {
				return { status: "skipped", reason: `${commit} has no ${project}` };
			}
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
		if (installed !== undefined) await linkDependencies(run, root, scratch, notes);
		const binary = await binaryFor(run, installed);
		const version = await versionOf(run, binary);
		const log =
			tool === "biome"
				? await runBiome(run, root, scratch, binary, version)
				: await runTsc(run, root, scratch, binary, version, new Set(files));
		return { status: "ran", log, notes };
	} finally {
		await removeWorktree(env, repoRoot, scratch);
	}
}

// Each worktree is locked with the adding process's ID, so a later run can tell a crashed run's worktree from a live one.
const lockReason = `melian-static pid ${process.pid}`;

// Cleanup runs even when the caller cancelled, so it never takes the caller's context: a cancelled context makes every
// command return at once, and the worktree would stay registered.
async function removeWorktree(env: ExecutionEnv, repoRoot: string, scratch: string): Promise<void> {
	const root = posix.join(scratch, "tree");
	// Twice forced, because the worktree is locked.
	await env.exec(
		git(repoRoot, `worktree remove --force --force ${quote(root)}`),
		{ ...toolEnvironment(), timeout: 60 },
		backgroundContext,
	);
	await env.exec(git(repoRoot, "worktree prune"), { ...toolEnvironment(), timeout: 60 }, backgroundContext);
	await env.remove(scratch, { recursive: true, force: true }, backgroundContext);
}

// A run killed with SIGKILL leaves its worktree registered and its directory in place, which `git worktree prune`
// cannot remove. Any Melian worktree whose locking process is gone is removed before a new one is added.
async function removeStaleWorktrees(run: Run, scratch: string): Promise<void> {
	const listing = posix.join(scratch, "worktrees");
	const listed = await run.shell(`${git(run.input.repoRoot, "worktree list --porcelain -z")} > ${quote(listing)}`);
	if (listed.code !== 0) throw run.fail("worktreeFailed", `git worktree list failed: ${listed.output}`);
	for (const record of ((await run.readOutput(listing)) ?? "").split("\0\0")) {
		const fields = record.split("\0");
		const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
		if (path === undefined || posix.basename(path) !== "tree") continue;
		const owner = posix.dirname(path);
		if (!posix.basename(owner).startsWith("melian-static-") || owner === scratch) continue;
		const lock = fields.find((field) => field.startsWith("locked "))?.slice("locked ".length) ?? "";
		const pid = /^melian-static pid (\d+)$/.exec(lock)?.[1];
		if (pid !== undefined && (await run.shell(`kill -0 ${pid} 2> /dev/null`)).code === 0) continue;
		await removeWorktree(run.input.env, run.input.repoRoot, owner);
	}
}
