import { spawnSync } from "node:child_process";
import { existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix } from "node:path";

/** The sandbox a host offers: seatbelt through `sandbox-exec` on macOS, bubblewrap on Linux. */
export type SandboxBackend = "seatbelt" | "bubblewrap";

/** What a sandboxed command may reach. Every path is absolute and canonical, because seatbelt matches real paths. */
export interface SandboxPaths {
	/** The head's worktree, the command's working directory. */
	readonly worktree: string;
	/** The run's writable scratch directory, which holds the worktree. */
	readonly scratch: string;
	/** The checkout's installed dependencies, read-only: its `node_modules` and each workspace package's. */
	readonly installs: readonly string[];
	/** The canonical Node executable, readable as a literal path. */
	readonly node: string;
	/**
	 * Whether the command may listen on and connect to loopback addresses; absent means no network at all. On macOS
	 * loopback is the host's own, so a command given it can reach every service that listens there. bubblewrap's private
	 * network namespace has a loopback of its own with nothing on it, whatever this says.
	 */
	readonly loopback?: boolean;
}

// Directories of the sealed system volume, the same on every Mac of one release, so nothing in them is the reviewer's own.
// `/usr/lib` and `/System` hold dyld and the libraries and frameworks every program links; `/usr/bin` and `/bin` hold the
// shell and the tools a command line names, such as `env`, `sh`, and `date`; `/usr/share` holds the locale and ICU data
// those libraries load. The last is the time zone database `/etc/localtime` points into, which `date` and Node read.
const systemReads = ["/usr/lib", "/usr/bin", "/usr/share", "/bin", "/System", "/private/var/db/timezone"];

// Single files outside the sealed volume. `/etc/localtime` names the host's time zone, so a log's times match the
// reviewer's. `/bin/sh` reads the `sh` link to choose its shell, and `xcrun`, behind the git shim, reads `developer_dir`.
const systemFiles = ["/private/etc/localtime", "/private/var/select/sh", "/private/var/select/developer_dir"];

// The Linux counterparts, bound read-only when the host has them. Of /etc only what a process needs to resolve localhost, name
// its user, and tell the time is bound, so no credential file in it is visible; the alternatives directory is bound too,
// since a merged-/usr host links /usr/bin entries through it.
const linuxReads = [
	"/usr/bin",
	"/usr/sbin",
	"/usr/lib",
	"/usr/lib64",
	"/usr/share",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/etc/alternatives",
	"/etc/ld.so.cache",
	"/etc/hosts",
	"/etc/nsswitch.conf",
	"/etc/passwd",
	"/etc/group",
	"/etc/localtime",
];

function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

function profileString(path: string): string {
	if (/["\\\n]/.test(path)) throw new Error(`a sandbox path holds a quote, backslash, or newline: ${path}`);
	return `"${path}"`;
}

// Every directory above `path`, which a process stats on its way to the path and which would otherwise be unreadable.
function ancestors(path: string): string[] {
	const found: string[] = [];
	for (let at = posix.dirname(path); at !== "/" && at !== "."; at = posix.dirname(at)) found.push(at);
	return found;
}

// The command-line developer tools, where `git` really lives. `/usr/bin/git` is a shim that asks `xcrun` for them; with the
// real `git` first in PATH, a command that calls `git` never meets the shim.
function developerDirectory(): string | undefined {
	let directory = "/Library/Developer/CommandLineTools";
	try {
		directory = readlinkSync("/var/select/developer_dir");
	} catch {
		// No link: the default location, if it exists, is where they are.
	}
	return existsSync(posix.join(directory, "usr/bin/git")) ? directory : undefined;
}

export function nodeExecutable(): string {
	return realpathSync(process.execPath);
}

function nodeDirectories(executable: string): string[] {
	const prefix = dirname(dirname(executable));
	const home = homedir();
	if (
		executable !== posix.join(prefix, "bin/node") ||
		["/", "/usr", "/usr/local", home, posix.join(home, ".local")].includes(prefix) ||
		home.startsWith(`${prefix}/`) ||
		!statSync(prefix, { throwIfNoEntry: false })?.isDirectory()
	)
		return [];
	return [posix.join(prefix, "lib/node_modules"), posix.join(prefix, "include/node")].filter(
		(path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() && realpathSync(path) === path,
	);
}

function available(backend: SandboxBackend): boolean {
	const trial =
		backend === "seatbelt"
			? spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
					stdio: "ignore",
				})
			: spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"], { stdio: "ignore" });
	return trial.status === 0;
}

/**
 * A way to run a command with no route off the machine and nothing readable but the run's files. Problem: a command
 * that reads what a pull request wrote, or runs it, does so as the reviewer, and could read the reviewer's `auth.json`
 * and send it out. Solution: the command runs under a seatbelt profile on macOS or inside a bubblewrap namespace on
 * Linux. What a caller does on a host with neither is the caller's rule.
 */
export class Sandbox {
	readonly backend: SandboxBackend;

	private constructor(backend: SandboxBackend) {
		this.backend = backend;
	}

	/**
	 * The sandbox this host offers, or undefined. It tries the backend, not only the program's presence: a host that
	 * forbids nested sandboxes, or unprivileged user namespaces, has none.
	 */
	static detect(platform: NodeJS.Platform = process.platform): Sandbox | undefined {
		const backend = platform === "darwin" ? "seatbelt" : platform === "linux" ? "bubblewrap" : undefined;
		if (backend === undefined || !available(backend)) return undefined;
		return new Sandbox(backend);
	}

	/**
	 * Variables the command needs beyond the scratch `HOME` and `TMPDIR`: a `PATH` of only the directories the sandbox lets
	 * it read. A program found elsewhere, such as `gh` under Homebrew, would fail to start with `EPERM` where it should be
	 * missing. On macOS the real `git` comes ahead of the shim, and the shim is told where the tools are.
	 */
	environment(): Record<string, string> {
		const developer = this.backend === "seatbelt" ? developerDirectory() : undefined;
		const directories = [
			...(developer === undefined ? [] : [posix.join(developer, "usr/bin")]),
			dirname(nodeExecutable()),
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		];
		// With DEVELOPER_DIR set, `/usr/bin/git` runs the real one without asking `xcode-select`, which the sandbox cannot answer.
		return {
			PATH: directories.join(":"),
			// Tells the head's tests they run sandboxed, where a test of a sandbox cannot start another.
			MELIAN_SANDBOX: this.backend,
			...(developer === undefined ? {} : { DEVELOPER_DIR: developer }),
		};
	}

	runtimeFailure(paths: SandboxPaths): string | undefined {
		const result = spawnSync(
			"/bin/bash",
			["-c", this.command(`${quote(paths.node)} --version`, paths, "", this.profile(paths))],
			{
				encoding: "utf8",
				env: { ...this.environment(), HOME: paths.scratch, TMPDIR: paths.scratch },
			},
		);
		if (result.status === 0) return undefined;
		return `Node runtime ${paths.node} could not start within ${this.backend}; the runtime grant was not widened`;
	}

	/** The seatbelt profile for these paths, which the caller writes to a file; bubblewrap needs none. */
	profile(paths: SandboxPaths): string | undefined {
		if (this.backend !== "seatbelt") return undefined;
		const developer = developerDirectory();
		const writable = [paths.scratch];
		const runtime = nodeDirectories(paths.node);
		const readable = [
			'(literal "/")',
			...[...systemFiles, paths.node].map((path) => `(literal ${profileString(path)})`),
			...[
				...systemReads,
				...(developer === undefined ? [] : [developer]),
				...runtime,
				...writable,
				...paths.installs,
			].map((path) => `(subpath ${profileString(path)})`),
		].join(" ");
		const parents = [...new Set([paths.node, ...runtime, ...writable, ...paths.installs].flatMap(ancestors))].map(
			(path) => `(literal ${profileString(path)})`,
		);
		return [
			"(version 1)",
			"(deny default)",
			// Bash forks for every command, and Node for every child.
			"(allow process-fork)",
			// A program runs only from where it can be read, so nothing elsewhere on the disk starts, readable or not.
			`(allow process-exec ${readable})`,
			// dyld maps each library a program links, from the same places.
			`(allow file-map-executable ${readable})`,
			// A parent stops the children it started, as Node does at a timeout. No process outside this sandbox is a target.
			"(allow signal (target same-sandbox))",
			// Node aborts at start without the CPU count and page size, and libuv reads more by number, which a profile cannot
			// list by name. A sysctl is read-only host description: hardware, kernel version, host name.
			"(allow sysctl-read)",
			// dyld lists the root directory before anything runs; without it the process aborts with no message.
			`(allow file-read* ${readable})`,
			// /etc and /var are links into /private, which a path through them stats. Each directory above a granted path is
			// stat-ed on the way to it; metadata shows that a directory exists, never what it holds.
			`(allow file-read-metadata (literal "/") (literal "/etc") (literal "/var") ${parents.join(" ")})`,
			`(allow file-write* ${writable.map((path) => `(subpath ${profileString(path)})`).join(" ")})`,
			// Every shell redirect to discard output opens /dev/null, Melian's own commands included. Programs that seed from a
			// device and not a system call, such as Python, open /dev/urandom. No other device, so no terminal.
			'(allow file-read* (literal "/dev/null") (literal "/dev/urandom"))',
			'(allow file-write-data (literal "/dev/null"))',
			'(deny file-read* file-write* (literal "/dev/tty"))',
			// No Mach service and nothing in the host's per-user temporary directory. `xcrun`, which the git shim runs, keeps a
			// cache there that host git reads later, so a write would let a command choose the program host git runs. Denied
			// the directory's name, `xcrun` keeps its cache in `TMPDIR`, which every caller points into scratch.
			// Loopback is the most a caller can ask for: never a remote address or a unix-domain socket. Seatbelt cannot name a
			// port the command picks for itself, so the allowance is every loopback port or none.
			// With it comes /etc/hosts, where the resolver finds `localhost` once the lookup service is out of reach.
			...(paths.loopback === true
				? [
						'(allow network-inbound (local ip "localhost:*"))',
						'(allow network-outbound (remote ip "localhost:*"))',
						'(allow file-read* (literal "/private/etc/hosts"))',
					]
				: []),
			"",
		].join("\n");
	}

	/**
	 * `inner` run under the sandbox, as one shell command. `profileFile` is where the caller wrote {@link profile}. The
	 * command runs in the worktree. Writes reach scratch only.
	 */
	command(inner: string, paths: SandboxPaths, profileFile: string, profile?: string): string {
		if (this.backend === "seatbelt") {
			const policy = profile === undefined ? `-f ${quote(profileFile)}` : `-p ${quote(profile)}`;
			return `cd ${quote(paths.worktree)} && /usr/bin/sandbox-exec ${policy} /bin/bash -c ${quote(inner)}`;
		}
		const bind = (flag: string, path: string) => `${flag} ${quote(path)} ${quote(path)}`;
		const system = linuxReads.filter((path) => existsSync(path)).map((path) => bind("--ro-bind", path));
		return [
			"bwrap --unshare-all --die-with-parent --new-session",
			...system,
			"--proc /proc --dev /dev --tmpfs /tmp",
			bind("--ro-bind", paths.node),
			...nodeDirectories(paths.node).map((path) => bind("--ro-bind", path)),
			...paths.installs.map((path) => bind("--ro-bind", path)),
			bind("--bind", paths.scratch),
			`--chdir ${quote(paths.worktree)}`,
			`-- /bin/bash -c ${quote(inner)}`,
		].join(" ");
	}
}
