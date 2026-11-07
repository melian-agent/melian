import { constants, existsSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open as openFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { WriterTrust } from "./checks.ts";
import { ProbeProcess } from "./probe-process.ts";

/** The bounds a probe runs within. A time or output limit past its `max` is refused. */
export const probeLimits = {
	timeout: { default: 30_000, max: 600_000 },
	output: { default: 65_536, max: 1_048_576 },
	script: 262_144,
	files: 64,
	fileBytes: 1_048_576,
	path: 200,
} as const;

/** A fixture file a probe's script reads, at a relative path beside the script. */
export interface ProbeFile {
	readonly path: string;
	readonly text: string;
}

/** A probe: a Node ES module, run as `probe.mjs` with its files beside it and the head's worktree as its directory. */
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

export interface ProbeOptions {
	/** The head's checkout. The probe runs there and may read it, never write it. */
	readonly worktree: string;
	/** A dependency install the worktree's links lead into, readable by the probe. */
	readonly install?: string;
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

const segment = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const scriptName = "probe.mjs";

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

// What the worktree holds that is no probe's business, as the standards loader never reads it. `.git` is a literal path;
// the rest are patterns that match a file of that name at any depth.
const worktreeDenyPaths = [".git"];
const worktreeDenyGlobs = ["**/.env*", "**/melian.secrets.yaml", "**/melian.local.yaml"];

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
	const seen = new Set<string>([scriptName]);
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
		bytes += Buffer.byteLength(file.text);
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

/** sandbox-runtime as a {@link ProbeSandbox}. Its manager is one per process, so one session serves every open probe. */
export class RuntimeSandbox implements ProbeSandbox {
	readonly platform: "darwin" | "linux";
	readonly #name: string;
	readonly #runtime: SandboxRuntime;
	#sessions = 0;
	// open and close run one at a time on the shared manager, so a reset can never complete after a newer open tears its
	// session down. Each call waits for the ones before it, and a thrown step does not poison the chain.
	#queue: Promise<void> = Promise.resolve();

	constructor(runtime: SandboxRuntime = SandboxManager, name: string = platform()) {
		this.#runtime = runtime;
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
		const run = this.#queue.then(step);
		this.#queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	open(): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#sessions === 0)
				await this.#runtime.initialize({
					network: { allowedDomains: [], deniedDomains: [] },
					filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
				});
			this.#sessions++;
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
			if (this.#sessions === 0) return;
			this.#sessions--;
			if (this.#sessions === 0) await this.#runtime.reset();
		});
	}
}

// One per process, since sandbox-runtime's manager is.
const runtime = new RuntimeSandbox();

// Lets close() remove a directory the probe made unreadable to its owner, without following a symlink in its place. It
// opens each directory with O_NOFOLLOW and changes the mode through that descriptor, so a symlink fails the open (ELOOP)
// and is left for rm to remove by name. A mode-0 directory cannot be opened and fails with EACCES instead, which proves
// it is a real directory, so it is chmod'd by path. run() stops every process the probe started before close() runs,
// so nothing swaps an entry during the descent; a child that detached on macOS is the decision's documented residual.
export async function makeWritable(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		handle = await openFile(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EACCES") return;
		await chmod(path, 0o700);
	}
	try {
		await handle?.chmod(0o700);
		for (const child of await readdir(path, { withFileTypes: true }))
			if (child.isDirectory()) await makeWritable(join(path, child.name));
	} finally {
		await handle?.close();
	}
}

/**
 * One probe: a script and its files, run under sandbox-runtime with no network, a scratch home, writes to its scratch
 * directory alone and reads of the head's worktree, Node and the system's libraries alone. Open it with
 * {@link Probe.open}, run it with {@link Probe.run} as often as needed, and {@link Probe.close} it to remove its scratch.
 */
export class Probe {
	readonly #scratch: string;
	readonly #worktree: string;
	readonly #install: string | undefined;
	readonly #timeout: number;
	readonly #outputLimit: number;
	readonly #sandbox: ProbeSandbox;
	#closed = false;
	#running = false;

	private constructor(
		scratch: string,
		worktree: string,
		install: string | undefined,
		limits: { timeout: number; output: number },
		sandbox: ProbeSandbox,
	) {
		this.#scratch = scratch;
		this.#worktree = worktree;
		this.#install = install;
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
		const worktree = directory(options.worktree, "the worktree");
		const install = options.install === undefined ? undefined : directory(options.install, "the install");
		const scratch = realpathSync(await mkdtemp(join(tmpdir(), "melian-probe-")));
		try {
			for (const path of ["probe", "run/home", "run/tmp"]) await mkdir(join(scratch, path), { recursive: true });
			await writeFile(join(scratch, "probe", scriptName), input.script);
			for (const file of files) {
				const target = join(scratch, "probe", ...file.path.split("/"));
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, file.text);
			}
			await sandbox.open();
		} catch (error) {
			await rm(scratch, { recursive: true });
			throw new ProbeError("sandboxUnavailable", `the probe could not start: ${String(error)}`, { cause: error });
		}
		return new Probe(scratch, worktree, install, limits, sandbox);
	}

	/** Whether a probe can run on this machine, by running an empty one. */
	static async availability(sandbox: ProbeSandbox = runtime): Promise<ProbeAvailability> {
		const worktree = await mkdtemp(join(tmpdir(), "melian-probe-check-"));
		try {
			const probe = await Probe.open(
				{ script: "process.exit(0);\n" },
				{ worktree, writer: { trusted: true, by: "reviewer" }, trustWriters: true, sandbox },
			);
			try {
				const result = await probe.run();
				if (result.exitCode === 0) return { available: true };
				return {
					available: false,
					reason: `an empty probe exited ${result.exitCode ?? result.signal}${result.output === "" ? "" : `: ${result.output.trim()}`}`,
				};
			} finally {
				await probe.close();
			}
		} catch (error) {
			return { available: false, reason: error instanceof Error ? error.message : String(error) };
		} finally {
			await rm(worktree, { recursive: true });
		}
	}

	/** What the probe may read and write, as the sandbox is given it. */
	get policy(): ProbePolicy {
		const { platform } = this.#sandbox;
		const system = systemReads[platform].filter((path) => existsSync(path));
		const run = join(this.#scratch, "run");
		return {
			read: [
				this.#worktree,
				...(this.#install === undefined ? [] : [this.#install]),
				...nodeReads(process.execPath),
				runtimePackage(),
				join(this.#scratch, "probe"),
				run,
				...system,
			],
			// A granted Node prefix's `etc` holds the global npmrc, which can carry a registry token.
			deny: [
				"/",
				posix.join(this.#worktree, ...worktreeDenyPaths),
				...nodeReads(process.execPath).map((path) => join(path, "etc")),
			],
			denyGlobs: worktreeDenyGlobs.map((pattern) => posix.join(this.#worktree, pattern)),
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
		const command = `cd ${quote(this.#worktree)} && export HOME=${quote(home)} TMPDIR=${quote(temporary)} && exec ${quote(node)} ${quote(join(this.#scratch, "probe", scriptName))}`;
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let timedOut = false;
		try {
			const argv = await this.#sandbox.wrap(command, this.policy).catch((error: unknown) => {
				throw new ProbeError("sandboxUnavailable", `the sandbox refused the probe: ${String(error)}`, {
					cause: error,
				});
			});
			const child = ProbeProcess.start(argv, {
				cwd: this.#worktree,
				env: {
					PATH: `${dirname(node)}:/usr/bin:/bin`,
					HOME: home,
					TMPDIR: temporary,
					// spawn leaves out a variable whose value is undefined.
					LANG: process.env.LANG,
				},
				output: (chunk) => {
					if (truncated) return;
					const room = this.#outputLimit - size;
					if (chunk.length > room) {
						chunks.push(chunk.subarray(0, room));
						size = this.#outputLimit;
						truncated = true;
						void child.stop().catch(() => undefined);
						return;
					}
					chunks.push(chunk);
					size += chunk.length;
				},
			});
			const timer = setTimeout(() => {
				timedOut = true;
				void child.stop().catch(() => undefined);
			}, this.#timeout);
			const exit = await child.wait();
			clearTimeout(timer);
			await child.stop();
			const bytes = Buffer.concat(chunks);
			// A cut at the output limit can fall inside a multi-byte character; decode only up to the last whole one.
			const output = new TextDecoder().decode(truncated ? bytes.subarray(0, completeUtf8(bytes)) : bytes);
			return { exitCode: exit.code, signal: exit.signal, output, truncated, timedOut };
		} finally {
			this.#sandbox.cleanup();
			this.#running = false;
		}
	}

	/** Removes the scratch directory and releases the sandbox. Safe to call twice. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await makeWritable(this.#scratch);
			await rm(this.#scratch, { recursive: true });
		} finally {
			await this.#sandbox.close();
		}
	}
}
