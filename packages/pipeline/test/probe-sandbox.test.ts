import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Probe, type ProbeInput, type ProbeOptions, type ProbeResult } from "../src/probe.ts";

// Each attack runs a real probe under sandbox-runtime and must fail there. A probe that got through would do no harm: it
// reads paths and reports only whether it could, writes marker files the test removes, and connects to a server the test
// owns. Where the sandbox cannot run, the suite skips, unless MELIAN_PROBE_SANDBOX=1 says this host must run it, as CI
// does on macOS and Linux; then every test fails with the reason.

const availability = await Probe.availability();
const required = process.env.MELIAN_PROBE_SANDBOX === "1";
const reason = availability.available ? "" : availability.reason;

let worktree: string;
let outside: string;
let markers: string[];

beforeEach(() => {
	worktree = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-worktree-")));
	outside = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-outside-")));
	markers = [];
	writeFileSync(join(worktree, "AGENTS.md"), "inside\n");
	mkdirSync(join(worktree, ".git"));
	writeFileSync(join(worktree, ".git", "config"), "[credential]\n");
	writeFileSync(join(worktree, ".env"), "TOKEN=x\n");
	writeFileSync(join(outside, "secret.txt"), "secret\n");
	symlinkSync(join(outside, "secret.txt"), join(worktree, "escape"));
});

afterEach(() => {
	for (const marker of markers) rmSync(marker, { force: true });
	rmSync(worktree, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

function opened(input: ProbeInput, options: Partial<ProbeOptions> = {}): Promise<Probe> {
	return Probe.open(input, { worktree, writer: { trusted: true, by: "writer" }, trustWriters: true, ...options });
}

async function probed(input: ProbeInput, options: Partial<ProbeOptions> = {}): Promise<ProbeResult> {
	const probe = await opened(input, options);
	try {
		return await probe.run();
	} finally {
		await probe.close();
	}
}

// Reads each path in targets.json and prints what happened to each, as JSON.
const attempts = `
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const { read = [], write = [] } = JSON.parse(readFileSync(new URL("./targets.json", import.meta.url), "utf8"));
const results = {};
for (const path of read) {
	try { readFileSync(path); results[path] = "read"; } catch (error) {
		if (error.code !== "EISDIR") { results[path] = error.code; continue; }
		try { readdirSync(path); results[path] = "read"; } catch (inner) { results[path] = inner.code; }
	}
}
for (const path of write) {
	try { writeFileSync(path, "probe\\n"); results[path] = "wrote"; } catch (error) { results[path] = error.code; }
}
console.log(JSON.stringify(results));
`;

function outcomes(result: ProbeResult): Record<string, string> {
	expect(result, result.output).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
	return JSON.parse(result.output) as Record<string, string>;
}

describe.skipIf(!availability.available && !required)(
	`a probe under sandbox-runtime${reason ? ` (${reason})` : ""}`,
	() => {
		it("cannot read ~/.ssh, ~/.config, or anything outside the worktree", { timeout: 60_000 }, async () => {
			const read = [
				join(homedir(), ".ssh"),
				join(homedir(), ".config"),
				join(outside, "secret.txt"),
				join(worktree, "escape"),
				outside,
				join(worktree, ".git", "config"),
				join(worktree, ".env"),
				"/etc/passwd",
				join(process.cwd(), "package.json"),
			];
			const results = outcomes(
				await probed({
					script: attempts,
					files: [
						{ path: "targets.json", text: JSON.stringify({ read: [...read, join(worktree, "AGENTS.md")] }) },
					],
				}),
			);
			expect(results[join(worktree, "AGENTS.md")]).toBe("read");
			for (const path of read) expect(results[path], path).not.toBe("read");
		});

		it.each(["[ab]", "star*", "what?", "{c,d}"])(
			"denies .env and .git in a worktree named %j, whose glob characters do not widen the deny",
			{ timeout: 60_000 },
			async (name) => {
				const named = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-glob-")));
				const tree = join(named, name);
				mkdirSync(join(tree, ".git"), { recursive: true });
				writeFileSync(join(tree, ".git", "config"), "[core]\n");
				writeFileSync(join(tree, ".env"), "TOKEN=x\n");
				writeFileSync(join(tree, "AGENTS.md"), "inside\n");
				try {
					const results = outcomes(
						await probed(
							{
								script: attempts,
								files: [
									{
										path: "targets.json",
										text: JSON.stringify({
											read: [join(tree, ".env"), join(tree, ".git", "config"), join(tree, "AGENTS.md")],
										}),
									},
								],
							},
							{ worktree: tree },
						),
					);
					expect(results[join(tree, "AGENTS.md")]).toBe("read");
					expect(results[join(tree, ".env")]).not.toBe("read");
					expect(results[join(tree, ".git", "config")]).not.toBe("read");
				} finally {
					rmSync(named, { recursive: true, force: true });
				}
			},
		);

		it("cannot write outside its scratch directory", { timeout: 60_000 }, async () => {
			const name = `melian-probe-${randomBytes(6).toString("hex")}`;
			const write = [join(worktree, name), join(outside, name), join(homedir(), name), join("/tmp/claude", name)];
			markers.push(...write);
			const own = "probe.mjs";
			const result = await probed({
				script: attempts.replace(
					"const results = {};",
					`const results = {}; write.push(new URL("./${own}", import.meta.url).pathname, (await import("node:os")).tmpdir() + "/scratch.txt");`,
				),
				files: [{ path: "targets.json", text: JSON.stringify({ write }) }],
			});
			const results = outcomes(result);
			const scratch = Object.fromEntries(
				Object.entries(results)
					.filter(([path]) => !write.includes(path))
					.map(([path, outcome]) => [path.split("/").at(-1), outcome]),
			);
			expect(Object.keys(scratch)).toEqual([own, "scratch.txt"]);
			expect(scratch[own]).not.toBe("wrote");
			expect(scratch["scratch.txt"]).toBe("wrote");
			// On Linux a directory the probe may not read is an empty tmpfs in the sandbox, so a write there succeeds and is
			// lost; what counts is that nothing reaches the host.
			expect(results[join(worktree, name)]).not.toBe("wrote");
			for (const path of write) expect(existsSync(path), path).toBe(false);
		});

		describe("with a server of the test's own", () => {
			let server: Server;
			let connections: number;

			beforeEach(async () => {
				connections = 0;
				server = createServer((socket) => {
					connections++;
					socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
				});
				await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			});

			afterEach(async () => {
				await new Promise((resolve) => server.close(resolve));
			});

			it("cannot open a network connection", { timeout: 60_000 }, async () => {
				const address = server.address();
				if (address === null || typeof address === "string") throw new Error("no port");
				const target = `127.0.0.1:${address.port}`;
				const script = `
import { connect } from "node:net";
import { request } from "node:http";
import { lookup } from "node:dns/promises";
const results = {};
const tcp = (host, port) => new Promise((resolve) => {
	const socket = connect(port, host);
	socket.once("connect", () => { socket.destroy(); resolve("connected"); });
	socket.once("error", (error) => resolve(error.code ?? "error"));
	setTimeout(() => { socket.destroy(); resolve("timeout"); }, 3000);
});
results.loopback = await tcp("127.0.0.1", ${address.port});
results.internet = await tcp("1.1.1.1", 443);
try { const response = await fetch("http://${target}/"); results.fetch = String(response.status); } catch (error) { results.fetch = error.cause?.code ?? "error"; }
try { await lookup("example.com"); results.dns = "resolved"; } catch (error) { results.dns = error.code ?? "error"; }
const proxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
results.proxy = proxy === undefined ? "none" : await new Promise((resolve) => {
	const via = new URL(proxy);
	const outgoing = request({ host: via.hostname, port: via.port, path: "http://${target}/", headers: { host: "${target}" } }, (response) => resolve(String(response.statusCode)));
	outgoing.once("error", (error) => resolve(error.code ?? "error"));
	setTimeout(() => resolve("timeout"), 3000);
	outgoing.end();
});
console.log(JSON.stringify(results));
process.exit(0);
`;
				const results = outcomes(await probed({ script }));
				expect(connections).toBe(0);
				expect(results.loopback).not.toBe("connected");
				expect(results.internet).not.toBe("connected");
				expect(results.fetch).not.toMatch(/^2/);
				expect(results.dns).not.toBe("resolved");
				expect(results.proxy).not.toMatch(/^2/);
			});
		});

		it("is ended at its time limit, with what it started", { timeout: 60_000 }, async () => {
			const tag = String(1_000_000 + Math.floor(Math.random() * 8_000_000));
			const script = `
import { spawn } from "node:child_process";
spawn("/bin/sleep", ["${tag}"], { stdio: "ignore" });
console.log("started");
setInterval(() => {}, 1000);
`;
			const began = Date.now();
			const result = await probed({ script }, { timeout: 2_000 });
			const elapsed = Date.now() - began;
			expect(result.timedOut).toBe(true);
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("started");
			expect(elapsed).toBeLessThan(15_000);
			const left = spawnSync("/bin/ps", ["-A", "-o", "args="], { encoding: "utf8" }).stdout;
			expect(left.split("\n").filter((line) => line.includes(`sleep ${tag}`))).toEqual([]);
		});

		it("is bounded when a reparented grandchild holds stdout open past the deadline", {
			timeout: 60_000,
		}, async () => {
			// The review's probe: `( exec /bin/sleep N ) &` leaves a grandchild holding stdout, so close never fires. The
			// deadline must stop what it recorded and, after the grace, abandon the streams and return timedOut.
			const script = `
import { spawn } from "node:child_process";
// Detached so it reparents away from the probe and keeps the inherited stdout open. It sleeps past the 2 s limit and
// the grace, then ends by itself, so the test never has to signal it.
spawn("/bin/sh", ["-c", "exec /bin/sleep 8"], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();
console.log("started");
`;
			const began = Date.now();
			{
				const result = await probed({ script }, { timeout: 2_000 });
				// On macOS the grandchild escapes and holds stdout, so the run ends at the deadline and grace, timed out. On
				// Linux bubblewrap's PID namespace dies with the probe and takes the grandchild with it, so the run ends
				// on its own. Either way it returns within the bound, which is the property under test.
				if (process.platform === "darwin") expect(result.timedOut).toBe(true);
				expect(result.output).toContain("started");
				expect(Date.now() - began).toBeLessThan(20_000);
			}
		});

		it("ends a CPU-bound runner whose host died mid-probe, by its CPU limit", { timeout: 300_000 }, async () => {
			// A probe that never yields never lets the runner's watchdog timer fire, so once the host is gone only a bound
			// outside the event loop ends it. The script spins to 40 CPU seconds and then stops itself, so a run without the
			// bound still ends; the runner's CPU limit is the timeout, grace and five seconds, 12 CPU seconds here.
			const host = spawn(
				process.execPath,
				[
					"--conditions=@melian-agent/source",
					join(import.meta.dirname, "fixtures", "probe-orphan.ts"),
					worktree,
					"40",
				],
				{ stdio: ["ignore", "pipe", "inherit"] },
			);
			try {
				const [line] = (await once(createInterface({ input: host.stdout! }), "line")) as [string];
				const runner = JSON.parse(line) as { pid: number; start: string };
				// The host is this test's own child, still unreaped, so its pid is still its own.
				if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
				let seconds = 0;
				for (;;) {
					const row = spawnSync("/bin/ps", ["-p", String(runner.pid), "-o", "lstart=,time="], {
						encoding: "utf8",
					});
					const match = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s*$/.exec(row.stdout.trim());
					if (match === null || match[1] !== runner.start) break;
					seconds = match[2]!.split(":").reduce((total, part) => total * 60 + Number(part), 0);
					if (seconds > 25) break;
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				expect(seconds).toBeLessThan(25);
			} finally {
				if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
			}
		});

		it("carries a binary fixture as bytes, not decoded as UTF-8", { timeout: 60_000 }, async () => {
			const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80, 0xc3, 0x28, 10]);
			const script = `
import { readFileSync } from "node:fs";
const got = readFileSync(new URL("./fixture.bin", import.meta.url));
console.log(JSON.stringify([...got]));
`;
			const result = await probed({ script, files: [{ path: "fixture.bin", bytes }] });
			expect(result).toMatchObject({ exitCode: 0, timedOut: false });
			expect(JSON.parse(result.output)).toEqual([...bytes]);
		});

		it("is cut at its output limit and ended", { timeout: 60_000 }, async () => {
			const script = `
const block = "x".repeat(65536);
// Each write waits for the last, so output keeps flowing: a synchronous loop queues its writes in memory, and the
// pipe can see no more than its first block.
const flood = () => process.stdout.write(block, flood);
flood();
`;
			const began = Date.now();
			const result = await probed({ script }, { outputLimit: 4096, timeout: 30_000 });
			expect(result.truncated).toBe(true);
			expect(result.timedOut).toBe(false);
			expect(result.output).toBe("x".repeat(4096));
			expect(Date.now() - began).toBeLessThan(15_000);
		});

		it("imports a module from the head's worktree and calls it", { timeout: 60_000 }, async () => {
			mkdirSync(join(worktree, "lib"));
			writeFileSync(join(worktree, "lib", "sum.mjs"), "export function sum(a, b) { return a + b; }\n");
			const script = `
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { sum } = await import(pathToFileURL(resolve("lib/sum.mjs")).href);
const { a, b } = JSON.parse(readFileSync(new URL("./fixture/input.json", import.meta.url), "utf8"));
console.log(sum(a, b));
`;
			const result = await probed({ script, files: [{ path: "fixture/input.json", text: '{"a":2,"b":3}' }] });
			expect(result).toEqual({ exitCode: 0, signal: null, output: "5\n", truncated: false, timedOut: false });
		});

		it("close() never follows a survivor's symlink swap into a host directory", { timeout: 120_000 }, async () => {
			// The review's attack: a double-forked survivor loops `rmdir d; symlink(<outside>, d)` on a fixed scratch
			// directory while close() cleans up. If close() chmodded or listed by path, it would turn the outside
			// directory and its subdirectory 0700. Across many runs the outside modes must not change.
			const outside = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-victim-")));
			mkdirSync(join(outside, "sub"));
			chmodSync(outside, 0o500);
			chmodSync(join(outside, "sub"), 0o500);
			const script = `
import { spawn } from "node:child_process";
// The fixed directories close() relaxes: the swap must race the very paths cleanup opens.
const targets = [process.env.TMPDIR, process.env.HOME];
// A detached survivor that keeps swapping a directory in the writable scratch for a symlink to the outside directory.
const swap = targets.map((t) => "rm -rf '" + t + "' 2>/dev/null; ln -s '${outside}' '" + t + "' 2>/dev/null; sleep 0; rm -f '" + t + "' 2>/dev/null; mkdir '" + t + "' 2>/dev/null").join("; ");
spawn("/bin/sh", ["-c", "end=$(( $(date +%s) + 30 )); while [ $(date +%s) -lt $end ]; do " + swap + "; done"], { stdio: "ignore", detached: true }).unref();
console.log("ready");
`;
			try {
				for (let run = 0; run < 8; run++) {
					const probe = await opened({ script });
					await probe.run();
					await probe.close();
				}
				expect(statSync(outside).mode & 0o777).toBe(0o500);
				expect(statSync(join(outside, "sub")).mode & 0o777).toBe(0o500);
			} finally {
				// The swapper ends by itself within 30 seconds; the test signals nothing.
				chmodSync(outside, 0o700);
				chmodSync(join(outside, "sub"), 0o700);
				rmSync(outside, { recursive: true, force: true });
			}
		});

		it("leaves the scratch and reports it when the probe makes a file immutable", { timeout: 60_000 }, async () => {
			// chflags uchg makes unlink fail with EPERM; the failure must not replace the probe's result, and close()
			// reports the leftover rather than throwing.
			if (process.platform !== "darwin") return;
			const probe = await opened({
				script: `import { writeFileSync } from "node:fs"; import { execFileSync } from "node:child_process"; const f = process.env.TMPDIR + "/locked"; writeFileSync(f, "x"); execFileSync("/usr/bin/chflags", ["uchg", f]); console.log("locked");`,
			});
			const result = await probe.run();
			expect(result).toMatchObject({ exitCode: 0, output: "locked\n" });
			const scratch = dirname(probe.policy.write[0]!);
			const cleanup = await probe.close();
			expect(cleanup).toMatchObject({ removed: false, leftover: scratch });
			expect(existsSync(scratch)).toBe(true);
			// The leftover is the test's to remove.
			spawnSync("/usr/bin/chflags", ["-R", "nouchg", scratch]);
			rmSync(scratch, { recursive: true, force: true });
		});

		it("does not receive the reviewer's JAVA_TOOL_OPTIONS", { timeout: 60_000 }, async () => {
			const canary = `CANARY_${randomBytes(8).toString("hex")}`;
			const before = process.env.JAVA_TOOL_OPTIONS;
			process.env.JAVA_TOOL_OPTIONS = `-Dsecret.token=${canary}`;
			try {
				const result = await probed({
					script: 'console.log(JSON.stringify({ seen: process.env.JAVA_TOOL_OPTIONS ?? "" }));',
				});
				expect(result).toMatchObject({ exitCode: 0, timedOut: false });
				// The value sandbox-runtime embeds in the wrapped command is dropped, so it reaches neither the probe's
				// environment nor the command text.
				expect(JSON.parse(result.output).seen).not.toContain(canary);
				expect(result.output).not.toContain(canary);
			} finally {
				if (before === undefined) delete process.env.JAVA_TOOL_OPTIONS;
				else process.env.JAVA_TOOL_OPTIONS = before;
			}
		});

		it("cannot connect to a unix socket in the worktree", { timeout: 60_000 }, async () => {
			// A host service a probe could reach over a pathname socket in the readable worktree; on Linux the seccomp
			// helper blocks the socket() call, on macOS the socket is not in allowUnixSockets. The server records any
			// connection; the probe must make none.
			let connections = 0;
			const socketPath = join(worktree, "service.sock");
			const server = createServer((socket) => {
				connections++;
				socket.end();
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			try {
				const script = `
import { connect } from "node:net";
const outcome = await new Promise((resolve) => {
	const socket = connect(${JSON.stringify(socketPath)});
	socket.once("connect", () => { socket.destroy(); resolve("connected"); });
	socket.once("error", (error) => resolve(error.code ?? "error"));
	setTimeout(() => { socket.destroy(); resolve("timeout"); }, 3000);
});
console.log(JSON.stringify({ outcome }));
process.exit(0);
`;
				const result = await probed({ script });
				expect(result).toMatchObject({ exitCode: 0, timedOut: false });
				expect(JSON.parse(result.output).outcome).not.toBe("connected");
				expect(connections).toBe(0);
			} finally {
				await new Promise((resolve) => server.close(resolve));
			}
		});
	},
);
