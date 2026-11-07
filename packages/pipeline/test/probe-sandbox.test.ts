import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
});

afterEach(() => {
	for (const marker of markers) rmSync(marker, { force: true });
	rmSync(worktree, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

async function probed(input: ProbeInput, options: Partial<ProbeOptions> = {}): Promise<ProbeResult> {
	const probe = await Probe.open(input, {
		worktree,
		writer: { trusted: true, by: "writer" },
		trustWriters: true,
		...options,
	});
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

		it("is cut at its output limit and ended", { timeout: 60_000 }, async () => {
			const script = `
const block = "x".repeat(65536);
for (;;) process.stdout.write(block);
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
	},
);
