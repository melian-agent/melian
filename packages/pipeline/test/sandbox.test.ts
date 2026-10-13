import type * as childProcess from "node:child_process";
import { execFile, spawn, spawnSync } from "node:child_process";
import type * as filesystem from "node:fs";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundContext as context, createNodeExecutionEnv, type ExecutionEnv } from "../src/harness.ts";
import { nodeExecutable, Sandbox, type SandboxPaths } from "../src/sandbox.ts";

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
		statSync: vi.fn(original.statSync),
	};
});

vi.mock("node:os", { spy: true });

const run = promisify(execFile);
const seatbeltAvailable =
	spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" })
		.status === 0;
// `script` needs a terminal on stdin, which Vitest does not give; the fixture forks a pty of its own.
const python = spawnSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).stdout.trim();
const withTerminal = fileURLToPath(new URL("./fixtures/with-terminal.py", import.meta.url));
const bubblewrapAvailable =
	spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"], { stdio: "ignore" }).status === 0;

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
// A test that names the shim by its path, as many do, with an environment of its own and no PATH or DEVELOPER_DIR. With a
// scratch TMPDIR the shim keeps its cache there and says nothing.
attempt("shim", () => {
  const shim = require("node:child_process").spawnSync("/usr/bin/git", ["init", "--quiet"], { env: { HOME: scratch + "/home", TMPDIR: scratch + "/home" }, cwd: scratch + "/shim", encoding: "utf8" });
  if (shim.status !== 0 || shim.stderr !== "") throw new Error(shim.stderr);
});
// Without one it still runs the real git, and complains on stderr that it could not keep a cache.
attempt("shimWithoutTemp", () => {
  const shim = require("node:child_process").spawnSync("/usr/bin/git", ["init", "--quiet"], { env: { HOME: scratch + "/home" }, cwd: scratch + "/bare", encoding: "utf8" });
  if (shim.status !== 0) throw new Error(shim.stderr);
});
// The head's own tests make repositories to test against.
attempt("git", () => {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: scratch + "/repository", stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "--allow-empty", "--quiet", "-m", "x"], { cwd: scratch + "/repository", stdio: "pipe" });
});
attempt("writeScratch", () => fs.writeFileSync(scratch + "/written", "1"));
attempt("writeOutside", () => fs.writeFileSync(outside + "/written", "1"));
// A tool that starts a server for its own workers listens on every interface and connects to it over loopback.
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

const host = createNodeExecutionEnv("/");
const detect = (platform: NodeJS.Platform) => Sandbox.detect(host, context, platform);

// An environment that answers every command with one exit code, or cannot run commands at all, and records them.
function answering(exitCode: number | undefined) {
	const exec = vi.fn<ExecutionEnv["exec"]>(async () =>
		exitCode === undefined
			? { ok: false, error: Object.assign(new Error("no shell"), { code: "spawn_error" as const }) }
			: { ok: true, value: { exitCode } },
	);
	return { env: { exec } as unknown as ExecutionEnv, exec };
}

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "melian-sandbox-")));
	for (const directory of [
		"home",
		"outside",
		"scratch/tree",
		"scratch/repository",
		"scratch/shim",
		"scratch/bare",
		"scratch/home",
		"installs",
	])
		mkdirSync(join(base, directory), { recursive: true });
	writeFileSync(join(base, "home/auth.json"), "{}");
	writeFileSync(join(base, "scratch/tree/probe.js"), probe);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const mock of [existsSync, readlinkSync, realpathSync, statSync, spawnSync]) vi.mocked(mock).mockReset();
	vi.unstubAllEnvs();
	rmSync(base, { recursive: true, force: true });
});

function paths(): SandboxPaths {
	return {
		worktree: join(base, "scratch/tree"),
		scratch: join(base, "scratch"),
		installs: [join(base, "installs")],
		node: nodeExecutable(),
	};
}

async function probed(sandbox: Sandbox, loopback?: boolean): Promise<Record<string, string>> {
	const where = { ...paths(), ...(loopback === undefined ? {} : { loopback }) };
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

describe("Sandbox.environment", () => {
	for (const platform of ["darwin", "linux"] as const) {
		it(`gives a PATH of Node's bin and the system's, whatever the host's is (${platform})`, async () => {
			const sandbox = (await Sandbox.detect(answering(0).env, context, platform))!;
			vi.stubEnv("PATH", "/opt/homebrew/bin:/Users/someone/bin");
			const directories = sandbox!.environment().PATH!.split(":");
			expect(directories).toContain(posix.dirname(nodeExecutable()));
			expect(directories.slice(-2)).toEqual(["/usr/bin", "/bin"]);
			expect(directories).not.toContain("/usr/sbin");
			expect(directories).not.toContain("/sbin");
			expect(directories).not.toContain("/opt/homebrew/bin");
			expect(directories).not.toContain("/Users/someone/bin");
			expect(sandbox!.environment().MELIAN_SANDBOX).toBe(platform === "darwin" ? "seatbelt" : "bubblewrap");
		});
	}
});

describe("Node runtime grants", () => {
	const home = "/home/reviewer";
	const versioned = `${home}/.nvm/versions/node/v24.18.0`;
	const backends = ["seatbelt", "bubblewrap"] as const;
	for (const backend of backends) {
		it.each([
			[versioned, true],
			[home, false],
			["/home", false],
			[`${home}/.local`, false],
			["/usr/local", false],
			["/usr", false],
			["/", false],
		] as const)(`grants only the executable and owned Node directories at %s (${backend})`, (prefix, owned) => {
			vi.mocked(homedir).mockReturnValue(home);
			const directory = statSync(base);
			vi.mocked(statSync).mockReturnValue(directory);
			vi.mocked(realpathSync).mockImplementation((path) => String(path));
			const node = join(prefix, "bin/node");
			const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend });
			const where = { worktree: "/work/tree", scratch: "/work", installs: [], node };
			const output = backend === "seatbelt" ? sandbox.profile(where)! : sandbox.command("true", where, "/unused");
			const grant = (path: string) =>
				backend === "seatbelt" ? `(subpath "${path}")` : `--ro-bind '${path}' '${path}'`;
			expect(output).not.toContain(grant(prefix));
			expect(output).toContain(backend === "seatbelt" ? `(literal "${node}")` : grant(node));
			for (const suffix of ["lib/node_modules", "include/node"]) {
				expect(output.includes(grant(join(prefix, suffix)))).toBe(owned);
			}
			if (backend === "bubblewrap") expect(output).not.toContain("--ro-bind '/usr' '/usr'");
		});

		it.each(["not-bin/node", "bin/other"])(
			`requires bin/node before granting directories (%s, ${backend})`,
			(suffix) => {
				vi.mocked(homedir).mockReturnValue(home);
				vi.mocked(statSync).mockReturnValue(statSync(base));
				const node = join(versioned, suffix);
				const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend });
				const where = { worktree: "/work/tree", scratch: "/work", installs: [], node };
				const output = backend === "seatbelt" ? sandbox.profile(where)! : sandbox.command("true", where, "/unused");
				expect(output).not.toContain(join(versioned, "lib/node_modules"));
				expect(output).not.toContain(join(versioned, "include/node"));
			},
		);

		it.each(["lib/node_modules", "include/node"])(
			`grants each existing Node directory independently (%s, ${backend})`,
			(suffix) => {
				vi.mocked(homedir).mockReturnValue(home);
				const directory = statSync(base);
				const permitted = join(versioned, suffix);
				vi.mocked(statSync).mockImplementation((path) =>
					path === versioned || path === permitted ? directory : undefined,
				);
				vi.mocked(realpathSync).mockImplementation((path) => String(path));
				const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend });
				const where = { worktree: "/work/tree", scratch: "/work", installs: [], node: join(versioned, "bin/node") };
				const output = backend === "seatbelt" ? sandbox.profile(where)! : sandbox.command("true", where, "/unused");
				expect(output).toContain(permitted);
				const absent = suffix === "lib/node_modules" ? "include/node" : "lib/node_modules";
				expect(output).not.toContain(join(versioned, absent));
			},
		);

		it.each(["absent prefix", "file prefix", "absent directory", "file directory", "linked directory"])(
			`refuses optional Node grants for %s (${backend})`,
			(layout) => {
				vi.mocked(homedir).mockReturnValue(home);
				const directory = statSync(base);
				const file = statSync(join(base, "home/auth.json"));
				vi.mocked(statSync).mockImplementation((path) => {
					if (path === versioned)
						return layout === "absent prefix" ? undefined : layout === "file prefix" ? file : directory;
					return layout === "absent directory" ? undefined : layout === "file directory" ? file : directory;
				});
				vi.mocked(realpathSync).mockImplementation((path) =>
					layout === "linked directory" && String(path).startsWith(versioned) ? "/host/private" : String(path),
				);
				const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend });
				const where = { worktree: "/work/tree", scratch: "/work", installs: [], node: join(versioned, "bin/node") };
				const output = backend === "seatbelt" ? sandbox.profile(where)! : sandbox.command("true", where, "/unused");
				expect(output).not.toContain(join(versioned, "lib/node_modules"));
				expect(output).not.toContain(join(versioned, "include/node"));
				expect(output).not.toContain("/host/private");
			},
		);
	}

	it("uses the real executable as the runtime literal", () => {
		vi.mocked(realpathSync).mockImplementation((path) => {
			expect(path).toBe(process.execPath);
			return "/real/node/bin/node";
		});
		expect(nodeExecutable()).toBe("/real/node/bin/node");
	});
});

it.skipIf(!seatbeltAvailable)(
	"denies reading a file beside bin in a home-shaped Node prefix",
	{ timeout: 60_000 },
	async () => {
		const prefix = join(base, "home");
		mkdirSync(join(prefix, "bin"));
		const node = join(prefix, "bin/node");
		copyFileSync(process.execPath, node);
		vi.mocked(homedir).mockReturnValue(prefix);
		const sandbox = (await detect("darwin"))!;
		const where = { ...paths(), node };
		const script = join(where.worktree, "beside-bin.cjs");
		writeFileSync(
			script,
			"try { require('node:fs').readFileSync(process.argv[2]); console.log('read'); } catch { console.log('denied'); }",
		);
		const marker = join(prefix, "auth.json");
		expect((await run(node, [script, marker])).stdout.trim()).toBe("read");
		const profile = join(where.scratch, "node.sb");
		writeFileSync(profile, sandbox.profile(where)!);
		const result = await run(
			"/bin/bash",
			[
				"-c",
				sandbox.command(
					`${JSON.stringify(node)} ${JSON.stringify(script)} ${JSON.stringify(marker)}`,
					where,
					profile,
				),
			],
			{
				env: { ...sandbox.environment(), HOME: join(where.scratch, "home"), TMPDIR: where.scratch },
			},
		);
		expect(result.stdout.trim()).toBe("denied");
	},
);

describe("the bubblewrap command", () => {
	// Built without running it, so it is checked on every host; the probe below runs it where bwrap exists.
	const bubblewrap = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "bubblewrap" as const });
	const where = {
		worktree: "/work/tree",
		scratch: "/work",
		installs: ["/checkout/node_modules"],
		node: "/opt/node/bin/node",
	};
	const command = bubblewrap.command("echo 'hi'", where, "/unused");

	it("unshares every namespace, dies with its parent, and runs the command in the worktree", () => {
		expect(command.startsWith("bwrap --unshare-all --die-with-parent --new-session ")).toBe(true);
		expect(command).toContain("--chdir '/work/tree'");
		expect(command.endsWith("-- /bin/bash -c 'echo '\\''hi'\\'''")).toBe(true);
	});

	it("binds the node installation and the installs read-only, scratch read-write, and nothing of the home", () => {
		expect(command).toContain("--ro-bind '/opt/node/bin/node' '/opt/node/bin/node'");
		expect(command).toContain("--ro-bind '/checkout/node_modules' '/checkout/node_modules'");
		expect(command).toContain("--bind '/work' '/work'");
		expect(command).not.toContain("--bind '/work/tree'");
		expect(command).not.toMatch(/ --(ro-)?bind '\/(home|root|Users)/);
	});

	it("binds the system directories the host has, read-only, and a private /proc, /dev, and /tmp before scratch", () => {
		for (const directory of ["/usr/bin", "/bin"])
			if (existsSync(directory)) expect(command).toContain(`--ro-bind '${directory}' '${directory}'`);
		for (const absent of [
			"/etc",
			"/usr",
			"/usr/local",
			"/usr/sbin",
			"/sbin",
			"/lib32",
			"/etc/hosts",
			"/var",
			"/home",
		])
			expect(command).not.toContain(`--ro-bind '${absent}' `);
		expect(command).toContain("--proc /proc --dev /dev --tmpfs /tmp");
		expect(command.indexOf("--tmpfs /tmp")).toBeLessThan(command.indexOf("--bind '/work' '/work'"));
	});
});

describe("Sandbox.detect", () => {
	it("finds no sandbox on a platform that has neither backend, and starts nothing to find out", async () => {
		const { env, exec } = answering(0);
		expect(await Sandbox.detect(env, context, "freebsd")).toBeUndefined();
		expect(await Sandbox.detect(env, context, "win32")).toBeUndefined();
		expect(exec).not.toHaveBeenCalled();
	});

	for (const [platform, backend, trial] of [
		["darwin", "seatbelt", "/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true"],
		["linux", "bubblewrap", "bwrap --unshare-all --ro-bind / / true"],
	] as const) {
		it(`starts ${backend} through the run's environment and requires it to succeed`, async () => {
			vi.stubEnv("PATH", "/opt/tools:/usr/bin");
			vi.stubEnv("MELIAN_TEST_SECRET", "hunter2");
			const working = answering(0);
			expect((await Sandbox.detect(working.env, context, platform))?.backend).toBe(backend);
			expect(working.exec).toHaveBeenCalledExactlyOnceWith(
				trial,
				{ inheritEnv: false, env: { PATH: "/opt/tools:/usr/bin" }, timeout: 30 },
				context,
			);
			expect(await Sandbox.detect(answering(1).env, context, platform)).toBeUndefined();
			expect(await Sandbox.detect(answering(undefined).env, context, platform)).toBeUndefined();
		});
	}

	it("falls back to the system PATH when the process has none", async () => {
		vi.stubEnv("PATH", undefined);
		const { env, exec } = answering(0);
		await Sandbox.detect(env, context, "linux");
		expect(exec.mock.calls[0]![1]?.env).toEqual({ PATH: "/usr/bin:/bin" });
	});

	it.skipIf(process.platform === "darwin")("finds no seatbelt where sandbox-exec is absent", async () => {
		expect(await detect("darwin")).toBeUndefined();
	});
});

it.each(["seatbelt", "bubblewrap"] as const)(
	"refuses a runtime that cannot start within %s without widening its grants",
	async (backend) => {
		const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend });
		const where = paths();
		const started = answering(0);
		expect(await sandbox.runtimeFailure(where, started.env, context)).toBeUndefined();
		const [command, options, at] = started.exec.mock.calls[0]!;
		expect(command).toBe(sandbox.command(`'${where.node}' --version`, where, "", sandbox.profile(where)));
		expect(options).toEqual({
			inheritEnv: false,
			env: { ...sandbox.environment(), HOME: where.scratch, TMPDIR: where.scratch },
			timeout: 30,
		});
		expect(options?.env?.MELIAN_SANDBOX).toBe(backend);
		expect(at).toBe(context);
		for (const failing of [answering(1), answering(undefined)])
			expect(await sandbox.runtimeFailure(where, failing.env, context)).toBe(
				`Node runtime ${where.node} could not start within ${backend}; the runtime grant was not widened`,
			);
	},
);

describe.skipIf(!seatbeltAvailable)("seatbelt", { timeout: 60_000 }, () => {
	it.each([
		[undefined, "denied"],
		[false, "denied"],
		[true, "ok"],
	] as const)(
		"denies the reviewer's home and the network, and allows writes under scratch only (loopback %s)",
		async (loopback, reached) => {
			const sandbox = (await detect("darwin")) as Sandbox;
			expect(await probed(sandbox, loopback)).toEqual({
				readHome: "denied",
				sh: "ok",
				shim: "ok",
				shimWithoutTemp: "ok",
				git: "ok",
				writeScratch: "ok",
				writeOutside: "denied",
				loopback: reached,
				connect: "denied",
			});
			expect(readFileSync(join(base, "scratch/written"), "utf8")).toBe("1");
		},
	);
});

it.skipIf(!seatbeltAvailable)(
	"requires a scratch HOME for a child with an otherwise empty environment inside seatbelt",
	{ timeout: 60_000 },
	async () => {
		const sandbox = (await detect("darwin")) as Sandbox;
		const where = paths();
		const file = join(where.scratch, "sandbox.sb");
		writeFileSync(file, sandbox.profile(where)!);
		const home = join(where.scratch, "home");
		writeFileSync(
			join(where.worktree, "home.cjs"),
			`
const { spawnSync } = require("node:child_process");
const args = ["-e", "console.log(require('node:os').homedir())"];
const absent = spawnSync(process.execPath, args, { env: {}, encoding: "utf8" });
const present = spawnSync(process.execPath, args, { env: { HOME: process.argv[2] }, encoding: "utf8" });
console.log(JSON.stringify({ absent: { status: absent.status, stderr: absent.stderr }, present: { status: present.status, stdout: present.stdout, stderr: present.stderr } }));
`,
		);
		const inner = `${JSON.stringify(process.execPath)} home.cjs ${JSON.stringify(home)}`;
		const { stdout } = await run("/bin/bash", ["-c", sandbox.command(inner, where, file)], {
			timeout: 30_000,
			env: { ...sandbox.environment(), HOME: home, TMPDIR: where.scratch },
		});
		expect(JSON.parse(stdout)).toEqual({
			absent: { status: 1, stderr: expect.stringContaining("uv_os_homedir returned ENOENT") },
			present: { status: 0, stdout: `${home}\n`, stderr: "" },
		});
	},
);

describe.skipIf(!bubblewrapAvailable)("bubblewrap", { timeout: 60_000 }, () => {
	it.each([undefined, true] as const)(
		"denies the reviewer's home and the network, and allows writes under scratch only (loopback %s)",
		async (loopback) => {
			const sandbox = (await detect("linux")) as Sandbox;
			const { loopback: reached, ...rest } = await probed(sandbox, loopback);
			expect(rest).toEqual({
				readHome: "denied",
				sh: "ok",
				shim: "ok",
				shimWithoutTemp: "ok",
				git: "ok",
				writeScratch: "ok",
				writeOutside: "denied",
				connect: "denied",
			});
			// The namespace's own loopback is always up. Whether `localhost` resolves without the hosts file is the C
			// library's choice, so the name is asserted only where the file is bound.
			if (loopback === true) expect(reached).toBe("ok");
			expect(readFileSync(join(base, "scratch/written"), "utf8")).toBe("1");
		},
	);

	// The Linux counterpart of the seatbelt test of what the profile no longer grants: what the namespace holds at all.
	it("shows the command a filesystem of the named binds only, its own processes, and no terminal", async () => {
		vi.stubEnv("MELIAN_TEST_KEY", "environment-marker-112");
		const sandbox = (await detect("linux")) as Sandbox;
		const where = paths();
		writeFileSync(
			join(where.worktree, "namespace.cjs"),
			`const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [home, outside, host] = process.argv.slice(2);
const list = (path) => { try { return fs.readdirSync(path).sort(); } catch (error) { return error.code; } };
const opens = (path, flags = "r") => { try { fs.closeSync(fs.openSync(path, flags)); return "ok"; } catch (error) { return error.code; } };
console.log(JSON.stringify({
  control: [spawnSync("/usr/bin/true").status, opens(process.argv[1])],
  etc: list("/etc"),
  usr: list("/usr"),
  absent: ["/usr/local", "/usr/sbin", "/sbin", "/lib32", "/var", "/root", "/etc/hosts", "/etc/shadow", "/etc/ssh", home + "/auth.json", outside].filter((path) => fs.existsSync(path)),
  processes: list("/proc").filter((name) => /^[0-9]+$/.test(name)).length,
  hostProcess: fs.existsSync("/proc/" + host),
  environments: list("/proc").filter((name) => /^[0-9]+$/.test(name)).map((pid) => { try { return fs.readFileSync("/proc/" + pid + "/environ", "utf8"); } catch (error) { return ""; } }).join("\\0"),
  terminal: opens("/dev/tty", "r+"),
  devices: list("/dev"),
  temporary: list("/tmp").length,
  writeEtc: opens("/etc/passwd", "a"),
  writeInstalls: opens(process.argv[5] + "/written", "w"),
}));`,
		);
		const inner = `${JSON.stringify(process.execPath)} namespace.cjs ${base}/home ${base}/outside ${process.pid} ${base}/installs`;
		const { stdout } = await run("/bin/bash", ["-c", sandbox.command(inner, where, "")], {
			timeout: 30_000,
			env: { ...sandbox.environment(), HOME: join(where.scratch, "home"), TMPDIR: where.scratch },
		});
		const seen = JSON.parse(stdout) as Record<string, unknown>;
		// /proc is a new one for the namespace. Every environment readable through it is one Melian built for the
		// command: the key this test process holds is in none, and no variable but the sandbox's own is there.
		expect(process.env.MELIAN_TEST_KEY).toBe("environment-marker-112");
		expect(seen.environments).not.toContain("environment-marker-112");
		const variables = new Set(
			String(seen.environments)
				.split("\0")
				.filter((entry) => entry.includes("="))
				.map((entry) => entry.slice(0, entry.indexOf("="))),
		);
		for (const name of variables)
			expect(["PATH", "HOME", "TMPDIR", "MELIAN_SANDBOX", "PWD", "OLDPWD", "SHLVL", "_"]).toContain(name);
		expect(variables.has("MELIAN_SANDBOX")).toBe(true);
		// The control: a system tool runs and the script reads itself, so what is missing below is the namespace's doing.
		expect(seen.control).toEqual([0, "ok"]);
		const allowed = ["alternatives", "group", "ld.so.cache", "localtime", "nsswitch.conf", "passwd"];
		expect((seen.etc as string[]).filter((name) => !allowed.includes(name))).toEqual([]);
		expect(seen.etc).toContain("passwd");
		expect((seen.usr as string[]).filter((name) => !["bin", "lib", "lib64", "share"].includes(name))).toEqual([]);
		expect(seen.absent).toEqual([]);
		// Its own process table: bubblewrap, bash, and this script, never the hundreds the host runs.
		expect(seen.processes).toBeLessThan(10);
		expect(seen.hostProcess).toBe(false);
		expect(seen.terminal).not.toBe("ok");
		expect(
			(seen.devices as string[]).filter((name) => /^(tty[A-Za-z0-9]+|sd|nvme|disk|mem|kmsg)/.test(name)),
		).toEqual([]);
		expect(seen.temporary).toBeLessThanOrEqual(1);
		expect(seen.writeEtc).not.toBe("ok");
		expect(seen.writeInstalls).not.toBe("ok");
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

it.each([
	[undefined, []],
	[false, []],
	[true, ['(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))']],
] as const)("gives the seatbelt profile no network rule unless loopback is asked for (%s)", (loopback, expected) => {
	const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "seatbelt" });
	const rules = sandbox
		.profile({ ...paths(), ...(loopback === undefined ? {} : { loopback }) })!
		.split("\n")
		.filter((line) => /network/.test(line.replace(/^\s*;.*/, "")));
	expect(rules).toEqual(expected);
});

it.each([
	[undefined, false],
	[false, false],
	[true, true],
] as const)("binds the hosts file under bubblewrap only when loopback is asked for (%s)", (loopback, bound) => {
	vi.mocked(existsSync).mockReturnValue(true);
	const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "bubblewrap" });
	const command = sandbox.command("true", { ...paths(), ...(loopback === undefined ? {} : { loopback }) }, "/unused");
	expect(command.includes("--ro-bind '/etc/hosts' '/etc/hosts'")).toBe(bound);
	expect(command).toContain("--unshare-all");
	// The whole list of system binds, in order: a path added or widened fails here.
	expect([...command.matchAll(/--ro-bind '(\/(?:usr|bin|lib|lib64|etc)[^']*)'/g)].map((match) => match[1])).toEqual([
		"/usr/bin",
		"/usr/lib",
		"/usr/lib64",
		"/usr/share",
		"/bin",
		"/lib",
		"/lib64",
		"/etc/alternatives",
		"/etc/ld.so.cache",
		"/etc/nsswitch.conf",
		"/etc/passwd",
		"/etc/group",
		"/etc/localtime",
		...(bound ? ["/etc/hosts"] : []),
	]);
});

describe("sandbox policy on a host that cannot start nested sandboxes", () => {
	const seatbelt = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "seatbelt" as const });
	const bubblewrap = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "bubblewrap" as const });
	const where = {
		worktree: "/work/tree",
		scratch: "/work",
		installs: ["/checkout/node_modules"],
		node: "/opt/node/bin/node",
	};

	it("uses a retained inline profile for housekeeping instead of a head-written profile file", () => {
		expect(seatbelt.command("true", where, "/work/tampered.sb", "(version 1)(deny default)")).toBe(
			"cd '/work/tree' && /usr/bin/sandbox-exec -p '(version 1)(deny default)' /bin/bash -c 'true'",
		);
		expect(seatbelt.command("true", where, "/work/profile.sb")).toBe(
			"cd '/work/tree' && /usr/bin/sandbox-exec -f '/work/profile.sb' /bin/bash -c 'true'",
		);
	});

	function host(developer: string | undefined) {
		vi.mocked(readlinkSync).mockImplementation((path) => {
			expect(path).toBe("/var/select/developer_dir");
			if (developer === undefined) throw new Error("no developer link");
			return developer;
		});
		vi.mocked(existsSync).mockImplementation((path) => path === `${developer}/usr/bin/git`);
	}

	it("renders just the allowed reads and parent metadata when developer tools are absent", () => {
		host(undefined);
		const readable =
			'(literal "/") (literal "/private/etc/localtime") (literal "/private/var/select/sh") (literal "/private/var/select/developer_dir") (literal "/opt/node/bin/node") (subpath "/usr/lib") (subpath "/usr/bin") (subpath "/usr/share") (subpath "/bin") (subpath "/System") (subpath "/private/var/db/timezone") (subpath "/work") (subpath "/checkout/node_modules")';
		// The whole profile, rule for rule: a grant added or widened anywhere fails here.
		expect(seatbelt.profile(where)!.split("\n")).toEqual([
			"(version 1)",
			"(deny default)",
			"(allow process-fork)",
			`(allow process-exec ${readable})`,
			`(allow file-map-executable ${readable})`,
			"(allow signal (target same-sandbox))",
			'(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.ostype") (sysctl-name "kern.osrelease") (sysctl-name "kern.version") (sysctl-name "kern.hostname") (sysctl-name "kern.argmax") (sysctl-name "kern.boottime"))',
			"(deny process-info*)",
			"(allow process-info* (target self))",
			`(allow file-read* ${readable})`,
			'(allow file-read-metadata (literal "/") (literal "/etc") (literal "/var") (literal "/opt/node/bin") (literal "/opt/node") (literal "/opt") (literal "/checkout"))',
			'(allow file-write* (subpath "/work"))',
			'(allow file-read* (literal "/dev/null") (literal "/dev/urandom"))',
			'(allow file-write-data (literal "/dev/null"))',
			'(deny file-read* file-write* (literal "/dev/tty"))',
			"",
		]);
		expect(
			seatbelt
				.profile({ ...where, loopback: true })!
				.split("\n")
				.slice(-4),
		).toEqual([
			'(allow network-inbound (local ip "localhost:*"))',
			'(allow network-outbound (remote ip "localhost:*"))',
			'(allow file-read* (literal "/private/etc/hosts"))',
			"",
		]);
		// A standalone program is granted as its own file in each rule that names the readable paths, with its parents'
		// metadata, and its directory is not.
		const tool = seatbelt.profile({ ...where, executables: ["/opt/tools/bin/lint"] })!.split("\n");
		const withTool = readable.replace(
			'(literal "/opt/node/bin/node")',
			'(literal "/opt/node/bin/node") (literal "/opt/tools/bin/lint")',
		);
		expect(tool.slice(3, 5)).toEqual([`(allow process-exec ${withTool})`, `(allow file-map-executable ${withTool})`]);
		expect(tool[9]).toBe(`(allow file-read* ${withTool})`);
		expect(tool[10]).toBe(
			'(allow file-read-metadata (literal "/") (literal "/etc") (literal "/var") (literal "/opt/node/bin") (literal "/opt/node") (literal "/opt") (literal "/opt/tools/bin") (literal "/opt/tools") (literal "/checkout"))',
		);
		expect(tool.join("\n")).not.toContain('(subpath "/opt/tools');
		const bound = bubblewrap.command("true", { ...where, executables: ["/opt/tools/bin/lint"] }, "/unused");
		expect(bound).toContain(
			"--ro-bind '/opt/node/bin/node' '/opt/node/bin/node' --ro-bind '/opt/tools/bin/lint' '/opt/tools/bin/lint'",
		);
		expect(bound).not.toContain("'/opt/tools/bin' ");
		expect(bubblewrap.command("true", where, "/unused")).not.toContain("/opt/tools");
		expect(bubblewrap.profile(where)).toBeUndefined();
	});

	it("balances generated profile parentheses outside string literals", () => {
		host("/dev-tools/Xcode(parent)");
		const profile = seatbelt.profile({
			...where,
			scratch: "/work/(scratch)",
			installs: ["/checkout (copy)/node_modules"],
		})!;
		const syntax = profile.replace(/"(?:\\.|[^"\\])*"/g, "");
		let depth = 0;
		for (const character of syntax) {
			if (character === "(") depth++;
			else if (character === ")") depth--;
			expect(depth).toBeGreaterThanOrEqual(0);
		}
		expect(depth).toBe(0);
	});

	it("grants no Mach service and nothing in the host's per-user temporary directory", () => {
		host("/dev-tools/Xcode");
		const profile = seatbelt.profile(where)!;
		expect(profile).not.toMatch(/^\(allow[^\n]*mach-lookup/m);
		expect(profile).not.toMatch(/^\(allow[^\n]*xcrun_db/m);
		expect(profile).not.toMatch(/^\(allow[^\n]*\(regex /m);
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("allows only literal runtime devices and no terminal family", () => {
		host(undefined);
		const deviceRules = seatbelt
			.profile(where)!
			.split("\n")
			.filter((rule) => rule.startsWith("(allow") && rule.includes('"/dev/'));
		expect(deviceRules).toEqual([
			'(allow file-read* (literal "/dev/null") (literal "/dev/urandom"))',
			'(allow file-write-data (literal "/dev/null"))',
		]);
	});
	it("stops ancestor traversal at the root before asking for its parent", () => {
		host(undefined);
		const dirname = posix.dirname;
		const parent = vi.spyOn(posix, "dirname").mockImplementation((path) => {
			if (path === "/" || path === ".") throw new Error("ancestor traversal passed its root");
			return dirname(path);
		});
		expect(seatbelt.profile(where)).toContain(
			'(literal "/opt/node/bin") (literal "/opt/node") (literal "/opt") (literal "/checkout")',
		);
		expect(parent).toHaveBeenCalledTimes(7);
	});

	it("does not inspect macOS developer tools for a bubblewrap environment", () => {
		host("/dev-tools/Xcode");
		expect(bubblewrap.environment()).toStrictEqual({
			PATH: `${posix.dirname(nodeExecutable())}:/usr/bin:/bin`,
			MELIAN_SANDBOX: "bubblewrap",
		});
		expect(readlinkSync).not.toHaveBeenCalled();
	});

	it("names the developer tools in the environment and grants them read-only", () => {
		host("/dev-tools/Xcode");
		const environment = seatbelt.environment();
		expect(environment.DEVELOPER_DIR).toBe("/dev-tools/Xcode");
		expect(environment.PATH!.split(":")[0]).toBe("/dev-tools/Xcode/usr/bin");
		expect(environment.MELIAN_SANDBOX).toBe("seatbelt");
		const profile = seatbelt.profile(where)!;
		expect(profile).toContain('(subpath "/dev-tools/Xcode")');
		expect(profile).toContain('(allow file-write* (subpath "/work"))');
	});

	it("uses the default developer tools when no selector link exists", () => {
		host(undefined);
		vi.mocked(existsSync).mockImplementation((path) => path === "/Library/Developer/CommandLineTools/usr/bin/git");
		expect(seatbelt.environment().DEVELOPER_DIR).toBe("/Library/Developer/CommandLineTools");
		expect(seatbelt.profile(where)).toContain('(subpath "/Library/Developer/CommandLineTools")');
	});

	it("omits developer tools the host does not have", () => {
		host("/missing/developer");
		vi.mocked(existsSync).mockReturnValue(false);
		expect(seatbelt.environment()).toStrictEqual({
			PATH: `${posix.dirname(nodeExecutable())}:/usr/bin:/bin`,
			MELIAN_SANDBOX: "seatbelt",
		});
		expect(seatbelt.profile(where)).not.toContain("/missing/developer");
	});

	it("binds only Linux system paths the host has", () => {
		vi.mocked(existsSync).mockImplementation((path) => ["/usr/bin", "/etc/group"].includes(String(path)));
		const command = bubblewrap.command("true", { ...where, loopback: true }, "/unused");
		expect(command).toContain("--ro-bind '/usr/bin' '/usr/bin'");
		expect(command).toContain("--ro-bind '/etc/group' '/etc/group'");
		expect(command).not.toContain("--ro-bind '/bin'");
		expect(command).not.toContain("--ro-bind '/etc/passwd'");
		expect(command).not.toContain("--ro-bind '/etc/hosts'");
	});

	it.each(['"', "\\", "\n"])("rejects a seatbelt path with %j", (character) => {
		host(undefined);
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

it("denies terminal device reads and writes in the seatbelt policy", () => {
	const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend: "seatbelt" as const });
	const profile = sandbox.profile(paths())!;
	expect(profile).toContain('(deny file-read* file-write* (literal "/dev/tty"))');
	expect(profile).not.toMatch(/^\(allow[^\n]*\/dev\/tty/m);
});

it.skipIf(!seatbeltAvailable || python === "")(
	"denies opening the controlling terminal and its pty slave from head code",
	{ timeout: 60_000 },
	async () => {
		const sandbox = (await detect("darwin"))!;
		const where = paths();
		const probe = join(where.worktree, "tty.cjs");
		writeFileSync(
			probe,
			`const fs = require("node:fs");
const slave = process.env.MELIAN_TEST_PTY_SLAVE;
const result = { slave };
for (const [name, path] of [["tty", "/dev/tty"], ["pty", slave]]) {
    try {
        const fd = fs.openSync(path, "r+");
        fs.closeSync(fd);
        result[name] = { opened: true };
    } catch (error) {
        result[name] = { code: error.code };
    }
}
console.log(JSON.stringify(result));`,
		);
		const environment = { ...sandbox.environment(), HOME: join(where.scratch, "home"), TMPDIR: where.scratch };
		const outside = await run(python, ["-I", withTerminal, process.execPath, probe], { env: environment });
		expect(JSON.parse(outside.stdout)).toEqual({
			slave: expect.stringMatching(/^\/dev\/ttys[0-9]+$/),
			tty: { opened: true },
			pty: { opened: true },
		});
		const policy = join(where.scratch, "tty.sb");
		writeFileSync(policy, sandbox.profile(where)!);
		const inside = await run(
			python,
			[
				"-I",
				withTerminal,
				"/bin/bash",
				"-c",
				sandbox.command(`${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}`, where, policy),
			],
			{ env: environment },
		);
		expect(JSON.parse(inside.stdout)).toEqual({
			slave: expect.stringMatching(/^\/dev\/ttys[0-9]+$/),
			tty: { code: "EPERM" },
			pty: { code: "EPERM" },
		});
	},
);

it.skipIf(!seatbeltAvailable)(
	"cannot create, modify, or read a file in the host's per-user temporary directory",
	{ timeout: 60_000 },
	async () => {
		const asked = await run("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"]);
		const directory = realpathSync(asked.stdout.trim());
		const sandbox = (await detect("darwin"))!;
		const where = paths();
		// Names the retired grant matched, so a profile that brings it back fails here.
		const created = join(directory, `xcrun_db-MelianCreated${process.pid}`);
		const existing = join(directory, `xcrun_db-MelianExisting${process.pid}`);
		writeFileSync(existing, "host");
		const probe = join(where.worktree, "temporary.cjs");
		writeFileSync(
			probe,
			`const fs = require("node:fs");
const [created, existing] = process.argv.slice(2);
const result = {};
const attempt = (name, body) => { try { body(); result[name] = "ok"; } catch (error) { result[name] = error.code; } };
attempt("control", () => fs.writeFileSync(process.argv[4] + "/control", "sandbox"));
attempt("create", () => fs.writeFileSync(created, "sandbox"));
attempt("modify", () => fs.appendFileSync(existing, "sandbox"));
attempt("replace", () => fs.renameSync(process.argv[1], existing));
attempt("read", () => fs.readFileSync(existing, "utf8"));
attempt("list", () => fs.readdirSync(require("node:path").dirname(existing)));
console.log(JSON.stringify(result));`,
		);
		try {
			const inner = `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)} ${JSON.stringify(created)} ${JSON.stringify(existing)} ${JSON.stringify(where.scratch)}`;
			const { stdout } = await run("/bin/bash", ["-c", sandbox.command(inner, where, "", sandbox.profile(where))], {
				env: { ...sandbox.environment(), HOME: join(where.scratch, "home"), TMPDIR: where.scratch },
			});
			// The control: the same process writes in scratch, so each refusal is the profile's and not a failed start.
			expect(JSON.parse(stdout)).toEqual({
				control: "ok",
				create: "EPERM",
				modify: "EPERM",
				replace: "EPERM",
				read: "EPERM",
				list: "EPERM",
			});
			expect(existsSync(created)).toBe(false);
			expect(readFileSync(existing, "utf8")).toBe("host");
		} finally {
			rmSync(created, { force: true });
			rmSync(existing, { force: true });
		}
	},
);

it.skipIf(!seatbeltAvailable)(
	"refuses what the profile no longer grants: programs, host files, devices, and other processes",
	{ timeout: 60_000 },
	async () => {
		const sandbox = (await detect("darwin"))!;
		const where = paths();
		const outside = join(base, "outside/true");
		copyFileSync("/usr/bin/true", outside);
		const probe = join(where.worktree, "narrow.cjs");
		writeFileSync(
			probe,
			`const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [outside, host] = process.argv.slice(2);
const result = {};
const attempt = (name, body) => { try { body(); result[name] = "ok"; } catch (error) { result[name] = error.code; } };
const start = (file, args = []) => { const r = spawnSync(file, args); if (r.error) throw r.error; if (r.status !== 0) throw Object.assign(new Error("exit"), { code: "exit " + r.status }); };
attempt("run a system tool", () => start("/usr/bin/true"));
attempt("run a program outside the readable set", () => start(outside));
attempt("run a program in sbin", () => start("/sbin/ifconfig", ["lo0"]));
attempt("signal a process outside", () => process.kill(Number(host), 0));
attempt("stop its own child", () => start("/bin/sh", ["-c", "/bin/sleep 30 & kill $!"]));
for (const path of ["/Library/Preferences", "/Library/Apple", "/private/etc", "/private/var/select", "/Users", "/dev"])
  attempt("list " + path, () => fs.readdirSync(path));
for (const path of ["/private/etc/hosts", "/private/etc/passwd", "/dev/zero", "/dev/random", "/dev/dtracehelper"])
  attempt("read " + path, () => fs.closeSync(fs.openSync(path, "r")));
for (const path of ["/private/etc/localtime", "/private/var/select/sh", "/dev/urandom", "/dev/null"])
  attempt("read " + path, () => fs.closeSync(fs.openSync(path, "r")));
console.log(JSON.stringify(result));`,
		);
		const inner = `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)} ${JSON.stringify(outside)} ${process.pid}`;
		const { stdout } = await run("/bin/bash", ["-c", sandbox.command(inner, where, "", sandbox.profile(where))], {
			env: { ...sandbox.environment(), HOME: join(where.scratch, "home"), TMPDIR: where.scratch },
		});
		expect(JSON.parse(stdout)).toEqual({
			"run a system tool": "ok",
			"run a program outside the readable set": "EPERM",
			"run a program in sbin": "EPERM",
			"signal a process outside": "EPERM",
			"stop its own child": "ok",
			"list /Library/Preferences": "EPERM",
			"list /Library/Apple": "EPERM",
			"list /private/etc": "EPERM",
			"list /private/var/select": "EPERM",
			"list /Users": "EPERM",
			"list /dev": "EPERM",
			"read /private/etc/hosts": "EPERM",
			"read /private/etc/passwd": "EPERM",
			"read /dev/zero": "EPERM",
			"read /dev/random": "EPERM",
			"read /dev/dtracehelper": "EPERM",
			"read /private/etc/localtime": "ok",
			"read /private/var/select/sh": "ok",
			"read /dev/urandom": "ok",
			"read /dev/null": "ok",
		});
	},
);

// The calls a tool would make to read another process, made directly: `ps` is setuid and fails to start for that
// reason alone, which proves nothing about the calls.
const compiler = spawnSync("/usr/bin/which", ["cc"], { encoding: "utf8" }).stdout.trim();
it.skipIf(!seatbeltAvailable || compiler === "")(
	"cannot read another process's environment, list processes, or find another's path (needs a C compiler)",
	{ timeout: 60_000 },
	async () => {
		const sandbox = (await detect("darwin"))!;
		const where = paths();
		const probe = join(where.worktree, "process-probe");
		await run(compiler, ["-o", probe, fileURLToPath(new URL("./fixtures/process-probe.c", import.meta.url))]);
		// A process of the reviewer's with a key in its environment. It ends itself, and the test stops it by its pid.
		const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
			env: { MELIAN_TEST_KEY: "environment-marker-112" },
			stdio: "ignore",
		});
		try {
			const outside = JSON.parse((await run(probe, [String(holder.pid), "environment-marker-112"])).stdout);
			// The control: outside the sandbox every one of these reads works, and the key is there to be found.
			expect(outside).toMatchObject({
				arguments: 1,
				marker: 1,
				table: 1,
				entry: 1,
				path: 1,
				ownPath: 1,
				hardware: 1,
			});
			expect(outside.pids).toBeGreaterThan(10);
			const { stdout } = await run(
				"/bin/bash",
				[
					"-c",
					sandbox.command(
						`./process-probe ${holder.pid} environment-marker-112`,
						where,
						"",
						sandbox.profile(where),
					),
				],
				{ env: { ...sandbox.environment(), HOME: join(where.scratch, "home"), TMPDIR: where.scratch } },
			);
			expect(JSON.parse(stdout)).toEqual({
				arguments: 0,
				marker: 0,
				table: 0,
				entry: 0,
				path: 0,
				pids: 0,
				// It may still ask about itself and read the hardware's description, and no other sysctl.
				ownPath: 1,
				hardware: 1,
				session: 0,
			});
		} finally {
			holder.kill("SIGKILL");
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"has a C compiler on a macOS host, so the process test above did not skip",
	() => {
		expect(seatbeltAvailable ? compiler : "not needed").not.toBe("");
	},
);
