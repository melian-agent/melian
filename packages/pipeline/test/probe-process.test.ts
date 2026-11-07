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

// A real child emits "close" after "exit" once its stdio has ended; the probe resolves on "close".
function ended(root: EventEmitter, code: number | null, signal: NodeJS.Signals | null): void {
	root.emit("exit", code, signal);
	root.emit("close", code, signal);
}

function started(
	table: FakeTable,
	root = child(100),
	output: (chunk: Buffer) => void = () => {},
	more: Partial<Parameters<typeof ProbeProcess.start>[1]> = {},
) {
	const process = ProbeProcess.start(["/bin/true"], {
		cwd: "/",
		env: {},
		output,
		control: table,
		interval: 1_000_000,
		spawner: () => root,
		sleep: async () => {},
		...more,
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
		ended(root, 3, null);
		expect(await probe.wait()).toEqual({ code: 3, signal: null, timedOut: false });
		expect(chunks).toEqual(["out", "err"]);
		await probe.stop();
		expect(root.kills).toEqual([]);
	});

	it("resolves on close, not on exit, so output between the two is captured", async () => {
		const chunks: string[] = [];
		const table = new FakeTable([]);
		const { process: probe, root } = started(table, child(100), (chunk) => chunks.push(chunk.toString()));
		let settled = false;
		void probe.wait().then(() => {
			settled = true;
		});
		root.emit("exit", 0, null);
		// A real stream can still deliver buffered data after exit, before close.
		(root.stdout as PassThrough).write("late");
		await new Promise((resolve) => setImmediate(resolve));
		// wait() has not resolved on exit, so the result it builds will include the late output.
		expect(settled).toBe(false);
		root.emit("close", 0, null);
		expect(await probe.wait()).toEqual({ code: 0, signal: null, timedOut: false });
		expect(chunks).toEqual(["late"]);
		await probe.stop();
	});

	it("reads a command that never started as exit 127, and records nothing", async () => {
		const table = new FakeTable([entry(100, 1)]);
		const { process: probe, root } = started(table, child(undefined));
		root.emit("error", new Error("ENOENT"));
		expect(await probe.wait()).toEqual({ code: 127, signal: null, timedOut: false });
		await probe.stop();
		expect(probe.recorded).toEqual([]);
		expect(table.kills).toEqual([]);
	});

	it("refuses an empty command", () => {
		expect(() => ProbeProcess.start([], { cwd: "/", env: {}, output: () => {} })).toThrow("a probe needs a command");
	});

	it("bounds the run at the deadline and resolves timedOut when a stream never closes", async () => {
		// The child never emits close, as a reparented grandchild holding a stream would prevent. The deadline must stop
		// the recorded tree and, after the grace, abandon the streams and resolve rather than wait forever.
		const table = new FakeTable([entry(100, 1)]);
		const { process: probe } = started(table, child(100), () => {}, { timeoutMs: 10, graceMs: 5 });
		const exit = await probe.wait();
		expect(exit.timedOut).toBe(true);
		expect(table.kills).toEqual([[100, "SIGTERM"]]);
	});

	it("resolves not-timed-out when the deadline's stop lets the child close within the grace", async () => {
		const table = new FakeTable([entry(100, 1)]);
		let sleepResolve: (() => void) | undefined;
		const { process: probe, root } = started(table, child(100), () => {}, {
			timeoutMs: 1,
			sleep: (ms) => (ms === 0 ? Promise.resolve() : new Promise<void>((r) => (sleepResolve = r))),
		});
		await new Promise((r) => setTimeout(r, 15));
		ended(root, null, "SIGKILL");
		expect(await probe.wait()).toEqual({ code: null, signal: "SIGKILL", timedOut: true });
		sleepResolve?.();
	});

	it("settles with the failure recorded when the process table cannot be read at the deadline", async () => {
		// Without a handler, the deadline's fire-and-forget stop would reject unhandled and could end the process.
		const table = new FakeTable([entry(100, 1)]);
		const { process: probe, root } = started(table, child(100), () => {}, { timeoutMs: 10, graceMs: 5 });
		table.broken = true;
		const exit = await probe.wait();
		expect(exit).toEqual({ code: null, signal: null, timedOut: true, error: "ps failed" });
		expect(root.kills).toEqual(["SIGKILL"]);
	});

	it("scans the process table on its interval, finding a descendant that appears later", async () => {
		const table = new FakeTable([entry(100, 1)]);
		const { process: probe } = started(table, child(100), () => {}, { interval: 5 });
		table.entries.push(entry(200, 100));
		await new Promise((r) => setTimeout(r, 20));
		expect(probe.recorded.map((p) => p.pid)).toEqual([100, 200]);
		await probe.stop();
	});
});
