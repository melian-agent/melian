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
import type { Context, ExecutionEnv } from "./harness.ts";

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

/** A tool's log for one revision, or why the tool does not apply to it. */
export type StaticRun =
	| { readonly status: "ran"; readonly log: ToolLog }
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
			throw this.fail("toolFailed", `${this.input.tool} could not be run: ${result.error.message}`, result.error);
		}
		return { code: result.value.exitCode, output: output.trim() };
	}

	async exists(path: string): Promise<boolean> {
		const result = await this.input.env.exists(path, this.context);
		return result.ok && result.value;
	}

	// Reads a file the tool wrote, refusing one past the output limit rather than truncating it.
	async readOutput(path: string): Promise<string | undefined> {
		const info = await this.input.env.fileInfo(path, this.context);
		if (!info.ok) return undefined;
		if (info.value.size >= staticOutputLimit) {
			throw this.fail(
				"outputTooLarge",
				`${this.input.tool} wrote ${info.value.size} bytes; the limit is ${staticOutputLimit}`,
			);
		}
		const text = await this.input.env.readTextFile(path, this.context);
		if (!text.ok)
			throw this.fail("toolFailed", `${this.input.tool}'s output could not be read: ${text.error.message}`);
		return text.value;
	}
}

async function binaryFor(run: Run, root: string): Promise<string> {
	const { bin, melian } = toolBinaries[run.input.tool];
	const own = posix.join(root, "node_modules", ".bin", bin);
	if (await run.exists(own)) return own;
	try {
		return melian();
	} catch (cause) {
		throw run.fail("toolMissing", `${bin} is in neither the repository's node_modules nor Melian's`, cause);
	}
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

async function runTsc(run: Run, root: string, scratch: string, binary: string, version: string): Promise<ToolLog> {
	const { project } = run.input.settings as TscSettings;
	const out = posix.join(scratch, "tsc.out");
	const { code, output } = await run.shell(
		`cd ${quote(root)} && ${fileLimit} && ${quote(binary)} --noEmit --pretty false -p ${quote(project)} > ${quote(out)} 2>&1`,
	);
	const text = (await run.readOutput(out)) ?? "";
	const log = parseTscDiagnostics(text, { root, version, project });
	// tsc exits 1 or 2 when it reports diagnostics; a non-zero exit with none reported is a crash.
	if (code !== 0 && (log.runs[0].results.length === 0 || (code !== 1 && code !== 2))) {
		throw run.fail("toolFailed", `tsc exited with code ${code}: ${(text || output).slice(0, 4096).trim()}`);
	}
	return log;
}

/**
 * Runs one static tool on one commit, entirely inside `env`. Checks the commit out into a temporary worktree with
 * `git worktree add --detach`, runs the tool there, so it reads that revision's own configuration, and removes the
 * worktree, whatever happens. The user's checkout is only read: its `node_modules` is linked into the worktree when the
 * revision has none, so the tool resolves the repository's dependencies.
 *
 * The tool is the worktree's `node_modules/.bin/<tool>` when present, otherwise the one Melian depends on. Runtime is
 * bounded by `settings.timeout` and output by {@link staticOutputLimit}. tsc is skipped when the revision has no
 * `settings.project`.
 *
 * Throws core's `CheckError`: `worktreeFailed`, `toolMissing`, `toolFailed` for a crash or an unexpected exit,
 * `timeout`, `outputTooLarge`, or `invalidOutput`. A failure never returns an empty log.
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
		const added = await run.shell(git(repoRoot, `worktree add --detach --quiet ${quote(root)} ${commit}`));
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
		const modules = posix.join(root, "node_modules");
		const checkoutModules = posix.join(repoRoot, "node_modules");
		if (!(await run.exists(modules)) && (await run.exists(checkoutModules))) {
			await run.shell(`ln -s ${quote(checkoutModules)} ${quote(modules)}`);
		}
		const binary = await binaryFor(run, root);
		const version = await versionOf(run, binary);
		const log =
			tool === "biome"
				? await runBiome(run, root, scratch, binary, version)
				: await runTsc(run, root, scratch, binary, version);
		return { status: "ran", log };
	} finally {
		await env.exec(git(repoRoot, `worktree remove --force ${quote(root)}`), { timeout: 60 }, context);
		await env.exec(git(repoRoot, "worktree prune"), { timeout: 60 }, context);
		await env.remove(scratch, { recursive: true, force: true }, context);
	}
}
