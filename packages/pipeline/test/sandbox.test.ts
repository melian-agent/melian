import type * as childProcess from "node:child_process";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeInstallation, Sandbox, type SandboxPaths } from "../src/sandbox.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof childProcess>();
	return { ...original, spawnSync: vi.fn(original.spawnSync) };
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
	it(`allows only the selected incremental partition outside scratch (${backend})`, () => {
		const sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, { backend });
		const where = { ...paths(), incremental: join(base, "cache/mutation/selected") };
		const output = backend === "seatbelt" ? sandbox.profile(where)! : sandbox.command("true", where, "/profile");
		if (backend === "seatbelt") {
			expect(output).toContain(`(subpath "${where.incremental}")`);
			expect(output).toContain(`(allow file-write* (subpath "${where.scratch}") (subpath "${where.incremental}"))`);
			expect(output).not.toContain(`(subpath "${join(base, "cache")}")`);
		} else {
			expect(output).toContain(`--bind '${where.incremental}' '${where.incremental}'`);
			expect(output).not.toContain(`--bind '${join(base, "cache")}'`);
		}
	});
}
