import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeInstallation, Sandbox, type SandboxPaths } from "../src/sandbox.ts";

const run = promisify(execFile);

// What a hostile test would try: read a credential, call out, write beside the run, and write inside it.
const probe = `
const fs = require("node:fs");
const net = require("node:net");
const [home, scratch, outside, port] = process.argv.slice(2);
const result = {};
const attempt = (name, body) => { try { body(); result[name] = "ok"; } catch (error) { result[name] = "denied"; } };
attempt("readHome", () => fs.readFileSync(home + "/auth.json"));
attempt("writeScratch", () => fs.writeFileSync(scratch + "/written", "1"));
attempt("writeOutside", () => fs.writeFileSync(outside + "/written", "1"));
const socket = net.connect(Number(port), "127.0.0.1");
socket.on("connect", () => { result.connect = "ok"; socket.destroy(); console.log(JSON.stringify(result)); });
socket.on("error", () => { result.connect = "denied"; console.log(JSON.stringify(result)); });
`;

let base: string;
let server: Server;
let port: number;
let connections: number;

beforeEach(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "melian-sandbox-")));
	for (const directory of ["home", "outside", "scratch/tree", "installs"])
		mkdirSync(join(base, directory), { recursive: true });
	writeFileSync(join(base, "home/auth.json"), "{}");
	writeFileSync(join(base, "scratch/tree/probe.js"), probe);
	connections = 0;
	server = createServer((socket) => {
		connections++;
		socket.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as { port: number }).port;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
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
	const inner = `${JSON.stringify(process.execPath)} probe.js ${base}/home ${where.scratch} ${base}/outside ${port}`;
	const { stdout } = await run("/bin/bash", ["-c", sandbox.command(inner, where, file)], { timeout: 30_000 });
	return JSON.parse(stdout) as Record<string, string>;
}

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
			writeScratch: "ok",
			writeOutside: "denied",
			connect: "denied",
		});
		expect(readFileSync(join(base, "scratch/written"), "utf8")).toBe("1");
		expect(connections).toBe(0);
	});
});

describe.skipIf(Sandbox.detect("linux") === undefined)("bubblewrap", { timeout: 60_000 }, () => {
	it("denies the reviewer's home and the network, and allows writes under scratch only", async () => {
		const sandbox = Sandbox.detect("linux") as Sandbox;
		expect(await probed(sandbox)).toEqual({
			readHome: "denied",
			writeScratch: "ok",
			writeOutside: "denied",
			connect: "denied",
		});
		expect(readFileSync(join(base, "scratch/written"), "utf8")).toBe("1");
		expect(connections).toBe(0);
	});
});
