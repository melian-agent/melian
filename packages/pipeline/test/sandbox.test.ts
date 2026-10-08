import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeInstallation, Sandbox, type SandboxPaths } from "../src/sandbox.ts";

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
// A test that names the shim by its path, as many do.
attempt("shim", () => {
  execFileSync("/usr/bin/git", ["--version"], { stdio: "pipe" });
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
	for (const directory of ["home", "outside", "scratch/tree", "scratch/repository", "scratch/home", "installs"])
		mkdirSync(join(base, directory), { recursive: true });
	writeFileSync(join(base, "home/auth.json"), "{}");
	writeFileSync(join(base, "scratch/tree/probe.js"), probe);
});

afterEach(() => {
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
			},
		);
	}
});

describe("Sandbox.detect", () => {
	it("finds no sandbox on a platform that has neither backend", () => {
		expect(Sandbox.detect("freebsd")).toBeUndefined();
		expect(Sandbox.detect("win32")).toBeUndefined();
	});

	it.skipIf(process.platform !== "darwin")("finds seatbelt on macOS", () => {
		expect(Sandbox.detect("darwin")?.backend).toBe("seatbelt");
	});

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
