import { execFile } from "node:child_process";
import { constants, existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, open as openFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { WriterTrust } from "./checks.ts";
import { backgroundContext, createNodeExecutionEnv } from "./harness.ts";
import { linkDependencies } from "./link-dependencies.ts";
import { closeGraceMs, ProbeProcess } from "./probe-process.ts";

// The runner the sandbox executes imports the watchdog, then the probe's own module, both statically: a module's imports
// evaluate in order, so the watchdog is armed before the probe runs. The watchdog exits the probe at `deadline`
// milliseconds even if nothing outside the sandbox stops it. Its timer is unref'd, so a probe that finishes leaves at
// its own exit code; a probe that hangs keeps the event loop alive until the timer fires and exits 124.
function runnerSource(): string {
	return `import "./${watchdogName}";\nimport "./${scriptName}";\n`;
}

function watchdogSource(deadline: number): string {
	return `setTimeout(() => process.exit(124), ${deadline}).unref();\n`;
}

// The backstop past Melian's own deadline, in milliseconds. A probe that never yields never lets the watchdog's timer
// fire, so the runner also runs under a CPU-time limit of this many seconds, which the kernel enforces.
function backstop(timeout: number): number {
	return timeout + closeGraceMs + 5_000;
}

// Rejects with a {@link ProbeError} if `work` has not settled within `ms`, so a step that can hang, such as starting the
// sandbox, cannot stall a caller unbounded. The timer is unref'd so it never keeps the process alive on its own.
export function withBound<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new ProbeError("sandboxUnavailable", `${message} within ${ms / 1000}s`)),
			ms,
		);
		timer.unref();
		work.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/** The bounds a probe runs within. A time or output limit past its `max` is refused. */
export const probeLimits = {
	timeout: { default: 30_000, max: 600_000 },
	output: { default: 65_536, max: 1_048_576 },
	script: 262_144,
	files: 64,
	fileBytes: 1_048_576,
	path: 200,
	/** How long starting the sandbox (open and wrap) may take, apart from the probe's own time limit. */
	setup: 120_000,
} as const;

/** A fixture file a probe's script reads, at a relative path beside the script, as text or as raw bytes. */
export interface ProbeFile {
	readonly path: string;
	readonly text?: string;
	/** Raw bytes for a binary fixture, used in place of `text` and never decoded. */
	readonly bytes?: Uint8Array;
}

/** The bytes a fixture carries, from its raw `bytes` or its `text`. */
function fileBytes(file: ProbeFile): Uint8Array {
	return file.bytes ?? Buffer.from(file.text ?? "");
}

/** A probe: a Node ES module, run as `probe.mjs` with its files beside it and the head's tracked tree as its directory. */
export interface ProbeInput {
	readonly script: string;
	readonly files?: readonly ProbeFile[];
}

/**
 * What a probe's filesystem allows. Every entry but `denyGlobs` is a literal path: the wrap passes it to sandbox-runtime
 * as `{ path, literal: true }`, so a worktree whose name holds `*` or `**` cannot read as a glob. `denyGlobs` carries the
 * deny-read patterns, such as `**​/.env*`, which only ever deny, so a broad match is safe.
 */
export interface ProbePolicy {
	readonly read: readonly string[];
	readonly deny: readonly string[];
	readonly denyGlobs: readonly string[];
	readonly write: readonly string[];
	readonly denyWrite: readonly string[];
}

/** The sandbox a probe runs under. {@link Probe} uses sandbox-runtime's; a test may pass its own. */
export interface ProbeSandbox {
	/** Which system's programs and libraries a probe reads. */
	readonly platform: "darwin" | "linux";
	/** Why a probe cannot run here, or `undefined` when it can. */
	unavailable(): string | undefined;
	open(): Promise<void>;
	/** The argv that runs `command` under `policy`, with no network. */
	wrap(command: string, policy: ProbePolicy): Promise<readonly string[]>;
	cleanup(): void;
	close(): Promise<void>;
}

/**
 * The head a probe reads. Its tracked tree is written from git's objects into the probe's scratch, never read from the
 * checkout's working tree, so an untracked, modified or staged file there stays out of the probe's reach.
 */
export interface ProbeHead {
	/** The repository whose objects hold the commit, and whose dependency install the probe may read. */
	readonly checkout: string;
	/** The full hash of the commit under review. */
	readonly commit: string;
	/**
	 * The base policy's `probe.read`: paths relative to the checkout that the probe needs beyond the tracked tree.
	 * `node_modules` links the dependency install in; any other path is copied in when the probe opens. Defaults to
	 * `["node_modules"]`.
	 */
	readonly read?: readonly string[];
}

export interface ProbeOptions {
	/** The head the probe runs in and reads, never writes. Without one, its directory is empty. */
	readonly head?: ProbeHead;
	/** The host's decision on whether the head's code may run here, as `static.mutation` takes it. */
	readonly writer: WriterTrust;
	/** The base policy's `trust.writers`; `false` refuses a writer's head. */
	readonly trustWriters: boolean;
	/** Milliseconds; {@link probeLimits} sets the default and the bound. */
	readonly timeout?: number;
	/** Bytes of standard output and standard error, together; {@link probeLimits} sets the default and the bound. */
	readonly outputLimit?: number;
	readonly sandbox?: ProbeSandbox;
}

export interface ProbeResult {
	/** `null` when a signal ended the probe. */
	readonly exitCode: number | null;
	readonly signal: string | null;
	/** Standard output and standard error, interleaved as they arrived, at most the output limit. */
	readonly output: string;
	/** The output passed its limit, was cut there, and the probe was ended. */
	readonly truncated: boolean;
	readonly timedOut: boolean;
	/** Why stopping the probe's processes failed, when it did, such as a process table that could not be read. */
	readonly error?: string;
}

export type ProbeErrorCode = "headNotAllowed" | "sandboxUnavailable" | "invalidProbe" | "closed";

export class ProbeError extends Error {
	readonly code: ProbeErrorCode;

	constructor(code: ProbeErrorCode, message: string, options: { cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "ProbeError";
		this.code = code;
	}
}

export type ProbeAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

/** What {@link Probe.close} did: it removed the scratch, or it left it in place with the reason it could not remove it. */
export type CleanupOutcome =
	| { readonly removed: true }
	| { readonly removed: false; readonly leftover: string; readonly reason: string };

const segment = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const scriptName = "probe.mjs";
const runnerName = "run.mjs";
const watchdogName = "watchdog.mjs";

// The operating system's programs and libraries, which Node and a shell need to start. They hold no user's data.
const systemReads: Readonly<Record<"darwin" | "linux", readonly string[]>> = {
	darwin: [
		"/bin",
		"/sbin",
		"/usr/bin",
		"/usr/sbin",
		"/usr/lib",
		"/usr/libexec",
		"/usr/share",
		"/System",
		"/private/var/select",
	],
	linux: [
		"/bin",
		"/sbin",
		"/lib",
		"/lib32",
		"/lib64",
		"/libx32",
		"/usr/bin",
		"/usr/sbin",
		"/usr/lib",
		"/usr/lib32",
		"/usr/lib64",
		"/usr/libexec",
		"/usr/share",
	],
};

// What the head's tree and the dependency install can hold that is no probe's business: a package can ship an `.npmrc`
// or a `.git`, and a tracked tree an `.env`. Each pattern matches a name at any depth.
const denyGlobs = ["**/.env*", "**/.npmrc", "**/.git", "**/.git/**", "**/melian.secrets.yaml", "**/melian.local.yaml"];

// Every stored blob is written as git holds it: no filter, such as a decrypting smudge or LFS, and no line-ending or
// ident conversion. The temporary repository's own attributes override every `.gitattributes` the tree holds.
const asStored = "* -text -eol -ident -filter -working-tree-encoding\n";

const execFileAsync = promisify(execFile);

// git with no system or user configuration, so the reviewer's own aliases, filters and hooks never apply.
async function git(cwd: string, args: readonly string[], home: string, more: Record<string, string> = {}) {
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	return (await execFileAsync("git", args, { cwd, env: { ...env, ...more } })).stdout.trim();
}

async function shell(command: string): Promise<{ code: number; output: string }> {
	return execFileAsync("/bin/sh", ["-c", command], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }).then(
		(done) => ({ code: 0, output: done.stdout }),
		(error: { code?: number; stderr?: string }) => ({ code: error.code ?? 1, output: error.stderr ?? "" }),
	);
}

interface PlannedHead {
	readonly checkout: string;
	readonly commit: string;
	readonly entries: readonly (readonly [string, string])[];
}

function planned(head: ProbeHead): PlannedHead {
	const checkout = directory(head.checkout, "the checkout");
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head.commit))
		throw new ProbeError("invalidProbe", `${head.commit} is not a full commit hash`);
	return { checkout, commit: head.commit, entries: allowed(checkout, head.read ?? ["node_modules"]) };
}

// Each `probe.read` entry with the real path it names. Refuses an absolute path, a `..` segment, and any path that
// resolves to the checkout itself or outside it; a path absent from the checkout gives nothing to copy.
function allowed(checkout: string, read: readonly string[]): readonly (readonly [string, string])[] {
	return read.flatMap((entry) => {
		const refusal = new ProbeError(
			"invalidProbe",
			`probe.read may name only a relative path inside the checkout, not ${entry}`,
		);
		if (isAbsolute(entry) || entry.split("/").includes("..")) throw refusal;
		const path = join(checkout, entry);
		if (!existsSync(path)) return [];
		const real = realpathSync(path);
		const inside = relative(checkout, real);
		if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) throw refusal;
		return [[entry, real] as const];
	});
}

// The head chooses its links, and setup writes into the tree as the reviewer, before the sandbox starts. A link that
// leads outside the tree, to its root, or into a node_modules, where the install's links to the host land, would carry a
// later write to the host, so a head holding one is refused. Each link resolves one component at a time, as the kernel
// resolves it: folding `..` first would read `sub/..`, with `sub -> .`, as inside.
function refuseLinksOut(tree: string): void {
	const root = realpathSync.native(tree);
	const pending = [root];
	for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isSymbolicLink() && !staysInside(root, path))
				throw new ProbeError(
					"invalidProbe",
					`the head's link ${relative(root, path)} leads outside its tree or into its node_modules`,
				);
		}
	}
}

// What the filesystem holds at `path`, without following a link there. A component under a regular file is missing, as
// one that is absent is.
function entryAt(path: string): ReturnType<typeof lstatSync> {
	try {
		return lstatSync(path, { throwIfNoEntry: false });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
		throw error;
	}
}

// Each component resolves through realpath(3), which names it as the filesystem stores it: on one that ignores case,
// `NODE_MODULES` comes back as the tree's `node_modules`, which the comparison below then sees.
function staysInside(root: string, link: string): boolean {
	const parts = readlinkSync(link).split("/");
	let at = parts[0] === "" ? "/" : realpathSync.native(dirname(link));
	for (const [index, part] of parts.entries()) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			at = dirname(at);
			continue;
		}
		const next = join(at, part);
		if (entryAt(next) === undefined) {
			// Nothing past a missing component can be resolved yet, and a `..` there could climb once it exists.
			if (parts.slice(index + 1).includes("..")) return false;
			at = join(next, ...parts.slice(index + 1));
			break;
		}
		try {
			at = realpathSync.native(next);
		} catch {
			return false;
		}
	}
	const inside = relative(root, at);
	return (
		inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !inside.split(sep).includes("node_modules")
	);
}

// Writes the head's tracked tree into `tree` from a temporary repository that borrows the checkout's objects, then the
// allowed paths. Returns the install directories the tree's links lead into, which the probe may read.
async function writeHead({ checkout, commit, entries }: PlannedHead, tree: string): Promise<readonly string[]> {
	const repository = realpathSync(await mkdtemp(join(tmpdir(), "melian-head-")));
	try {
		const common = await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"], repository);
		await git(repository, ["init", "--quiet", "--bare", "--template=", repository], repository);
		await mkdir(join(repository, "objects", "info"), { recursive: true });
		await mkdir(join(repository, "info"), { recursive: true });
		await writeFile(join(repository, "objects", "info", "alternates"), `${join(common, "objects")}\n`);
		await writeFile(join(repository, "info", "attributes"), asStored);
		const at = { GIT_DIR: repository, GIT_WORK_TREE: tree };
		await git(tree, ["read-tree", commit], repository, at);
		await git(tree, ["checkout-index", "--all"], repository, at);
		// The install's directory exists before the walks, so a link to another spelling of it resolves to it.
		const linking = entries.some(([entry]) => entry === "node_modules") && !existsSync(join(tree, "node_modules"));
		if (linking) await mkdir(join(tree, "node_modules"));
		refuseLinksOut(tree);
		const copies = entries.filter(([entry]) => entry !== "node_modules");
		for (const [entry, real] of copies) {
			const target = join(tree, entry);
			await mkdir(dirname(target), { recursive: true });
			await cp(real, target, { recursive: true, verbatimSymlinks: true, force: true });
		}
		// A copy comes from the reviewer's checkout, and its links are kept as written.
		if (copies.length > 0) refuseLinksOut(tree);
		const installs: string[] = [];
		if (linking) {
			const env = createNodeExecutionEnv(checkout);
			const linked = await linkDependencies(env, backgroundContext, checkout, tree, repository, shell);
			if ("failed" in linked) throw new ProbeError("invalidProbe", `the dependency install: ${linked.failed}`);
			installs.push(...linked.linked.flatMap((path) => [path, realpathSync(path)]));
		}
		return [...new Set(installs)];
	} catch (error) {
		if (error instanceof ProbeError) throw error;
		throw new ProbeError(
			"invalidProbe",
			`the head ${commit} could not be written from ${checkout}: ${String(error)}`,
			{
				cause: error,
			},
		);
	} finally {
		await rm(repository, { recursive: true, force: true });
	}
}

// A parent env variable sandbox-runtime embeds in the wrapped command verbatim, so its value would reach a probe.
// JAVA_TOOL_OPTIONS can carry JVM-property credentials; denying it drops the inherited value from the wrap. The only
// other parent variable that survives is CLAUDE_CODE_TMPDIR, a path the probe's own `export TMPDIR` overrides, not a
// secret, so it is left alone.
const deniedEnvVars = ["JAVA_TOOL_OPTIONS"];

// sandbox-runtime's reads of Node's install, for a probe's `node`. The grandparent of the executable is granted only
// when it is a Node-only prefix, such as an nvm or a `node-*` directory; `/usr/bin/node`'s grandparent `/usr` would
// expose `/usr/local/etc/npmrc`, so a system install grants the binary and its module directory alone, both already
// under the system reads.
export function nodeReads(execPath: string): readonly string[] {
	const real = realpathSync(execPath);
	const prefix = dirname(dirname(real));
	const segments = prefix.split(sep);
	const nodeOnly =
		segments.includes(".nvm") ||
		/^node(-|$)/.test(basename(prefix)) ||
		(/^v?\d+\.\d+\.\d+/.test(basename(prefix)) && basename(dirname(prefix)) === "node");
	return (nodeOnly ? [prefix] : [real, join(prefix, "lib", "node_modules")]).filter((path) => existsSync(path));
}

// The length of the largest prefix of `buf` that ends on a complete UTF-8 sequence, so a cut never leaves a half
// character to decode as a replacement.
export function completeUtf8(buf: Buffer): number {
	let start = buf.length;
	while (start > 0 && (buf[start - 1]! & 0xc0) === 0x80) start--;
	if (start === 0) return buf.length;
	const lead = buf[start - 1]!;
	const expected =
		(lead & 0x80) === 0
			? 1
			: (lead & 0xe0) === 0xc0
				? 2
				: (lead & 0xf0) === 0xe0
					? 3
					: (lead & 0xf8) === 0xf0
						? 4
						: 0;
	if (expected === 0) return buf.length;
	return buf.length - (start - 1) >= expected ? buf.length : start - 1;
}

function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

function bounded(name: string, value: number | undefined, limit: { default: number; max: number }): number {
	if (value === undefined) return limit.default;
	if (!Number.isSafeInteger(value) || value < 1 || value > limit.max)
		throw new ProbeError("invalidProbe", `${name} must be a whole number from 1 to ${limit.max}`);
	return value;
}

function validFiles(input: ProbeInput): readonly ProbeFile[] {
	if (typeof input.script !== "string" || Buffer.byteLength(input.script) > probeLimits.script)
		throw new ProbeError("invalidProbe", `a probe's script is text of at most ${probeLimits.script} bytes`);
	const files = input.files ?? [];
	if (files.length > probeLimits.files)
		throw new ProbeError("invalidProbe", `a probe has at most ${probeLimits.files} files`);
	const seen = new Set<string>([scriptName, runnerName, watchdogName]);
	let bytes = 0;
	for (const file of files) {
		const parts = file.path.split("/");
		if (file.path.length > probeLimits.path || !parts.every((part) => segment.test(part)))
			throw new ProbeError(
				"invalidProbe",
				`a probe file's path is relative, at most ${probeLimits.path} characters, of letters, digits, '.', '_' and '-', and no segment starts with '.' or '-': ${JSON.stringify(file.path)}`,
			);
		// A case-insensitive filesystem opens two spellings as one file.
		const key = file.path.toLowerCase();
		const prefixes = parts.slice(0, -1).map((_, index) =>
			parts
				.slice(0, index + 1)
				.join("/")
				.toLowerCase(),
		);
		if (
			seen.has(key) ||
			prefixes.some((prefix) => seen.has(prefix)) ||
			[...seen].some((other) => other.startsWith(`${key}/`))
		)
			throw new ProbeError(
				"invalidProbe",
				`a probe file's path collides with another: ${JSON.stringify(file.path)}`,
			);
		seen.add(key);
		bytes += fileBytes(file).length;
	}
	if (bytes > probeLimits.fileBytes)
		throw new ProbeError("invalidProbe", `a probe's files hold at most ${probeLimits.fileBytes} bytes`);
	return files;
}

function leave(options: ProbeOptions): void {
	const { writer } = options;
	if (!writer.trusted) throw new ProbeError("headNotAllowed", `the head's code may not run here: ${writer.detail}`);
	if (writer.by === "writer" && !options.trustWriters)
		throw new ProbeError(
			"headNotAllowed",
			"the head's code may not run here: trust.writers is false in the repository's policy",
		);
}

function directory(path: string, what: string): string {
	let real: string;
	try {
		real = realpathSync(path);
	} catch (error) {
		throw new ProbeError("invalidProbe", `${what} ${path} cannot be read`, { cause: error });
	}
	if (!statSync(real).isDirectory()) throw new ProbeError("invalidProbe", `${what} ${path} is not a directory`);
	const home = realpathSync(homedir());
	const outside = relative(real, home);
	// A worktree at or above the reviewer's home would hand the probe all of it.
	if (outside !== ".." && !outside.startsWith(`..${sep}`))
		throw new ProbeError("invalidProbe", `${what} ${path} holds the home directory`);
	return real;
}

// The installed package's own directory: Linux runs its seccomp helper from there.
function runtimePackage(): string {
	return dirname(dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))));
}

/** The parts of sandbox-runtime's manager a probe uses. */
export type SandboxRuntime = Pick<
	typeof SandboxManager,
	"isSupportedPlatform" | "checkDependencies" | "initialize" | "wrapWithSandboxArgv" | "cleanupAfterCommand" | "reset"
>;

// sandbox-runtime's manager is one per process, so every wrapper of one runtime shares its session count and queue; a
// count of its own would let one wrapper's last close reset the manager under another's open probe.
const sessionsOf = new WeakMap<SandboxRuntime, { count: number; queue: Promise<void> }>();

/** sandbox-runtime as a {@link ProbeSandbox}. Its manager is one per process, so one session serves every open probe. */
export class RuntimeSandbox implements ProbeSandbox {
	readonly platform: "darwin" | "linux";
	readonly #name: string;
	readonly #runtime: SandboxRuntime;
	// open and close run one at a time on the shared manager, so a reset can never complete after a newer open tears its
	// session down. Each call waits for the ones before it, and a thrown step does not poison the chain.
	readonly #sessions: { count: number; queue: Promise<void> };

	constructor(runtime: SandboxRuntime = SandboxManager, name: string = platform()) {
		this.#runtime = runtime;
		this.#sessions = sessionsOf.get(runtime) ?? { count: 0, queue: Promise.resolve() };
		sessionsOf.set(runtime, this.#sessions);
		this.#name = name;
		this.platform = name === "darwin" ? "darwin" : "linux";
	}

	// A confinement tool's dependency warnings each weaken it: a missing seccomp helper leaves unix sockets unrestricted,
	// an old bubblewrap cannot mask a non-regular file, a library in a writable path can be rewritten. So a warning is as
	// fatal as an error, and a probe is refused rather than run less confined than it says.
	unavailable(): string | undefined {
		if (this.#name !== "darwin" && this.#name !== "linux") return `probes run on macOS and Linux, not ${this.#name}`;
		if (!this.#runtime.isSupportedPlatform()) return "sandbox-runtime does not support this platform";
		const { errors, warnings } = this.#runtime.checkDependencies();
		const problems = [...errors, ...warnings];
		return problems.length === 0 ? undefined : `sandbox-runtime cannot run here: ${problems.join("; ")}`;
	}

	#enqueue(step: () => Promise<void>): Promise<void> {
		const run = this.#sessions.queue.then(step);
		this.#sessions.queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	open(): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#sessions.count === 0)
				await this.#runtime.initialize({
					network: { allowedDomains: [], deniedDomains: [] },
					filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
				});
			this.#sessions.count++;
		});
	}

	async wrap(command: string, policy: ProbePolicy): Promise<readonly string[]> {
		const literal = (path: string) => ({ path, literal: true as const });
		const { argv } = await this.#runtime.wrapWithSandboxArgv(command, "/bin/bash", {
			network: { allowedDomains: [], deniedDomains: [] },
			filesystem: {
				denyRead: [...policy.deny.map(literal), ...policy.denyGlobs],
				allowRead: policy.read.map(literal),
				allowWrite: policy.write.map(literal),
				denyWrite: policy.denyWrite.map(literal),
			},
			credentials: { envVars: deniedEnvVars.map((name) => ({ name, mode: "deny" as const })) },
		});
		return argv;
	}

	cleanup(): void {
		this.#runtime.cleanupAfterCommand();
	}

	close(): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#sessions.count === 0) return;
			this.#sessions.count--;
			if (this.#sessions.count === 0) await this.#runtime.reset();
		});
	}
}

// One per process, since sandbox-runtime's manager is.
const runtime = new RuntimeSandbox();

// The scratch's own fixed directories, those close() may make writable so `rm` can remove them. `probe` and `run` sit
// directly under the scratch, which the probe cannot write, so their names cannot be swapped; `run/home` and `run/tmp`
// sit under the writable `run`, so a survivor could swap one for a symlink, and the open below guards against that.
const fixedScratchDirs = ["probe", "run", join("run", "home"), join("run", "tmp")];

// Makes each fixed scratch directory writable through an O_NOFOLLOW, O_DIRECTORY descriptor and changes its mode through
// that descriptor alone. Cleanup never changes a mode or lists a directory by path: a survivor that swaps one of these
// for a symlink to a host directory makes the open fail (ELOOP), which skips it, rather than chmodding the target. Every
// component above each of these is a directory the probe cannot write, so the path cannot be swapped on the way down.
// Anything the probe locked deeper inside `run` is left for `rm`; if `rm` then cannot remove it, close() reports it.
export async function relaxScratch(scratch: string): Promise<void> {
	for (const relative of ["", ...fixedScratchDirs]) {
		let handle: Awaited<ReturnType<typeof openFile>> | undefined;
		try {
			handle = await openFile(
				join(scratch, relative),
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			await handle.chmod(0o700);
		} catch {
			// Gone, or swapped for a symlink, or already unopenable: leave it for rm, which close() reports if it blocks.
		} finally {
			await handle?.close();
		}
	}
}

/**
 * One probe: a script and its files, run under sandbox-runtime with no network, a scratch home, writes to its scratch
 * directory alone and reads of the head's tracked tree, its dependency install, Node and the system's libraries alone. Open it with
 * {@link Probe.open}, run it with {@link Probe.run} as often as needed, and {@link Probe.close} it to remove its scratch.
 */
export class Probe {
	readonly #scratch: string;
	readonly #installs: readonly string[];
	readonly #timeout: number;
	readonly #outputLimit: number;
	readonly #sandbox: ProbeSandbox;
	#closed = false;
	#running = false;
	// A wrap still running past its setup bound, released once it settles. close() waits for it before releasing the
	// session, since a reset under it would let its late release take a newer probe's resources.
	#lateWrap: Promise<void> | undefined;

	private constructor(
		scratch: string,
		installs: readonly string[],
		limits: { timeout: number; output: number },
		sandbox: ProbeSandbox,
	) {
		this.#scratch = scratch;
		this.#installs = installs;
		this.#timeout = limits.timeout;
		this.#outputLimit = limits.output;
		this.#sandbox = sandbox;
	}

	/**
	 * Writes the probe into a fresh scratch directory and opens the sandbox. Throws {@link ProbeError}: `headNotAllowed`
	 * for a head the host has not allowed, `invalidProbe` for a script, file, limit or directory out of bounds, and
	 * `sandboxUnavailable` where the sandbox cannot run, so a probe never runs unconfined.
	 */
	static async open(input: ProbeInput, options: ProbeOptions): Promise<Probe> {
		leave(options);
		const files = validFiles(input);
		const limits = {
			timeout: bounded("timeout", options.timeout, probeLimits.timeout),
			output: bounded("outputLimit", options.outputLimit, probeLimits.output),
		};
		const sandbox = options.sandbox ?? runtime;
		const reason = sandbox.unavailable();
		if (reason !== undefined) throw new ProbeError("sandboxUnavailable", reason);
		const head = options.head === undefined ? undefined : planned(options.head);
		const scratch = realpathSync(await mkdtemp(join(tmpdir(), "melian-probe-")));
		let installs: readonly string[] = [];
		try {
			for (const path of ["probe", "run/home", "run/tmp", "tree"])
				await mkdir(join(scratch, path), { recursive: true });
			if (head !== undefined) installs = await writeHead(head, join(scratch, "tree"));
			await writeFile(join(scratch, "probe", scriptName), input.script);
			// A watchdog inside the runner exits the probe at its own limit even if the Melian process dies and so never
			// stops it. It is a backstop past Melian's own deadline, so a running Melian stops the probe first; a
			// grandchild that reparents away from the runner still escapes it, as the decision records.
			await writeFile(join(scratch, "probe", watchdogName), watchdogSource(backstop(limits.timeout)));
			await writeFile(join(scratch, "probe", runnerName), runnerSource());
			for (const file of files) {
				const target = join(scratch, "probe", ...file.path.split("/"));
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, fileBytes(file));
			}
			const opening = sandbox.open();
			await withBound(opening, probeLimits.setup, "the sandbox did not start").catch((error: unknown) => {
				// The bound gave up on an open that may still finish; release its session then, so the shared manager's
				// count returns to zero instead of leaking.
				void opening.then(
					() => sandbox.close(),
					() => undefined,
				);
				throw error;
			});
		} catch (error) {
			await rm(scratch, { recursive: true }).catch(() => undefined);
			if (error instanceof ProbeError && error.code === "invalidProbe") throw error;
			throw new ProbeError("sandboxUnavailable", `the probe could not start: ${String(error)}`, { cause: error });
		}
		return new Probe(scratch, installs, limits, sandbox);
	}

	/** Whether a probe can run on this machine, by running an empty one. */
	static async availability(sandbox: ProbeSandbox = runtime): Promise<ProbeAvailability> {
		try {
			const probe = await Probe.open(
				{ script: "process.exit(0);\n" },
				{ writer: { trusted: true, by: "reviewer" }, trustWriters: true, sandbox },
			);
			let result: ProbeResult;
			let cleanup!: CleanupOutcome;
			try {
				result = await probe.run();
			} finally {
				cleanup = await probe.close();
			}
			if (result.error !== undefined)
				return { available: false, reason: `stopping an empty probe's processes failed: ${result.error}` };
			if (result.exitCode !== 0)
				return {
					available: false,
					reason: `an empty probe exited ${result.exitCode ?? result.signal}${result.output === "" ? "" : `: ${result.output.trim()}`}`,
				};
			if (!cleanup.removed)
				return { available: false, reason: `an empty probe's scratch could not be removed: ${cleanup.reason}` };
			return { available: true };
		} catch (error) {
			return { available: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	/** What the probe may read and write, as the sandbox is given it. */
	get policy(): ProbePolicy {
		const { platform } = this.#sandbox;
		const system = systemReads[platform].filter((path) => existsSync(path));
		const run = join(this.#scratch, "run");
		const tree = join(this.#scratch, "tree");
		return {
			read: [
				tree,
				...this.#installs,
				...nodeReads(process.execPath),
				runtimePackage(),
				join(this.#scratch, "probe"),
				run,
				...system,
			],
			// A granted Node prefix's `etc` holds the global npmrc, and npm's own directory its builtin one; either can carry a
			// registry token.
			deny: [
				"/",
				...nodeReads(process.execPath).map((path) => join(path, "etc")),
				join(dirname(dirname(realpathSync(process.execPath))), "lib", "node_modules", "npm", "npmrc"),
			],
			denyGlobs: [tree, ...this.#installs].flatMap((root) => denyGlobs.map((pattern) => posix.join(root, pattern))),
			write: [run],
			// sandbox-runtime keeps this writable for itself whatever the policy says.
			denyWrite: platform === "darwin" ? ["/tmp/claude", "/private/tmp/claude"] : ["/tmp/claude"],
		};
	}

	/** Runs the probe once, within its time and output limits, and ends every process it started. */
	async run(): Promise<ProbeResult> {
		if (this.#closed) throw new ProbeError("closed", "the probe is closed");
		if (this.#running) throw new ProbeError("invalidProbe", "a probe runs once at a time");
		this.#running = true;
		const home = join(this.#scratch, "run", "home");
		const temporary = join(this.#scratch, "run", "tmp");
		const node = realpathSync(process.execPath);
		const tree = join(this.#scratch, "tree");
		const command = `cd ${quote(tree)} && export HOME=${quote(home)} TMPDIR=${quote(temporary)} && ulimit -t ${Math.ceil(backstop(this.#timeout) / 1000)} && exec ${quote(node)} ${quote(join(this.#scratch, "probe", runnerName))}`;
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let child: ProbeProcess | undefined;
		let argv: readonly string[] | undefined;
		let outcome: ProbeResult | undefined;
		try {
			// Starting the sandbox is bounded apart from the run, so wrapping the command cannot hang unbounded before the
			// probe's own time limit begins.
			const wrapping = this.#sandbox.wrap(command, this.policy);
			const wrapped = wrapping.catch((error: unknown) => {
				throw new ProbeError("sandboxUnavailable", `the sandbox refused the probe: ${String(error)}`, {
					cause: error,
				});
			});
			// sandbox-runtime counts the sandboxes it wrapped and releases one that threw itself, so only a wrap that succeeded
			// is released, a late one once it settles; a second release would take a running sandbox's mount points.
			argv = await withBound(wrapped, probeLimits.setup, "the sandbox did not wrap the probe").catch(
				(error: unknown) => {
					this.#lateWrap = wrapping.then(
						() => this.#sandbox.cleanup(),
						() => {},
					);
					throw error;
				},
			);
			child = ProbeProcess.start(argv, {
				cwd: tree,
				env: {
					PATH: `${dirname(node)}:/usr/bin:/bin`,
					HOME: home,
					TMPDIR: temporary,
					// spawn leaves out a variable whose value is undefined.
					LANG: process.env.LANG,
				},
				timeoutMs: this.#timeout,
				output: (chunk) => {
					if (truncated) return;
					const room = this.#outputLimit - size;
					if (chunk.length > room) {
						chunks.push(chunk.subarray(0, room));
						size = this.#outputLimit;
						truncated = true;
						child!.cut();
						return;
					}
					chunks.push(chunk);
					size += chunk.length;
				},
			});
			const exit = await child.wait();
			const bytes = Buffer.concat(chunks);
			// A cut at the output limit can fall inside a multi-byte character; decode only up to the last whole one.
			const output = new TextDecoder().decode(truncated ? bytes.subarray(0, completeUtf8(bytes)) : bytes);
			const result = { exitCode: exit.code, signal: exit.signal, output, truncated, timedOut: exit.timedOut };
			outcome = exit.error === undefined ? result : { ...result, error: exit.error };
		} finally {
			const stopped = await child?.stop().then(
				() => undefined,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			if (argv !== undefined) this.#sandbox.cleanup();
			this.#running = false;
			// A run that settled keeps its result, with the failed stop as its error unless it already holds one.
			if (outcome !== undefined && stopped !== undefined) outcome = { ...outcome, error: outcome.error ?? stopped };
		}
		return outcome;
	}

	/**
	 * Removes the scratch directory and releases the sandbox. Safe to call twice. A cleanup failure never throws: it
	 * returns `{ removed: false }` with the leftover path, so it cannot replace the probe's result, and the scratch is
	 * left in place rather than risking a host change. The sandbox is released either way.
	 */
	async close(): Promise<CleanupOutcome> {
		if (this.#closed) return { removed: true };
		this.#closed = true;
		try {
			await relaxScratch(this.#scratch);
			await rm(this.#scratch, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
			return { removed: true };
		} catch (error) {
			// rm's force already treats a scratch someone else removed as gone, so any error here is a real leftover.
			return { removed: false, leftover: this.#scratch, reason: (error as Error).message };
		} finally {
			// A wrap that never settles keeps the session: a leaked session is safe, a reset under a live wrap is not.
			const settled =
				this.#lateWrap === undefined ||
				(await withBound(this.#lateWrap, probeLimits.setup, "the sandbox did not wrap the probe").then(
					() => true,
					() => false,
				));
			if (settled) await this.#sandbox.close();
		}
	}
}
