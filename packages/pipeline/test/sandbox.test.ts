import type * as childProcess from "node:child_process";
import { execFile, spawnSync } from "node:child_process";
import type * as filesystem from "node:fs";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeInstallation, Sandbox, type SandboxPaths } from "../src/sandbox.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof childProcess>();
	return { ...original, spawnSync: vi.fn(original.spawnSync) };
});

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof filesystem>();
	return {
		...original,
		existsSync: vi.fn(original.existsSync),
		readlinkSync: vi.fn(original.readlinkSync),
		realpathSync: vi.fn(original.realpathSync),
	};
});

const run = promisify(execFile);

// What a hostile test would try: read a credential, call a remote host, write beside the run, and write inside it. The
// remote host is in TEST-NET-1, which no network routes: a sandbox answers a connect at once with a refusal, and an open
// network lets it hang until the probe gives up.
const probe = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const net = require("node:net");
const [home, scratch, outside] = process.argv.slice(2);
const result = {};
const attempt = (name, body) => { try { body(); result[name] = "ok"; } catch (error) { result[name] = "denied"; } };
attempt("readHome", () => fs.readFileSync(home + "/auth.json"));
// A shell script, which must run without a word on stderr.
attempt("sh", () => {
  const shell = require("node:child_process").spawnSync("/bin/sh", ["-c", "true"], { encoding: "utf8" });
  if (shell.status !== 0 || shell.stderr !== "") throw new Error(shell.stderr);
});
// A test that names the shim by its path, as many do, with an environment of its own and no PATH or DEVELOPER_DIR.
attempt("shim", () => {
  const shim = require("node:child_process").spawnSync("/usr/bin/git", ["init", "--quiet"], { env: { HOME: scratch + "/home" }, cwd: scratch + "/shim", encoding: "utf8" });
  if (shim.status !== 0 || shim.stderr !== "") throw new Error(shim.stderr);
});
// The head's own tests make repositories to test against.
attempt("git", () => {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: scratch + "/repository", stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "--allow-empty", "--quiet", "-m", "x"], { cwd: scratch + "/repository", stdio: "pipe" });
});
attempt("writeScratch", () => fs.writeFileSync(scratch + "/written", "1"));
attempt("writeOutside", () => fs.writeFileSync(outside + "/written", "1"));
// Stryker's logging server listens on every interface and its workers connect to it over loopback.
const server = net.createServer((client) => client.end()).listen(0, "0.0.0.0", () => {
  const local = net.connect(server.address().port, "localhost");
  local.on("connect", () => { result.loopback = "ok"; local.destroy(); server.close(); });
  local.on("error", () => { result.loopback = "denied"; server.close(); });
});
server.on("error", () => { result.loopback = "denied"; });
const socket = net.connect(9, "192.0.2.1");
socket.setTimeout(3000);
const finish = () => setTimeout(() => console.log(JSON.stringify(result)), 500);
socket.on("connect", () => { result.connect = "reached"; socket.destroy(); finish(); });
socket.on("timeout", () => { result.connect = "reached"; socket.destroy(); finish(); });
socket.on("error", (error) => { result.connect = ["EPERM", "EACCES", "ENETUNREACH", "EHOSTUNREACH"].includes(error.code) ? "denied" : "reached"; finish(); });
`;

let base: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "melian-sandbox-")));
	for (const directory of [
		"home",
		"outside",
		"scratch/tree",
		"scratch/repository",
		"scratch/shim",
		"scratch/home",
		"installs",
	])
		mkdirSync(join(base, directory), { recursive: true });
	writeFileSync(join(base, "home/auth.json"), "{}");
	writeFileSync(join(base, "scratch/tree/probe.js"), probe);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const mock of [existsSync, readlinkSync, realpathSync, spawnSync]) vi.mocked(mock).mockReset();
	vi.unstubAllEnvs();
	rmSync(base, { recursive: true, force: true });
});

function paths(): SandboxPaths {
	return {
		worktree: join(base, "scratch/tree"),
		scratch: join(base, "scratch"),
		installs: [join(base, "installs")],
		node: nodeInstallation(),
	};
}

async function probed(sandbox: Sandbox): Promise<Record<string, string>> {
	const where = paths();
	const file = join(where.scratch, "sandbox.sb");
	const profile = sandbox.profile(where);
	if (profile !== undefined) writeFileSync(file, profile);
	const inner = `${JSON.stringify(process.execPath)} probe.js ${base}/home ${where.scratch} ${base}/outside`;
	const { stdout } = await run("/bin/bash", ["-c", sandbox.command(inner, where, file)], {
		timeout: 30_000,
		env: { ...process.env, ...sandbox.environment(), HOME: join(where.scratch, "home") },
	});
	return JSON.parse(stdout) as Record<string, string>;
}

const sandboxName = (platform: "darwin" | "linux") => Sandbox.detect(platform)?.environment().MELIAN_SANDBOX;

describe("Sandbox.environment", () => {
	for (const platform of ["darwin", "linux"] as const) {
		it.skipIf(Sandbox.detect(platform) === undefined)(
			`gives a PATH of Node's bin and the system's, whatever the host's is (${platform})`,
			() => {
				vi.stubEnv("PATH", "/opt/homebrew/bin:/Users/someone/bin");
				const directories = (Sandbox.detect(platform) as Sandbox).environment().PATH!.split(":");
				expect(directories).toContain(join(nodeInstallation(), "bin"));
				expect(directories.slice(-4)).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
				expect(directories).not.toContain("/opt/homebrew/bin");
				expect(directories).not.toContain("/Users/someone/bin");
				expect(sandboxName(platform)).toBe(platform === "darwin" ? "seatbelt" : "bubblewrap");
			},
		);
	}
});

describe("the bubblewrap command", () => {
	// Built without running it, so it is checked on every host; the probe below runs it where bwrap exists.
	const bubblewrap = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "bubblewrap" as const });
	const where = { worktree: "/work/tree", scratch: "/work", installs: ["/checkout/node_modules"], node: "/opt/node" };
	const command = bubblewrap.command("echo 'hi'", where, "/unused");

	it("unshares every namespace, dies with its parent, and runs the command in the worktree", () => {
		expect(command.startsWith("bwrap --unshare-all --die-with-parent --new-session ")).toBe(true);
		expect(command).toContain("--chdir '/work/tree'");
		expect(command.endsWith("-- /bin/bash -c 'echo '\\''hi'\\'''")).toBe(true);
	});

	it("binds the node installation and the installs read-only, scratch read-write, and nothing of the home", () => {
		expect(command).toContain("--ro-bind '/opt/node' '/opt/node'");
		expect(command).toContain("--ro-bind '/checkout/node_modules' '/checkout/node_modules'");
		expect(command).toContain("--bind '/work' '/work'");
		expect(command).not.toContain("--bind '/work/tree'");
		expect(command).not.toMatch(/ --(ro-)?bind '\/(home|root|Users)/);
	});

	it("binds the system directories the host has, read-only, and a private /proc, /dev, and /tmp before scratch", () => {
		for (const directory of ["/usr", "/bin", "/sbin"])
			if (existsSync(directory)) expect(command).toContain(`--ro-bind '${directory}' '${directory}'`);
		expect(command).not.toContain("--ro-bind '/etc' ");
		expect(command).toContain("--proc /proc --dev /dev --tmpfs /tmp");
		expect(command.indexOf("--tmpfs /tmp")).toBeLessThan(command.indexOf("--bind '/work' '/work'"));
	});
});

describe("Sandbox.detect", () => {
	it("finds no sandbox on a platform that has neither backend", () => {
		expect(Sandbox.detect("freebsd")).toBeUndefined();
		expect(Sandbox.detect("win32")).toBeUndefined();
	});

	for (const [platform, backend, executable, args] of [
		["darwin", "seatbelt", "/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]],
		["linux", "bubblewrap", "bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"]],
	] as const) {
		it(`requires a successful probe before returning ${backend}`, () => {
			const reply = { status: 0 } as ReturnType<typeof spawnSync>;
			vi.mocked(spawnSync).mockReturnValueOnce(reply);
			expect(Sandbox.detect(platform)?.backend).toBe(backend);
			expect(spawnSync).toHaveBeenLastCalledWith(executable, args, { stdio: "ignore" });
			vi.mocked(spawnSync).mockReturnValueOnce({ ...reply, status: 1 });
			expect(Sandbox.detect(platform)).toBeUndefined();
		});
	}

	it.skipIf(process.platform === "darwin")("finds no seatbelt where sandbox-exec is absent", () => {
		expect(Sandbox.detect("darwin")).toBeUndefined();
	});
});

describe.skipIf(Sandbox.detect("darwin") === undefined)("seatbelt", { timeout: 60_000 }, () => {
	it("denies the reviewer's home and the network, and allows writes under scratch only", async () => {
		const sandbox = Sandbox.detect("darwin") as Sandbox;
		expect(await probed(sandbox)).toEqual({
			readHome: "denied",
			sh: "ok",
			shim: "ok",
			git: "ok",
			writeScratch: "ok",
			writeOutside: "denied",
			loopback: "ok",
			connect: "denied",
		});
		expect(readFileSync(join(base, "scratch/written"), "utf8")).toBe("1");
	});
});

describe.skipIf(Sandbox.detect("linux") === undefined)("bubblewrap", { timeout: 60_000 }, () => {
	it("denies the reviewer's home and the network, and allows writes under scratch only", async () => {
		const sandbox = Sandbox.detect("linux") as Sandbox;
		expect(await probed(sandbox)).toEqual({
			readHome: "denied",
			sh: "ok",
			shim: "ok",
			git: "ok",
			writeScratch: "ok",
			writeOutside: "denied",
			loopback: "ok",
			connect: "denied",
		});
		expect(readFileSync(join(base, "scratch/written"), "utf8")).toBe("1");
	});
});

for (const backend of ["seatbelt", "bubblewrap"] as const) {
	it(`writes only to scratch, never to a cache partition (${backend})`, () => {
		const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend });
		const where = paths();
		const output = backend === "seatbelt" ? sandbox.profile(where)! : sandbox.command("true", where, "/profile");
		if (backend === "seatbelt") {
			expect(output).toContain(`(allow file-write* (subpath "${where.scratch}"))`);
		} else {
			expect(output.match(/--bind /g)).toHaveLength(1);
			expect(output).toContain(`--bind '${where.scratch}' '${where.scratch}'`);
		}
	});
}

it("grants the seatbelt profile loopback and no other network rule", () => {
	const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "seatbelt" });
	const rules = sandbox
		.profile(paths())!
		.split("\n")
		.filter((line) => /network/.test(line.replace(/^\s*;.*/, "")));
	expect(rules).toEqual([
		'(allow network-inbound (local ip "localhost:*"))',
		'(allow network-outbound (remote ip "localhost:*"))',
	]);
});

describe("sandbox policy on a host that cannot start nested sandboxes", () => {
	const seatbelt = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "seatbelt" as const });
	const bubblewrap = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "bubblewrap" as const });
	const where = { worktree: "/work/tree", scratch: "/work", installs: ["/checkout/node_modules"], node: "/opt/node" };

	function host(developer: string | undefined, cache: string | undefined) {
		vi.mocked(readlinkSync).mockImplementation((path) => {
			expect(path).toBe("/var/select/developer_dir");
			if (developer === undefined) throw new Error("no developer link");
			return developer;
		});
		vi.mocked(existsSync).mockImplementation((path) => path === `${developer}/usr/bin/git`);
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			expect(command).toBe("/usr/bin/getconf");
			expect(args).toEqual(["DARWIN_USER_TEMP_DIR"]);
			return { status: cache === undefined ? 1 : 0, stdout: cache === undefined ? "" : ` ${cache}\n` } as ReturnType<
				typeof spawnSync
			>;
		});
		const real = vi.mocked(realpathSync).getMockImplementation()!;
		vi.mocked(realpathSync).mockImplementation((path) => (path === cache ? cache : real(path)));
	}

	it("renders just the allowed reads and parent metadata when developer tools and xcrun cache are absent", () => {
		host(undefined, undefined);
		const profile = seatbelt.profile(where)!;
		expect(profile).toContain('(allow file-read* (literal "/") (subpath "/usr/lib")');
		expect(profile).toContain('(subpath "/opt/node") (subpath "/work") (subpath "/checkout/node_modules"))');
		expect(profile).toContain(
			'(allow file-read-metadata (literal "/") (literal "/etc") (literal "/var") (literal "/opt") (literal "/checkout"))',
		);
		expect(profile).toContain('(allow file-write* (subpath "/work"))');
		expect(profile).toContain('(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))');
		expect(profile).not.toContain("xcrun_db");
		expect(profile).not.toContain("Stryker was here");
		expect(bubblewrap.profile(where)).toBeUndefined();
	});

	it("uses named developer tools and grants only their xcrun cache marker", () => {
		host("/dev-tools/Xcode", "/private/cache/a+b");
		const environment = seatbelt.environment();
		expect(environment.DEVELOPER_DIR).toBe("/dev-tools/Xcode");
		expect(environment.PATH!.split(":")[0]).toBe("/dev-tools/Xcode/usr/bin");
		expect(environment.MELIAN_SANDBOX).toBe("seatbelt");
		const profile = seatbelt.profile(where)!;
		expect(profile).toContain('(subpath "/dev-tools/Xcode")');
		expect(profile).toContain(String.raw`(regex #"^(/private)?/cache/a\+b/xcrun_db(-[A-Za-z0-9]+)?$")`);
		expect(profile).not.toContain('(subpath "/private/cache/a+b")');
		expect(profile).not.toContain("Stryker was here");
	});

	it("keeps an interior private component in the cache marker path", () => {
		host(undefined, "/cache/private/dir");
		expect(seatbelt.profile(where)).toContain("^(/private)?/cache/private/dir/xcrun_db");
	});

	it("uses the default developer tools when no selector link exists", () => {
		host(undefined, undefined);
		vi.mocked(existsSync).mockImplementation((path) => path === "/Library/Developer/CommandLineTools/usr/bin/git");
		expect(seatbelt.environment().DEVELOPER_DIR).toBe("/Library/Developer/CommandLineTools");
		expect(seatbelt.profile(where)).toContain('(subpath "/Library/Developer/CommandLineTools")');
	});

	it("omits unavailable tools and unreadable or empty cache paths", () => {
		host("/missing/developer", undefined);
		vi.mocked(existsSync).mockReturnValue(false);
		expect(seatbelt.environment()).toStrictEqual({
			PATH: `${join(nodeInstallation(), "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
			MELIAN_SANDBOX: "seatbelt",
		});
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "   " } as ReturnType<typeof spawnSync>);
		expect(seatbelt.profile(where)).not.toContain("xcrun_db");
		host(undefined, "/missing/cache");
		vi.mocked(realpathSync).mockImplementation(() => {
			throw new Error("cache unavailable");
		});
		expect(seatbelt.profile(where)).not.toContain("xcrun_db");
	});

	it("ignores output from a failed getconf and does not canonicalise an empty cache path", () => {
		host(undefined, undefined);
		vi.mocked(realpathSync).mockClear();
		vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "/private/cache/misleading" } as ReturnType<
			typeof spawnSync
		>);
		expect(seatbelt.profile(where)).not.toContain("xcrun_db");
		expect(realpathSync).not.toHaveBeenCalled();
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "  " } as ReturnType<typeof spawnSync>);
		expect(seatbelt.profile(where)).not.toContain("xcrun_db");
		expect(realpathSync).not.toHaveBeenCalled();
	});

	it("escapes every regex metacharacter in the cache marker path", () => {
		host(undefined, String.raw`/private/cache/a][\.*^$+?(){}|/dir`);
		expect(seatbelt.profile(where)).toContain(
			String.raw`(regex #"^(/private)?/cache/a\]\[\\\.\*\^\$\+\?\(\)\{\}\|/dir/xcrun_db(-[A-Za-z0-9]+)?$")`,
		);
	});

	it("binds only Linux system paths the host has", () => {
		vi.mocked(existsSync).mockImplementation((path) => ["/usr", "/etc/hosts"].includes(String(path)));
		const command = bubblewrap.command("true", where, "/unused");
		expect(command).toContain("--ro-bind '/usr' '/usr'");
		expect(command).toContain("--ro-bind '/etc/hosts' '/etc/hosts'");
		expect(command).not.toContain("--ro-bind '/bin'");
		expect(command).not.toContain("--ro-bind '/etc/passwd'");
	});

	it.each(['"', "\\", "\n"])("rejects a seatbelt path with %j", (character) => {
		host(undefined, undefined);
		expect(() => seatbelt.profile({ ...where, scratch: `/work/${character}/tree` })).toThrow(
			"quote, backslash, or newline",
		);
	});

	it("quotes apostrophes in every sandbox command argument", () => {
		const quoted = { ...where, worktree: "/work/it's tree", scratch: "/work/it's tree" };
		expect(seatbelt.command("echo 'hi'", quoted, "/work/it's profile")).toContain(
			String.raw`cd '/work/it'\''s tree' && /usr/bin/sandbox-exec -f '/work/it'\''s profile' /bin/bash -c 'echo '\''hi'\'''`,
		);
		expect(bubblewrap.command("echo 'hi'", quoted, "/unused")).toContain(
			String.raw`--bind '/work/it'\''s tree' '/work/it'\''s tree'`,
		);
	});
});
