import { spawnSync } from "node:child_process";
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, posix } from "node:path";

/** The sandbox a host offers: seatbelt through `sandbox-exec` on macOS, bubblewrap on Linux. */
export type SandboxBackend = "seatbelt" | "bubblewrap";

/** What a sandboxed command may reach. Every path is absolute and canonical, because seatbelt matches real paths. */
export interface SandboxPaths {
	/** The head's worktree, the command's working directory. */
	readonly worktree: string;
	/** The run's scratch directory, which holds the worktree. The only place the command may write. */
	readonly scratch: string;
	/** The checkout's installed dependencies, read-only: its `node_modules` and each workspace package's. */
	readonly installs: readonly string[];
	/** The Node installation, read-only: the directory above `bin/node`. */
	readonly node: string;
}

// What a Node process needs from macOS to start: the dynamic linker's cache, the system frameworks and libraries, the
// locale and time zone data, and the root directory itself, which dyld lists. Nothing here is the reviewer's own.
const systemReads = [
	"/usr/lib",
	"/usr/bin",
	"/usr/share",
	"/bin",
	"/System",
	"/Library/Preferences",
	"/Library/Apple",
	"/private/etc",
	// /bin/sh reads the link in here that chooses its shell, and complains on stderr when it cannot.
	"/private/var/select",
	"/private/var/db/dyld",
	"/private/var/db/timezone",
	"/dev",
];

// The Linux counterparts, bound read-only when the host has them. Of /etc only what a process needs to resolve localhost, name
// its user, and tell the time is bound, so no credential file in it is visible; the alternatives directory is bound too,
// since a merged-/usr host links /usr/bin entries through it.
const linuxReads = [
	"/usr",
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

// The command-line developer tools, where `git` really lives. `/usr/bin/git` is a shim that asks `xcode-select` and `xcrun`
// for them, which need Mach services the sandbox does not grant; with the real `git` first in PATH, the head's tests can
// make the repositories they need.
function developerDirectory(): string | undefined {
	let directory = "/Library/Developer/CommandLineTools";
	try {
		directory = readlinkSync("/var/select/developer_dir");
	} catch {
		// No link: the default location, if it exists, is where they are.
	}
	return existsSync(posix.join(directory, "usr/bin/git")) ? directory : undefined;
}

// The per-user temporary directory macOS gives every process, where `xcrun` keeps the cache the git shim reads. A test that
// runs `/usr/bin/git` with an environment of its own gets the shim, and the shim writes there.
function xcrunCache(): string | undefined {
	const asked = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" });
	const directory = asked.status === 0 ? asked.stdout.trim() : "";
	if (directory === "") return undefined;
	try {
		return realpathSync(directory);
	} catch {
		return undefined;
	}
}

function regexSource(path: string): string {
	return path.replace(/[\][\\.*^$+?(){}|]/g, "\\$&");
}

/** The Node installation that runs this process: the directory above the real path of its `bin/node`. */
export function nodeInstallation(): string {
	return dirname(dirname(realpathSync(process.execPath)));
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
 * A way to run the head's own code with no route off the machine and nothing readable but the run's files. Problem: the mutation
 * check runs the head's tests, setup files, and Vitest configuration as the reviewer, so a fork's test could read the
 * reviewer's `auth.json` and send it out. Solution: the command runs under a seatbelt profile on macOS or inside a
 * bubblewrap namespace on Linux, and a host with neither runs nothing.
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
			posix.join(nodeInstallation(), "bin"),
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

	/** The seatbelt profile for these paths, which the caller writes to a file; bubblewrap needs none. */
	profile(paths: SandboxPaths): string | undefined {
		if (this.backend !== "seatbelt") return undefined;
		const developer = developerDirectory();
		const cache = xcrunCache();
		const readable = [...systemReads, ...(developer === undefined ? [] : [developer]), paths.node, paths.scratch].map(
			(path) => `(subpath ${profileString(path)})`,
		);
		const installs = paths.installs.map((path) => `(subpath ${profileString(path)})`);
		const parents = [...new Set([paths.node, paths.scratch, ...paths.installs].flatMap(ancestors))]
			.sort()
			.map((path) => `(literal ${profileString(path)})`);
		return [
			"(version 1)",
			"(deny default)",
			"(allow process-exec)",
			"(allow process-fork)",
			"(allow signal (target same-sandbox))",
			"(allow process-info* (target same-sandbox))",
			"(allow sysctl-read)",
			"(allow file-map-executable)",
			"(allow ipc-posix-sem)",
			"(allow ipc-posix-shm*)",
			"(allow system-mac-syscall)",
			`(allow file-read* (literal "/") ${[...readable, ...installs].join(" ")})`,
			// /etc and /var are links into /private. The resolver stats /etc to find /etc/hosts, and the git shim reads the link in /var/select.
			`(allow file-read-metadata (literal "/") (literal "/etc") (literal "/var") ${parents.join(" ")})`,
			`(allow file-write* (subpath ${profileString(paths.scratch)}))`,
			'(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/tty"))',
			'(allow file-ioctl (literal "/dev/dtracehelper"))',
			// `confstr` asks this service for the per-user temporary directory, which the git shim needs before it runs the real git.
			'(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
			...(cache === undefined
				? []
				: [
						`(allow file-read* file-write* (regex #"^(/private)?${regexSource(cache.replace(/^\/private/, ""))}/xcrun_db(-[A-Za-z0-9]+)?$"))`,
					]),
			// Stryker 10 starts a logging server on a port it picks, and its workers connect to it. Loopback is all it gets: no
			// remote address, no unix-domain socket, no Mach service. On macOS loopback is the host's own, so the command can
			// reach what listens there; bubblewrap's private network namespace gives it a loopback of its own.
			'(allow network-inbound (local ip "localhost:*"))',
			'(allow network-outbound (remote ip "localhost:*"))',
			"",
		].join("\n");
	}

	/**
	 * `inner` run under the sandbox, as one shell command. `profileFile` is where the caller wrote {@link profile}. The
	 * command runs in the worktree. Writes reach the scratch directory and nothing else.
	 */
	command(inner: string, paths: SandboxPaths, profileFile: string): string {
		if (this.backend === "seatbelt") {
			return `cd ${quote(paths.worktree)} && /usr/bin/sandbox-exec -f ${quote(profileFile)} /bin/bash -c ${quote(inner)}`;
		}
		const bind = (flag: string, path: string) => `${flag} ${quote(path)} ${quote(path)}`;
		const system = linuxReads.filter((path) => existsSync(path)).map((path) => bind("--ro-bind", path));
		return [
			"bwrap --unshare-all --die-with-parent --new-session",
			...system,
			"--proc /proc --dev /dev --tmpfs /tmp",
			bind("--ro-bind", paths.node),
			...paths.installs.map((path) => bind("--ro-bind", path)),
			bind("--bind", paths.scratch),
			`--chdir ${quote(paths.worktree)}`,
			`-- /bin/bash -c ${quote(inner)}`,
		].join(" ");
	}
}
