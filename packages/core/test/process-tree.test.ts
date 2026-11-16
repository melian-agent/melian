import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ProcessControl, type ProcessEntry, ProcessTable, stopTree } from "../src/process-tree.ts";

// stopTree on a fake process table and a fake kill: nothing here signals a real process but a stand-in for ps a test
// started. One test reads the real table.

class FakeTable implements ProcessControl {
	entries: ProcessEntry[];
	kills: [number, string][] = [];
	reads = 0;
	broken = false;
	// Pids that ignore SIGTERM, as a process that handles it does.
	stubborn: number[] = [];
	constructor(entries: ProcessEntry[]) {
		this.entries = entries;
	}
	list(): ProcessEntry[] {
		if (this.broken) throw new Error("ps failed");
		this.reads++;
		return this.entries;
	}
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
		this.kills.push([pid, signal]);
		if (signal === "SIGKILL" || !this.stubborn.includes(pid))
			this.entries = this.entries.filter((entry) => entry.pid !== pid);
	}
}

const entry = (pid: number, ppid: number, start = `s${pid}`): ProcessEntry => ({ pid, ppid, start });
const self = process.pid;
const instant = async () => {};

describe("stopTree", () => {
	it("stops the root and every process below it, and nothing beside them", async () => {
		const table = new FakeTable([
			entry(1, 0),
			entry(self, 1),
			entry(100, self),
			entry(101, 100),
			entry(102, 101),
			entry(103, 100),
			entry(200, 1),
			entry(201, 200),
		]);
		await stopTree(100, table, instant);
		expect(table.kills).toEqual([
			[100, "SIGTERM"],
			[101, "SIGTERM"],
			[103, "SIGTERM"],
			[102, "SIGTERM"],
		]);
	});

	it("records the whole tree before it signals any of it", async () => {
		// A real kill re-parents the root's children to pid 1 at once; this table does the same.
		const table = new FakeTable([entry(1, 0), entry(self, 1), entry(100, self), entry(101, 100)]);
		const kill = table.kill.bind(table);
		table.kill = (pid, signal) => {
			kill(pid, signal);
			table.entries = table.entries.map((each) => (each.ppid === pid ? { ...each, ppid: 1 } : each));
		};
		await stopTree(100, table, instant);
		expect(table.kills).toEqual([
			[100, "SIGTERM"],
			[101, "SIGTERM"],
		]);
	});

	it("reads the table and records the tree before it returns, with nothing awaited between", () => {
		const table = new FakeTable([entry(1, 0), entry(self, 1), entry(100, self), entry(101, 100)]);
		const stopping = stopTree(100, table, instant);
		// The first signal follows the read in the same turn, so the tree was recorded from that one read.
		expect(table.reads).toBeGreaterThanOrEqual(1);
		expect(table.kills[0]).toEqual([100, "SIGTERM"]);
		return stopping;
	});

	it("never signals this process, though the table shows it below the root", async () => {
		const table = new FakeTable([entry(1, 0), entry(100, 1), entry(self, 100), entry(101, 100)]);
		await stopTree(100, table, instant);
		expect(table.kills).toEqual([[101, "SIGTERM"]]);
	});

	it("never signals an ancestor of this process, though the table shows one below the root", async () => {
		const table = new FakeTable([entry(1, 0), entry(100, 1), entry(300, 100), entry(self, 300), entry(101, 100)]);
		await stopTree(100, table, instant);
		expect(table.kills).toEqual([[101, "SIGTERM"]]);
	});

	it("ends when the table shows a process as its own parent, as macOS's ps shows pid 0", async () => {
		const table = new FakeTable([entry(0, 0), entry(1, 0), entry(self, 1), entry(100, self), entry(101, 100)]);
		await stopTree(100, table, instant);
		expect(table.kills).toEqual([
			[100, "SIGTERM"],
			[101, "SIGTERM"],
		]);
	});

	it.each([0, 1, -1, 2.5])("signals nothing, and reads no table, for a root of %s", async (root) => {
		const table = new FakeTable([entry(1, 0), entry(self, 1), entry(500, 1), entry(501, 0)]);
		expect(stopTree(root, table, instant)).toBeUndefined();
		expect(table).toMatchObject({ kills: [], reads: 0 });
	});

	it("never signals pid 0, 1 or a negative pid the table shows below the root", async () => {
		// This process's parent is outside the table, so the fake pid 1 below the root is no ancestor of it.
		const table = new FakeTable([entry(self, 7), entry(100, self), entry(0, 100), entry(1, 100), entry(-5, 100)]);
		await stopTree(100, table, instant);
		expect(table.kills).toEqual([[100, "SIGTERM"]]);
	});

	it("never signals a pid whose start time no longer matches the one recorded", async () => {
		const table = new FakeTable([entry(1, 0), entry(self, 1), entry(100, self), entry(101, 100)]);
		const list = table.list.bind(table);
		table.list = () => {
			const entries = list();
			// After the read that records the tree, pid 101 passes to a process that is nobody's to end.
			if (table.reads > 1) table.entries = entries.map((each) => (each.pid === 101 ? entry(101, 1, "later") : each));
			return table.entries;
		};
		await stopTree(100, table, instant);
		expect(table.kills).toEqual([[100, "SIGTERM"]]);
	});

	it("signals a recorded process whose start and command both still match", async () => {
		const table = new FakeTable([
			entry(1, 0),
			entry(self, 1),
			{ ...entry(100, self), command: "git" },
			{ ...entry(101, 100), command: "ssh" },
		]);
		await stopTree(100, table, instant);
		expect(table.kills).toEqual([
			[100, "SIGTERM"],
			[101, "SIGTERM"],
		]);
	});

	it("never signals a pid whose start second still matches but whose command does not", async () => {
		const table = new FakeTable([
			entry(1, 0),
			entry(self, 1),
			{ ...entry(100, self), command: "git" },
			{ ...entry(101, 100), command: "ssh" },
		]);
		const list = table.list.bind(table);
		table.list = () => {
			const entries = list();
			// After the read that records the tree, pid 101 passes to another program started in the same second.
			if (table.reads > 1)
				table.entries = entries.map((each) => (each.pid === 101 ? { ...entry(101, 1), command: "vim" } : each));
			return table.entries;
		};
		await stopTree(100, table, instant);
		expect(table.kills).toEqual([[100, "SIGTERM"]]);
	});

	it("signals nothing when the process table cannot be read", () => {
		const table = new FakeTable([entry(1, 0), entry(self, 1), entry(100, self)]);
		table.broken = true;
		expect(stopTree(100, table, instant)).toBeUndefined();
		expect(table.kills).toEqual([]);
	});

	it("signals nothing, and says it could not stop the tree, when the root is no longer in the table", () => {
		// The root has exited and been reaped, so the child it left now reads as pid 1's.
		const table = new FakeTable([entry(1, 0), entry(self, 1), entry(101, 1)]);
		expect(stopTree(100, table, instant)).toBeUndefined();
		expect(table.kills).toEqual([]);
	});

	it("signals nothing, and says it could not stop the tree, when the root is a zombie", () => {
		// A zombie has exited, so its children have already been re-parented. Linux's ps adds flags after the Z.
		const table = new FakeTable([entry(1, 0), entry(self, 1), { ...entry(100, self), state: "Z+" }, entry(101, 1)]);
		expect(stopTree(100, table, instant)).toBeUndefined();
		expect(table.kills).toEqual([]);
	});

	it("sends SIGKILL to a process still there a second after SIGTERM", async () => {
		const table = new FakeTable([entry(1, 0), entry(self, 1), entry(100, self), entry(101, 100)]);
		table.stubborn = [101];
		const start = Date.now();
		await stopTree(100, table);
		expect(Date.now() - start).toBeGreaterThanOrEqual(900);
		expect(table.kills).toEqual([
			[100, "SIGTERM"],
			[101, "SIGTERM"],
			[101, "SIGKILL"],
		]);
	});
});

describe("ProcessTable", () => {
	it("reads this process from the real table, with its start, its command and a state that is not a zombie's", () => {
		// The one check of ps's real output on each system CI runs, macOS included.
		const own = new ProcessTable().list().find((each) => each.pid === process.pid);
		expect(own).toMatchObject({ ppid: process.ppid, start: expect.stringMatching(/^\S+( \S+){4}$/) });
		expect(own?.state).toMatch(/^[A-Za-z]/);
		expect(own?.state).not.toMatch(/^Z/);
		// A process may rename itself after it starts: CI's Node reads as MainThread, so ps itself is the authority.
		expect(own?.command).toBe(
			execFileSync("/bin/ps", ["-o", "comm=", "-p", String(process.pid)], { encoding: "utf8" }).trim(),
		);
	});

	// A stand-in for ps that ignores SIGTERM, records its pid, waits `seconds`, then prints one entry and exits.
	function standIn(seconds: number): { ps: string; recorded: string; directory: string } {
		const directory = mkdtempSync(join(tmpdir(), "melian-ps-"));
		const ps = join(directory, "ps");
		const recorded = join(directory, "pid");
		writeFileSync(
			ps,
			`#!/bin/sh\ntrap '' TERM\necho $$ > ${recorded}\nsleep ${seconds}\necho '  100     1 Thu Oct  8 10:00:00 2026 S    git'\n`,
			{ mode: 0o755 },
		);
		return { ps, recorded, directory };
	}

	// Stops the stand-in by the pid it recorded, if it still runs, and removes its directory.
	function cleanUp({ recorded, directory }: { recorded: string; directory: string }): void {
		try {
			const pid = Number(readFileSync(recorded, "utf8"));
			if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
		} catch {}
		rmSync(directory, { recursive: true, force: true });
	}

	it("fails a read whose ps runs past the limit, though ps ignores SIGTERM, and the stop then signals nothing", () => {
		const stand = standIn(10);
		const kills: [number, string][] = [];
		const table = new ProcessTable(stand.ps, 500);
		const control: ProcessControl = {
			list: () => table.list(),
			kill: (pid, signal) => void kills.push([pid, signal]),
		};
		const start = Date.now();
		try {
			expect(() => table.list()).toThrow("ps failed");
			expect(stopTree(100, control, instant)).toBeUndefined();
			expect(Date.now() - start).toBeLessThan(3000);
			expect(kills).toEqual([]);
		} finally {
			cleanUp(stand);
		}
	}, 20_000);

	it("reads a ps that answers inside the limit", () => {
		const stand = standIn(1);
		try {
			expect(new ProcessTable(stand.ps, 4000).list()).toEqual([
				{ pid: 100, ppid: 1, start: "Thu Oct 8 10:00:00 2026", state: "S", command: "git" },
			]);
		} finally {
			cleanUp(stand);
		}
	}, 20_000);

	it("reads the same start for this process whatever the caller's time zone", () => {
		const zone = process.env.TZ;
		try {
			const starts = ["UTC", "Australia/Sydney", "America/New_York"].map((each) => {
				process.env.TZ = each;
				return new ProcessTable().start(process.pid);
			});
			expect(new Set(starts).size).toBe(1);
			expect(starts[0]).toMatch(/^\S+ \S+ \d+ \d\d:\d\d:\d\d \d{4}$/);
		} finally {
			if (zone === undefined) delete process.env.TZ;
			else process.env.TZ = zone;
		}
	});
});
