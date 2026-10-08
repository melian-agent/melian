import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundContext, createNodeExecutionEnv } from "../src/harness.ts";
import {
	MutationTree,
	type ProcessEntry,
	ProcessTable,
	parseProcesses,
	type RecordedProcess,
	type SupervisorHost,
	supervise,
	supervisorSource,
	terminateRecorded,
} from "../src/mutation-process.ts";

// Every test here drives the code on fakes. Nothing in this file starts a process or sends a signal; a kill is a function
// that records its arguments. The real-process test is in mutation-process-real.test.ts.

const at = (pid: number, ppid: number, start = `s${pid}`): ProcessEntry => ({ pid, ppid, start });

class FakeProcesses {
	table: ProcessEntry[];
	readonly kills: [number, string][] = [];
	readonly dies: Set<string>;
	constructor(table: ProcessEntry[], dies: string[] = ["SIGTERM", "SIGKILL"]) {
		this.table = table;
		this.dies = new Set(dies);
	}
	list(): ProcessEntry[] {
		return this.table.map((entry) => ({ ...entry }));
	}
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
		this.kills.push([pid, signal]);
		if (this.dies.has(signal)) this.table = this.table.filter((entry) => entry.pid !== pid);
	}
}

const recorded = (...entries: ProcessEntry[]): RecordedProcess[] => entries.map(({ pid, start }) => ({ pid, start }));

describe("terminateRecorded", () => {
	it("sends SIGTERM to each recorded process that is still the one recorded, and nothing else", async () => {
		const fake = new FakeProcesses([at(10, 1), at(11, 10), at(12, 1)]);
		await terminateRecorded(recorded(at(10, 1), at(11, 10)), fake, async () => {}, []);
		expect(fake.kills).toEqual([
			[10, "SIGTERM"],
			[11, "SIGTERM"],
		]);
	});

	it("leaves a pid alone when its start time differs, because the pid was reused", async () => {
		const fake = new FakeProcesses([at(10, 1, "later")]);
		await terminateRecorded(recorded(at(10, 1, "earlier")), fake, async () => {}, []);
		expect(fake.kills).toEqual([]);
	});

	it("leaves a recorded pid alone when no such process runs", async () => {
		const fake = new FakeProcesses([at(99, 1)]);
		await terminateRecorded(recorded(at(10, 1)), fake, async () => {}, []);
		expect(fake.kills).toEqual([]);
	});

	it.each([
		["one", 1],
		["zero", 0],
		["minus one", -1],
		["a group id", -10],
		["a fraction", 1.5],
		["not a number", Number.NaN],
		["past the safe integers", Number.MAX_SAFE_INTEGER + 2],
	])("never signals pid %s, even when the table lists it with the recorded start", async (_name, pid) => {
		const fake = new FakeProcesses([at(pid, 1)]);
		await terminateRecorded(recorded(at(pid, 1)), fake, async () => {}, []);
		expect(fake.kills).toEqual([]);
	});

	it("signals pid 2, the smallest pid it may", async () => {
		const fake = new FakeProcesses([at(2, 1)]);
		await terminateRecorded(recorded(at(2, 1)), fake, async () => {}, []);
		expect(fake.kills).toEqual([[2, "SIGTERM"]]);
	});

	it("never signals a pid it was told to keep", async () => {
		const fake = new FakeProcesses([at(10, 1), at(11, 1)]);
		await terminateRecorded(recorded(at(10, 1), at(11, 1)), fake, async () => {}, [10]);
		expect(fake.kills).toEqual([[11, "SIGTERM"]]);
	});

	it("sends SIGKILL to a process that outlives the grace, after exactly 20 waits of 50 ms", async () => {
		const fake = new FakeProcesses([at(10, 1)], ["SIGKILL"]);
		const sleeps: number[] = [];
		await terminateRecorded(recorded(at(10, 1)), fake, async (milliseconds) => void sleeps.push(milliseconds), []);
		expect(sleeps).toEqual(Array(20).fill(50));
		expect(fake.kills).toEqual([
			[10, "SIGTERM"],
			[10, "SIGKILL"],
		]);
	});

	it("sends no SIGKILL to a process that exits on its twentieth wait", async () => {
		const fake = new FakeProcesses([at(10, 1)], []);
		let waits = 0;
		await terminateRecorded(
			recorded(at(10, 1)),
			fake,
			async () => {
				if (++waits === 20) fake.table = [];
			},
			[],
		);
		expect(waits).toBe(20);
		expect(fake.kills).toEqual([[10, "SIGTERM"]]);
	});

	it("stops waiting as soon as everything has exited", async () => {
		const fake = new FakeProcesses([at(10, 1)], []);
		let waits = 0;
		await terminateRecorded(
			recorded(at(10, 1)),
			fake,
			async () => {
				if (++waits === 3) fake.table = [];
			},
			[],
		);
		expect(waits).toBe(3);
	});

	it("does not send SIGKILL to a pid that was reused during the grace", async () => {
		const fake = new FakeProcesses([at(10, 1)], []);
		await terminateRecorded(
			recorded(at(10, 1)),
			fake,
			async () => {
				fake.table = [at(10, 1, "reused")];
			},
			[],
		);
		expect(fake.kills).toEqual([[10, "SIGTERM"]]);
	});
});

describe("parseProcesses", () => {
	it("reads pid, parent and start, collapsing the padding in the start time", () => {
		expect(parseProcesses("  101     1 Thu Oct  8 10:00:00 2026\n 102   101 Thu Oct 18 10:00:01 2026\n")).toEqual([
			{ pid: 101, ppid: 1, start: "Thu Oct 8 10:00:00 2026" },
			{ pid: 102, ppid: 101, start: "Thu Oct 18 10:00:01 2026" },
		]);
	});

	it("skips a line that is not a process row", () => {
		expect(parseProcesses("garbage\n\n 5 1 Mon Jan  1 00:00:00 2026")).toEqual([
			{ pid: 5, ppid: 1, start: "Mon Jan 1 00:00:00 2026" },
		]);
	});
});

describe("ProcessTable.kill", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([1, 1.5, Number.NaN])("refuses pid %s before it reaches process.kill", (pid) => {
		const send = vi.spyOn(process, "kill").mockImplementation(() => true);
		expect(() => new ProcessTable().kill(pid, "SIGTERM")).toThrow("refusing to signal");
		expect(send).not.toHaveBeenCalled();
	});

	it("passes a valid pid and signal to process.kill", () => {
		const send = vi.spyOn(process, "kill").mockImplementation(() => true);
		new ProcessTable().kill(2, "SIGKILL");
		expect(send).toHaveBeenCalledExactlyOnceWith(2, "SIGKILL");
	});

	it("treats a pid that is already gone as done, and reports any other failure", () => {
		const failing = (code: string) =>
			vi.spyOn(process, "kill").mockImplementation(() => {
				throw Object.assign(new Error(code), { code });
			});
		failing("ESRCH");
		expect(() => new ProcessTable().kill(2, "SIGTERM")).not.toThrow();
		vi.restoreAllMocks();
		failing("EPERM");
		expect(() => new ProcessTable().kill(2, "SIGTERM")).toThrow("EPERM");
	});
});

describe("supervise", () => {
	const controller = { pid: 500, start: "ctl" };
	let table: ProcessEntry[];
	let files: Map<string, string>;
	let order: string[];
	let ticks: (() => void)[];
	let exited: (code: number) => void;
	let terminated: () => void;
	let terminatedWith: RecordedProcess[][];
	let exits: number[];
	let host: SupervisorHost;

	beforeEach(() => {
		table = [at(500, 1, "ctl"), at(200, 1, "sup"), at(300, 200)];
		files = new Map();
		order = [];
		ticks = [];
		exited = () => {};
		terminated = () => {};
		terminatedWith = [];
		exits = [];
		host = {
			pid: 200,
			list: () => table.map((entry) => ({ ...entry })),
			spawn: () => 300,
			exited: (callback) => {
				exited = callback;
			},
			terminated: (callback) => {
				terminated = callback;
			},
			write: (name, text) => {
				files.set(name, text);
				order.push(`write ${name}`);
			},
			every: (milliseconds, callback) => {
				expect(milliseconds).toBe(100);
				ticks.push(callback);
			},
			terminate: async (records) => {
				order.push("terminate");
				terminatedWith.push([...records]);
				await Promise.resolve();
			},
			exit: (code) => {
				order.push("exit");
				exits.push(code);
			},
		};
	});

	const start = () => supervise({ controller, interval: 100 }, host);
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	it("reports itself and the command it started as ready", () => {
		start();
		expect(JSON.parse(files.get("ready.json")!)).toEqual({
			supervisor: { pid: 200, start: "sup" },
			root: { pid: 300, start: "s300" },
		});
	});

	it("records the command's descendants to any depth, and no other process", () => {
		table.push(at(301, 300), at(302, 301), at(999, 1));
		start();
		const seen = JSON.parse(files.get("tree.json")!) as RecordedProcess[];
		expect(seen.map((entry) => entry.pid).sort()).toEqual([300, 301, 302]);
	});

	it("rewrites the tree only when it grows, and keeps a process whose parent has gone", async () => {
		start();
		expect(files.get("tree.json")).toBe(JSON.stringify([{ pid: 300, start: "s300" }]));
		const writes = () => order.filter((entry) => entry === "write tree.json").length;
		ticks[0]!();
		expect(writes()).toBe(1);
		table.push(at(301, 300));
		ticks[0]!();
		expect(writes()).toBe(2);
		table = table.map((entry) => (entry.pid === 301 ? { ...entry, ppid: 1 } : entry));
		table = table.filter((entry) => entry.pid !== 300);
		ticks[0]!();
		expect(writes()).toBe(2);
		table = table.filter((entry) => entry.pid !== 500);
		ticks[0]!();
		await settle();
		expect(terminatedWith[0]!.map((entry) => entry.pid).sort()).toEqual([300, 301]);
	});

	it("ends the tree and exits 1 when its controller disappears", async () => {
		start();
		table = table.filter((entry) => entry.pid !== 500);
		ticks[0]!();
		await settle();
		expect(terminatedWith).toHaveLength(1);
		expect(files.get("done")).toBe("1");
		expect(exits).toEqual([1]);
	});

	it("treats a controller pid with another start time as a different process", async () => {
		start();
		table = table.map((entry) => (entry.pid === 500 ? { ...entry, start: "reused" } : entry));
		ticks[0]!();
		await settle();
		expect(exits).toEqual([1]);
	});

	it("keeps running while its controller lives", async () => {
		start();
		ticks[0]!();
		ticks[0]!();
		await settle();
		expect(terminatedWith).toEqual([]);
		expect(exits).toEqual([]);
	});

	it("ends the tree and reports the command's exit code when the command exits", async () => {
		start();
		exited(3);
		await settle();
		expect(terminatedWith).toHaveLength(1);
		expect(files.get("done")).toBe("3");
		expect(exits).toEqual([3]);
	});

	it("ends the tree and exits 1 when told to terminate", async () => {
		start();
		terminated();
		await settle();
		expect(terminatedWith).toHaveLength(1);
		expect(files.get("done")).toBe("1");
		expect(exits).toEqual([1]);
	});

	it("writes done and exits only after the tree is terminated", async () => {
		start();
		exited(0);
		await settle();
		expect(order.slice(-3)).toEqual(["terminate", "write done", "exit"]);
	});

	it("ends once, whatever happens next", async () => {
		start();
		exited(3);
		terminated();
		table = table.filter((entry) => entry.pid !== 500);
		ticks[0]!();
		exited(4);
		await settle();
		expect(terminatedWith).toHaveLength(1);
		expect(exits).toEqual([3]);
	});

	it("does not poll after it has ended", async () => {
		start();
		exited(0);
		await settle();
		const before = order.length;
		table.push(at(301, 300));
		ticks[0]!();
		expect(order).toHaveLength(before);
	});

	it("gives up with exit 1 and no ready file when the command is not in the process table", async () => {
		table = table.filter((entry) => entry.pid !== 300);
		start();
		await settle();
		expect(files.has("ready.json")).toBe(false);
		expect(exits).toEqual([1]);
	});

	it("gives up with exit 1 and no ready file when it cannot find itself", async () => {
		table = table.filter((entry) => entry.pid !== 200);
		start();
		await settle();
		expect(files.has("ready.json")).toBe(false);
		expect(exits).toEqual([1]);
	});
});

describe("MutationTree", () => {
	let control: string;
	beforeEach(() => {
		control = mkdtempSync(join(tmpdir(), "melian-tree-test-"));
	});
	afterEach(() => rmSync(control, { recursive: true, force: true }));

	const record = () => ({ control, supervisor: { pid: 20, start: "s20" }, root: { pid: 21, start: "s21" } });
	const env = () => createNodeExecutionEnv(control);

	it("ends the supervisor, the root and every process the supervisor recorded, then removes the control directory", async () => {
		writeFileSync(
			join(control, "tree.json"),
			JSON.stringify([
				{ pid: 21, start: "s21" },
				{ pid: 22, start: "s22" },
			]),
		);
		const fake = new FakeProcesses([at(20, 1), at(21, 20), at(22, 21), at(23, 1)]);
		const tree = await MutationTree.read(env(), record(), backgroundContext);
		await tree.terminate(env(), fake, async () => {});
		expect(fake.kills.map(([pid]) => pid)).toEqual([20, 21, 22]);
		expect(() => readFileSync(join(control, "tree.json"))).toThrow();
	});

	it("falls back to the record's own processes when the tree file is missing, unreadable JSON, or malformed", async () => {
		for (const content of [
			undefined,
			"{not json",
			'{"pid":1}',
			'[{"pid":"x","start":1},null,{"pid":23,"start":"s23"}]',
		]) {
			if (content !== undefined) writeFileSync(join(control, "tree.json"), content);
			const tree = await MutationTree.read(env(), record(), backgroundContext);
			const wanted = content?.includes("s23") ? [20, 21, 23] : [20, 21];
			expect(tree.processes.map((entry) => entry.pid)).toEqual(wanted);
		}
	});

	it("never signals its own process, even if recorded", async () => {
		mkdirSync(control, { recursive: true });
		const tree = await MutationTree.read(
			env(),
			{ control, supervisor: { pid: process.pid, start: "me" }, root: { pid: 21, start: "s21" } },
			backgroundContext,
		);
		const fake = new FakeProcesses([at(process.pid, 1, "me"), at(21, 1)]);
		await tree.terminate(env(), fake, async () => {});
		expect(fake.kills).toEqual([[21, "SIGTERM"]]);
	});
});

describe("supervisorSource", () => {
	it("is a script Node accepts, with the command and control directory as data", () => {
		const directory = mkdtempSync(join(tmpdir(), "melian-source-test-"));
		try {
			const script = join(directory, "supervisor.mjs");
			writeFileSync(
				script,
				supervisorSource(
					{ controller: { pid: 7, start: "a b" }, interval: 100 },
					"echo 'it''s'; exit 2",
					directory,
				),
			);
			const checked = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
			expect(checked.stderr).toBe("");
			expect(checked.status).toBe(0);
			expect(readFileSync(script, "utf8")).toContain(JSON.stringify("echo 'it''s'; exit 2"));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
