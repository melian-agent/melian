// Main's stale-worktree cleanup and the `Run` it works through, copied verbatim from 22a821b2
// (packages/pipeline/src/static.ts lines 49-88, 101-222, and 504-541), the build before the sandbox boundary. A
// registration is a shape every build that reviews a clone shares, so this is the old reader this build's registrations
// are tested against. Never edit the copied code. Only the imports and the exports at the end are this file's own,
// and `Run` lost its `export` keyword so the last line can name it.

import { posix } from "node:path";
import { CheckError } from "@melian-agent/core";
import { backgroundContext, type Context } from "../../src/harness.ts";
import { type StaticRunInput, staticOutputLimit } from "../../src/static.ts";

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

	git(args: string, root = this.input.repoRoot): string {
		return git(root, args);
	}

	fail(code: ConstructorParameters<typeof CheckError>[0], message: string, cause?: unknown): CheckError {
		return new CheckError(code, this.check, message, { cause });
	}

	// Runs a command, keeping the start of what it prints for error messages.
	async shell(command: string, timeout = this.input.settings.timeout): Promise<Shell> {
		let output = "";
		const result = await this.input.env.exec(
			command,
			{
				...toolEnvironment(),
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
		const created = await env.createTempDir("melian-static-", this.context);
		if (!created.ok) throw this.fail("worktreeFailed", `no temporary directory: ${created.error.message}`);
		const canonical = await env.canonicalPath(created.value, this.context);
		const scratch = canonical.ok ? canonical.value : created.value;
		const root = posix.join(scratch, "tree");
		try {
			await removeStaleWorktrees(this, scratch);
			const added = await this.worktreeCommand(
				this.git(`worktree add --detach --quiet --lock --reason ${quote(lockReason)} ${quote(root)} ${commit}`),
			);
			if (added.code !== 0) throw this.fail("worktreeFailed", `git worktree add failed: ${added.output}`);
			return await use(root, scratch);
		} finally {
			await removeWorktree(this, scratch);
		}
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

// Each worktree is locked with the adding process's ID, so a later run can tell a crashed run's worktree from a live one.
const lockReason = `melian-static pid ${process.pid}`;

// Cleanup runs even when the caller cancelled, so it never takes the caller's context: a cancelled context makes every
// command return at once, and the worktree would stay registered.
async function removeWorktree(run: Run, scratch: string): Promise<void> {
	const cleanup = new Run({ ...run.input, settings: { ...run.input.settings, timeout: 60 } }, backgroundContext);
	for (const root of [posix.join(scratch, "base", "tree"), posix.join(scratch, "tree")]) {
		try {
			await cleanup.worktreeCommand(cleanup.git(`worktree remove --force --force ${quote(root)}`));
		} catch {
			// Best effort: a cleanup failure must not replace the run's result or error.
		}
	}
	await run.input.env.remove(scratch, { recursive: true, force: true }, backgroundContext);
}

// A run killed with SIGKILL leaves its worktree registered and its directory in place, which `git worktree prune`
// cannot remove. Any Melian worktree whose locking process is gone is removed before a new one is added.
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
		if (!posix.basename(owner).startsWith("melian-static-") || owner === scratch) continue;
		const lock = fields.find((field) => field.startsWith("locked "))?.slice("locked ".length) ?? "";
		const pid = /^melian-static pid (\d+)$/.exec(lock)?.[1];
		if (pid !== undefined && (await run.shell(`kill -0 ${pid} 2> /dev/null`)).code === 0) continue;
		await removeWorktree(run, owner);
	}
}

export { Run as RunV1, removeStaleWorktrees as removeStaleWorktreesV1 };
