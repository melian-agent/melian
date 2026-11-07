import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ProcessControl, ProcessEntry } from "../src/mutation-process.ts";
import { ProbeProcess } from "../src/probe-process.ts";

// The probe's process tree on a fake process table and a fake kill: nothing here signals a real process.

class FakeTable implements ProcessControl {
	entries: ProcessEntry[];
	kills: [number, string][] = [];
	broken = false;
	constructor(entries: ProcessEntry[]) {
		this.entries = entries;
	}
	list(): ProcessEntry[] {
		if (this.broken) throw new Error("ps failed");
		return this.entries;
	}
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
		this.kills.push([pid, signal]);
		this.entries = this.entries.filter((entry) => entry.pid !== pid);
	}
}

function child(pid: number | undefined): ChildProcess & EventEmitter & { kills: string[] } {
	const kills: string[] = [];
	const fake = Object.assign(new EventEmitter(), {
		pid,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null,
		kills,
		kill: (signal: string) => {
			kills.push(signal);
			return true;
		},
	});
	fake.once("exit", (code: number | null) => {
		fake.exitCode = code;
	});
	return fake as never;
}

function started(table: FakeTable, root = child(100), output: (chunk: Buffer) => void = () => {}) {
	const process = ProbeProcess.start(["/bin/true"], {
		cwd: "/",
		env: {},
		output,
		control: table,
		interval: 1_000_000,
		spawner: () => root,
		sleep: async () => {},
	});
	return { process, root };
}

const entry = (pid: number, ppid: number, start = `s${pid}`): ProcessEntry => ({ pid, ppid, start });

describe("ProbeProcess", () => {
	it("records the command and every process descending from it, and ends only those", async () => {
		const table = new FakeTable([
			entry(1, 0),
			entry(process.pid, 1),
			entry(100, process.pid),
			entry(101, 100),
			entry(500, 1),
		]);
		const { process: probe } = started(table);
		table.entries.push(entry(102, 101));
		await probe.stop();
		expect(probe.recorded).toEqual([
			{ pid: 100, start: "s100" },
			{ pid: 101, start: "s101" },
			{ pid: 102, start: "s102" },
		]);
		expect(table.kills).toEqual([
			[100, "SIGTERM"],
			[101, "SIGTERM"],
			[102, "SIGTERM"],
		]);
		expect(table.entries.map((each) => each.pid)).toEqual([1, process.pid, 500]);
	});

	it("keeps a process that left the tree after it was seen, and ends it", async () => {
		const table = new FakeTable([entry(100, 1), entry(101, 100)]);
		const { process: probe } = started(table);
		table.entries = [entry(101, 1), entry(103, 101)];
		await probe.stop();
		expect(table.kills).toEqual([
			[101, "SIGTERM"],
			[103, "SIGTERM"],
		]);
	});

	it("never signals a recorded pid that another process now holds", async () => {
		const table = new FakeTable([entry(100, 1), entry(101, 100)]);
		const { process: probe } = started(table);
		table.entries = [entry(101, 1, "later"), entry(104, 101, "later")];
		await probe.stop();
		expect(probe.recorded).toEqual([
			{ pid: 100, start: "s100" },
			{ pid: 101, start: "s101" },
		]);
		expect(table.kills).toEqual([]);
	});

	it("ends its own command, and what it recorded, when the table can no longer be read", async () => {
		const table = new FakeTable([entry(100, 1)]);
		const { process: probe, root } = started(table);
		table.broken = true;
		await expect(probe.stop()).rejects.toThrow("ps failed");
		expect(root.kills).toEqual(["SIGKILL"]);
		table.broken = false;
		await probe.stop();
		expect(table.kills).toEqual([[100, "SIGTERM"]]);
	});

	it("passes both streams on and reports how the command ended", async () => {
		const chunks: string[] = [];
		const table = new FakeTable([]);
		const { process: probe, root } = started(table, child(100), (chunk) => chunks.push(chunk.toString()));
		(root.stdout as PassThrough).write("out");
		(root.stderr as PassThrough).write("err");
		await new Promise((resolve) => setImmediate(resolve));
		root.emit("exit", 3, null);
		expect(await probe.wait()).toEqual({ code: 3, signal: null });
		expect(chunks).toEqual(["out", "err"]);
		await probe.stop();
		expect(root.kills).toEqual([]);
	});

	it("reads a command that never started as exit 127, and records nothing", async () => {
		const table = new FakeTable([entry(100, 1)]);
		const { process: probe, root } = started(table, child(undefined));
		root.emit("error", new Error("ENOENT"));
		expect(await probe.wait()).toEqual({ code: 127, signal: null });
		await probe.stop();
		expect(probe.recorded).toEqual([]);
		expect(table.kills).toEqual([]);
	});

	it("refuses an empty command", () => {
		expect(() => ProbeProcess.start([], { cwd: "/", env: {}, output: () => {} })).toThrow("a probe needs a command");
	});
});
