import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type * as FsSync from "node:fs";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type * as Fs from "node:fs/promises";
import { lstat, readdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcessEntry, ProcessTable } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../src/deadline.ts";
import { Owner } from "../src/owner.ts";
import { RecordRepository } from "../src/repository.ts";
import { Remote } from "./fixtures/remote.ts";

// A directory lists its entries in whatever order its filesystem keeps, so one test reverses the listing, and others
// make a listing or a stat fail.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return { ...actual, readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});

// The owner key reads this process's pid namespace, so a test can stand another namespace in for it.
const namespace = vi.hoisted(() => ({ read: undefined as (() => { dev: number; ino: number }) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsSync>();
	const statSync = ((path: FsSync.PathLike, options?: FsSync.StatSyncOptions) =>
		path === "/proc/self/ns/pid" && namespace.read !== undefined
			? namespace.read()
			: actual.statSync(path, options)) as typeof actual.statSync;
	return { ...actual, statSync, default: { ...actual, statSync } };
});

let remote: Remote;
let directory: string;
let records: string;
let outside: string;
let commit: string;
const children: ChildProcess[] = [];

// A host's hash as the store makes it: the host's name, with the pid namespace on Linux.
const hash = (space: string) => createHash("sha256").update(`${hostname()}${space}`).digest("hex").slice(0, 16);
const spaceOf = ({ dev, ino }: { dev: number; ino: number }) => `\0${dev}:${ino}`;
const host = hash(process.platform === "linux" ? spaceOf(statSync("/proc/self/ns/pid")) : "");
// A leftover's suffix as the store names it: this host's hash, the owner's pid, and a UUID.
const owned = (pid: number, on = host) => `${on}-${pid}-${randomUUID()}`;

// A throwaway process that exits on its own within a minute, stopped by its own pid.
async function live(): Promise<{ pid: number; child: ChildProcess }> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	children.push(child);
	await once(child, "spawn");
	const pid = child.pid as number;
	if (!new ProcessTable().list().some((entry) => entry.pid === pid)) throw new Error(`ps does not list pid ${pid}`);
	return { pid, child };
}

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	await exited;
}

// A process that was live and has exited, so its pid names no process now.
async function exited(): Promise<{ pid: number }> {
	const { pid, child } = await live();
	await stop(child);
	if (new ProcessTable().list().some((entry) => entry.pid === pid)) throw new Error(`ps still lists pid ${pid}`);
	return { pid };
}

const git = (args: readonly string[], input?: string) =>
	remote.git(["--git-dir", records, ...args], records, { input });
const fetchRefs = () =>
	git(["for-each-ref", "--format=%(refname)", "refs/melian/"])
		.split("\n")
		.filter((line) => line !== "")
		.sort();
const kind = (path: string) => {
	try {
		const found = lstatSync(path);
		return found.isSymbolicLink() ? "link" : found.isDirectory() ? "directory" : "file";
	} catch {
		return "absent";
	}
};

// Leaves what a killed call leaves, named with `suffix`: a half-made repository, a temporary index and its lock, and a
// fetch ref.
function plant(suffix: string): void {
	mkdirSync(join(directory, `records.git.${suffix}`));
	writeFileSync(join(directory, `records.git.${suffix}`, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(records, `melian-index-${suffix}`), "index");
	writeFileSync(join(records, `melian-index-${suffix}.lock`), "lock");
	git(["update-ref", `refs/melian/fetch/${suffix}`, commit]);
}

function planted(suffix: string) {
	return {
		folder: kind(join(directory, `records.git.${suffix}`)),
		index: kind(join(records, `melian-index-${suffix}`)),
		lock: kind(join(records, `melian-index-${suffix}.lock`)),
		ref: fetchRefs().includes(`refs/melian/fetch/${suffix}`),
	};
}

const names = (suffix: string) => [
	`records.git.${suffix}`,
	`records.git/melian-index-${suffix}`,
	`records.git/melian-index-${suffix}.lock`,
	`refs/melian/fetch/${suffix}`,
];
const gone = { folder: "absent", index: "absent", lock: "absent", ref: false };
const there = { folder: "directory", index: "file", lock: "file", ref: true };

beforeEach(async () => {
	remote = await Remote.create();
	directory = remote.host();
	records = join(directory, "records.git");
	outside = mkdtempSync(join(tmpdir(), "melian-sweep-outside-"));
	await remote.open({ directory });
	commit = git(["commit-tree", git(["mktree"], ""), "-m", "planted"]);
	git(["update-ref", "refs/melian/last", commit]);
});

afterEach(async () => {
	namespace.read = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const child of children.splice(0)) await stop(child);
	await remote.close();
	rmSync(outside, { recursive: true, force: true });
});

describe("the sweep when the store opens", { timeout: 60_000 }, () => {
	it("removes what a process that has exited left, and keeps the hint ref", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(gone);
		expect(fetchRefs()).toEqual(["refs/melian/last"]);
		expect(store.sweep).toEqual({ removed: names(suffix), kept: [], failed: [] });
	});

	it("keeps and names what a live process holds, through a second handle's sweep", async () => {
		const owner = await live();
		const suffix = owned(owner.pid);
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({ removed: [], kept: names(suffix), failed: [] });
	});

	it("keeps and names what this process holds", async () => {
		const suffix = owned(process.pid);
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({ removed: [], kept: names(suffix), failed: [] });
	});

	it("keeps what a live process holds when the sweep reads the table under another time zone", async () => {
		vi.stubEnv("TZ", "UTC");
		const suffix = Owner.current(new ProcessTable().list())?.name();
		if (suffix === undefined) throw new Error("ps does not list this process");
		plant(suffix);
		vi.stubEnv("TZ", "Australia/Sydney");
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({ removed: [], kept: names(suffix), failed: [] });
	});

	it("keeps and names what a pid now held by another process left, since it cannot tell that process from the maker", async () => {
		const reused = { pid: 4_000_000, ppid: 1, start: "Mon Nov 16 01:00:00 2026" };
		const table = [...new ProcessTable().list(), reused];
		const suffix = owned(reused.pid);
		plant(suffix);
		const store = await remote.open({ directory, processes: { list: () => table } });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({ removed: [], kept: names(suffix), failed: [] });
	});

	it("removes what a pid the table does not list left", async () => {
		const table = new ProcessTable().list();
		const absent = 4_000_000;
		expect(table.some((entry) => entry.pid === absent)).toBe(false);
		const suffix = owned(absent);
		plant(suffix);
		const store = await remote.open({ directory, processes: { list: () => table } });
		expect(planted(suffix)).toEqual(gone);
		expect(store.sweep).toEqual({ removed: names(suffix), kept: [], failed: [] });
	});

	it("sweeps in name order whatever order the directory lists its entries", async () => {
		const table = new ProcessTable().list();
		const suffixes = [owned(4_000_000), owned(4_000_000)].sort();
		for (const suffix of suffixes) plant(suffix);
		const listed = vi.mocked(readdir).getMockImplementation() as typeof readdir;
		vi.mocked(readdir).mockImplementation((async (path: string) =>
			((await listed(path)) as string[]).sort().reverse()) as unknown as typeof readdir);
		try {
			const store = await remote.open({ directory, processes: { list: () => table } });
			const [first, second] = suffixes.map(names);
			expect(store.sweep).toEqual({
				removed: [first[0], second[0], first[1], first[2], second[1], second[2], first[3], second[3]],
				kept: [],
				failed: [],
			});
		} finally {
			vi.mocked(readdir).mockImplementation(listed);
		}
	});

	it("passes over an entry that another call removed between the listing and its read", async () => {
		const table = new ProcessTable().list();
		const suffix = owned(4_000_000);
		const listed = vi.mocked(readdir).getMockImplementation() as typeof readdir;
		vi.mocked(readdir).mockImplementation((async (path: string) => [
			...((await listed(path)) as string[]),
			path === directory ? `records.git.${suffix}` : `melian-index-${suffix}`,
		]) as unknown as typeof readdir);
		try {
			const store = await remote.open({ directory, processes: { list: () => table } });
			expect(store.sweep).toEqual({ removed: [], kept: [], failed: [] });
		} finally {
			vi.mocked(readdir).mockImplementation(listed);
		}
	});

	it("counts as removed, not failed, a leftover another call removed before this one could", async () => {
		const table = new ProcessTable().list();
		const suffix = owned(4_000_000);
		plant(suffix);
		let reads = 0;
		// The first read names this process for what it makes; the second is the sweep's, after it listed the leftovers.
		const list = () => {
			if (++reads === 2) {
				rmSync(join(directory, `records.git.${suffix}`), { recursive: true });
				rmSync(join(records, `melian-index-${suffix}`));
				rmSync(join(records, `melian-index-${suffix}.lock`));
			}
			return table;
		};
		const store = await remote.open({ directory, processes: { list } });
		expect(planted(suffix)).toEqual(gone);
		expect(store.sweep).toEqual({ removed: names(suffix), kept: [], failed: [] });
	});

	it("keeps and names what another host made, whose processes it cannot see", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid, "0123456789abcdef");
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({ removed: [], kept: names(suffix), failed: [] });
	});

	it("keeps and names a leftover with no owner in its name, as an earlier build made", async () => {
		const suffix = randomUUID();
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({ removed: [], kept: names(suffix), failed: [] });
	});

	it("keeps and names a leftover whose name does not parse", async () => {
		const owner = await exited();
		const suffixes = [
			`${host}-${owner.pid}`,
			`${host}-0${owner.pid}-${randomUUID()}`,
			`${host}-${owner.pid}-${randomUUID().toUpperCase()}`,
			`${host.toUpperCase()}-${owner.pid}-${randomUUID()}`,
			`${host}-${owner.pid}-${randomUUID()}-x`,
			`x${host}-${owner.pid}-${randomUUID()}`,
			`${host.slice(1)}-${owner.pid}-${randomUUID()}`,
			`${host}--${randomUUID()}`,
			`${host}-99999999999-${randomUUID()}`,
			`${host}-${owner.pid}-${Buffer.from("Mon Nov 16 01:00:00 2026").toString("hex")}-${randomUUID()}`,
			`${host}-${owner.pid}-.lock${randomUUID()}`,
		];
		for (const suffix of suffixes) writeFileSync(join(records, `melian-index-${suffix}`), "index");
		const store = await remote.open({ directory });
		for (const suffix of suffixes) expect(kind(join(records, `melian-index-${suffix}`))).toBe("file");
		expect(store.sweep).toEqual({
			removed: [],
			kept: suffixes.map((suffix) => `records.git/melian-index-${suffix}`).sort(),
			failed: [],
		});
	});

	it("sweeps nothing, says why, and names what it kept, when the process table cannot be read", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		plant(suffix);
		const unowned = randomUUID();
		writeFileSync(join(records, `melian-index-${unowned}`), "index");
		const store = await remote.open({
			directory,
			processes: {
				list: () => {
					throw new Error("ps failed: no ps here");
				},
			},
		});
		expect(planted(suffix)).toEqual(there);
		const [folder, index, lock, ref] = names(suffix);
		expect(store.sweep).toEqual({
			removed: [],
			kept: [folder, ...[index, lock, `records.git/melian-index-${unowned}`].sort(), ref],
			failed: [],
			unread: "ps failed: no ps here",
		});
	});

	it("sweeps nothing, says why, and names what it kept, when the process table does not list this process", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		plant(suffix);
		const store = await remote.open({ directory, processes: { list: () => [] } });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({
			removed: [],
			kept: names(suffix),
			failed: [],
			unread: "it does not list this process",
		});
	});

	it("sweeps nothing when the table lists this pid under another parent, as a table from another namespace can", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		plant(suffix);
		const table = new ProcessTable()
			.list()
			.map((entry) => (entry.pid === process.pid ? { ...entry, ppid: entry.ppid + 1 } : entry));
		const store = await remote.open({ directory, processes: { list: () => table } });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep.unread).toBe("it does not list this process");
	});

	it("sweeps nothing when the table lists another child of this process's parent, but not this process", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		plant(suffix);
		const sibling = { pid: 4_000_000, ppid: process.ppid, start: "Mon Nov 16 01:00:00 2026" };
		const store = await remote.open({ directory, processes: { list: () => [sibling] } });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep.unread).toBe("it does not list this process");
	});

	it("lists the leftovers before it reads the table, so a call that starts in between keeps its own", async () => {
		const table = new ProcessTable().list();
		const late = owned(4_000_000);
		let reads = 0;
		// The first read names this process for what it makes; the second is the sweep's.
		const store = await remote.open({
			directory,
			processes: {
				list: (): ProcessEntry[] => {
					if (++reads === 2) writeFileSync(join(records, `melian-index-${late}`), "index");
					return table;
				},
			},
		});
		expect(reads).toBe(2);
		expect(kind(join(records, `melian-index-${late}`))).toBe("file");
		expect(store.sweep).toEqual({ removed: [], kept: [], failed: [] });
	});

	it("never follows a link, and keeps and names one", async () => {
		const owner = await exited();
		const folder = owned(owner.pid);
		const index = owned(owner.pid);
		mkdirSync(join(outside, "repository"));
		writeFileSync(join(outside, "repository", "HEAD"), "kept");
		writeFileSync(join(outside, "index"), "kept");
		symlinkSync(join(outside, "repository"), join(directory, `records.git.${folder}`));
		symlinkSync(join(outside, "index"), join(records, `melian-index-${index}`));
		const store = await remote.open({ directory });
		expect(readFileSync(join(outside, "repository", "HEAD"), "utf8")).toBe("kept");
		expect(readFileSync(join(outside, "index"), "utf8")).toBe("kept");
		expect(kind(join(directory, `records.git.${folder}`))).toBe("link");
		expect(kind(join(records, `melian-index-${index}`))).toBe("link");
		expect(store.sweep).toEqual({
			removed: [],
			kept: [`records.git.${folder}`, `records.git/melian-index-${index}`],
			failed: [],
		});
	});

	it("removes a half-made repository without following a link inside it", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		mkdirSync(join(outside, "objects"));
		writeFileSync(join(outside, "objects", "pack"), "kept");
		mkdirSync(join(directory, `records.git.${suffix}`));
		symlinkSync(join(outside, "objects"), join(directory, `records.git.${suffix}`, "objects"));
		const store = await remote.open({ directory });
		expect(kind(join(directory, `records.git.${suffix}`))).toBe("absent");
		expect(readFileSync(join(outside, "objects", "pack"), "utf8")).toBe("kept");
		expect(store.sweep.removed).toEqual([`records.git.${suffix}`]);
	});

	it("keeps a directory named as a temporary index, and a file named as a half-made repository", async () => {
		const owner = await exited();
		const folder = owned(owner.pid);
		const index = owned(owner.pid);
		writeFileSync(join(directory, `records.git.${folder}`), "file");
		mkdirSync(join(records, `melian-index-${index}`));
		const store = await remote.open({ directory });
		expect(kind(join(directory, `records.git.${folder}`))).toBe("file");
		expect(kind(join(records, `melian-index-${index}`))).toBe("directory");
		expect(store.sweep.kept).toEqual([`records.git.${folder}`, `records.git/melian-index-${index}`]);
	});

	it("keeps a ref below the fetch refs that is no fetch ref of Melian's", async () => {
		const owner = await exited();
		const suffix = `${owned(owner.pid)}/deeper`;
		git(["update-ref", `refs/melian/fetch/${suffix}`, commit]);
		git(["update-ref", "refs/melian/other", commit]);
		const store = await remote.open({ directory });
		expect(fetchRefs()).toEqual([`refs/melian/fetch/${suffix}`, "refs/melian/last", "refs/melian/other"]);
		expect(store.sweep).toEqual({ removed: [], kept: [`refs/melian/fetch/${suffix}`], failed: [] });
	});

	it("removes a stale fetch ref that is a symbolic ref, and leaves the ref it points at", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		git(["symbolic-ref", `refs/melian/fetch/${suffix}`, "refs/melian/last"]);
		const store = await remote.open({ directory });
		expect(fetchRefs()).toEqual(["refs/melian/last"]);
		expect(git(["rev-parse", "refs/melian/last"])).toBe(commit);
		expect(store.sweep).toEqual({ removed: [`refs/melian/fetch/${suffix}`], kept: [], failed: [] });
	});

	it("names a stale leftover it could not remove, and still opens", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		git(["update-ref", `refs/melian/fetch/${suffix}`, commit]);
		const ref = join(records, "refs", "melian", "fetch", suffix);
		writeFileSync(`${ref}.lock`, "");
		const store = await remote.open({ directory, deadlineMs: 2_000 });
		expect(fetchRefs()).toContain(`refs/melian/fetch/${suffix}`);
		expect(store.sweep).toEqual({ removed: [], kept: [], failed: [`refs/melian/fetch/${suffix}`] });
		rmSync(`${ref}.lock`);
	});

	it("sweeps the half-made repositories when records.git itself is not there yet", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		const fresh = remote.host();
		mkdirSync(join(fresh, `records.git.${suffix}`), { recursive: true });
		const store = await remote.open({ directory: fresh });
		expect(kind(join(fresh, `records.git.${suffix}`))).toBe("absent");
		expect(store.sweep).toEqual({ removed: [`records.git.${suffix}`], kept: [], failed: [] });
	});
});

// A clock that stands still until the sweep has read the process table, then reads `left` ms before the deadline and
// moves 1 ms each time it is read, so the sweep's removals meet the deadline while its listing and git commands do not.
function sweepClock(left: number): { clock: Clock; processes: { list(): ProcessEntry[] } } {
	const table = new ProcessTable().list();
	let now = 0;
	let ticking = false;
	let reads = 0;
	return {
		clock: { now: () => (ticking ? now++ : now), sleep: async () => {} },
		processes: {
			list: () => {
				// The first read names this process for what it makes; the second is the sweep's.
				if (++reads === 2) {
					now = 30_000 - left;
					ticking = true;
				}
				return table;
			},
		},
	};
}

describe("the sweep's deadline", { timeout: 60_000 }, () => {
	const folders = (suffixes: readonly string[]) =>
		suffixes.map((suffix) => kind(join(directory, `records.git.${suffix}`)));
	const half = (suffix: string) => mkdirSync(join(directory, `records.git.${suffix}`));

	it("removes what it reaches while time is left, and counts the rest unswept", async () => {
		const owner = await exited();
		const suffixes = [owned(owner.pid), owned(owner.pid)].sort();
		for (const suffix of suffixes) half(suffix);
		const store = await remote.open({ directory, deadlineMs: 30_000, ...sweepClock(1) });
		expect(folders(suffixes)).toEqual(["absent", "directory"]);
		expect(store.sweep).toEqual({ removed: [`records.git.${suffixes[0]}`], kept: [], failed: [], unswept: 1 });
	});

	it("removes nothing once no time is left, still names what it keeps, and the next open finishes", async () => {
		const owner = await exited();
		const suffixes = [owned(owner.pid), owned(owner.pid)].sort();
		for (const suffix of suffixes) half(suffix);
		const unowned = randomUUID();
		half(unowned);
		const late = await remote.open({ directory, deadlineMs: 30_000, ...sweepClock(0) });
		expect(folders(suffixes)).toEqual(["directory", "directory"]);
		expect(late.sweep).toEqual({ removed: [], kept: [`records.git.${unowned}`], failed: [], unswept: 2 });
		const next = await remote.open({ directory });
		expect(folders(suffixes)).toEqual(["absent", "absent"]);
		expect(next.sweep).toEqual({
			removed: suffixes.map((suffix) => `records.git.${suffix}`),
			kept: [`records.git.${unowned}`],
			failed: [],
		});
	});
});

// A clock that stands still, and reads `left` ms before a 30 s deadline from the moment the sweep starts.
function listClock(left: number): Clock {
	let now = 0;
	const real = RecordRepository.prototype.sweep;
	vi.spyOn(RecordRepository.prototype, "sweep").mockImplementation(function (this: RecordRepository, ...args) {
		now = 30_000 - left;
		return real.apply(this, args);
	});
	return { now: () => now, sleep: async () => {} };
}

describe("the sweep's listing", { timeout: 60_000 }, () => {
	const listings = (run: { mock: { calls: unknown[][] } }) =>
		run.mock.calls.filter(([args]) => (args as string[]).includes("refs/melian/fetch/")).length;

	it("lists no fetch refs once no time is left, removes nothing, and the open still succeeds", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		plant(suffix);
		const clock = listClock(0);
		const run = vi.spyOn(RecordRepository.prototype, "run");
		const store = await remote.open({ directory, deadlineMs: 30_000, clock });
		expect(listings(run)).toBe(0);
		expect(store.sweep).toEqual({ removed: [], kept: [], failed: [], unswept: 3, unlisted: true });
		expect(planted(suffix)).toEqual(there);
	});

	it("starts the listing while a millisecond is left", async () => {
		const owner = await exited();
		plant(owned(owner.pid));
		const clock = listClock(1);
		const run = vi.spyOn(RecordRepository.prototype, "run");
		await remote.open({ directory, deadlineMs: 30_000, clock });
		expect(listings(run)).toBe(1);
	});

	it("removes nothing, and the open still succeeds, when the listing fails", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid);
		plant(suffix);
		const real = RecordRepository.prototype.run;
		vi.spyOn(RecordRepository.prototype, "run").mockImplementation(function (this: RecordRepository, ...args) {
			if (args[0].includes("refs/melian/fetch/")) throw new Error("for-each-ref failed");
			return real.apply(this, args);
		});
		const store = await remote.open({ directory });
		expect(store.sweep).toEqual({ removed: [], kept: [], failed: [], unlisted: true });
		expect(planted(suffix)).toEqual(there);
	});

	for (const [where, at] of [
		["the state directory", () => directory],
		["records.git", () => records],
	] as const)
		it(`removes nothing, and the open still succeeds, when ${where} cannot be listed`, async () => {
			const owner = await exited();
			const suffix = owned(owner.pid);
			plant(suffix);
			const listed = vi.mocked(readdir).getMockImplementation() as typeof readdir;
			vi.mocked(readdir).mockImplementation((async (path: string) => {
				if (path === at()) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
				return listed(path);
			}) as unknown as typeof readdir);
			try {
				const store = await remote.open({ directory });
				expect(store.sweep).toEqual({ removed: [], kept: [], failed: [], unlisted: true });
				expect(planted(suffix)).toEqual(there);
			} finally {
				vi.mocked(readdir).mockImplementation(listed);
			}
		});

	for (const [what, at] of [
		["half-made repository", (suffix: string) => join(directory, `records.git.${suffix}`)],
		["temporary index", (suffix: string) => join(records, `melian-index-${suffix}`)],
	] as const)
		it(`removes nothing, and says it could not list every leftover, when a ${what} cannot be stat'ed`, async () => {
			const owner = await exited();
			const suffix = owned(owner.pid);
			plant(suffix);
			const stat = vi.mocked(lstat).getMockImplementation() as typeof lstat;
			vi.mocked(lstat).mockImplementation((async (path: string) => {
				if (path === at(suffix)) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
				return stat(path);
			}) as unknown as typeof lstat);
			try {
				const store = await remote.open({ directory });
				expect(store.sweep).toEqual({ removed: [], kept: [], failed: [], unlisted: true });
				expect(planted(suffix)).toEqual(there);
			} finally {
				vi.mocked(lstat).mockImplementation(stat);
			}
		});
});

describe("the owner's process namespace", () => {
	const other = { dev: 4, ino: 4026532000 };
	const platform = (name: NodeJS.Platform) => vi.spyOn(process, "platform", "get").mockReturnValue(name);

	it("keeps what a process in another pid namespace under this host's name left, and removes what this one's left", async () => {
		platform("linux");
		// Each prefix is the one the store gives this host under that namespace, and each pid names no live process.
		const prefix = () => Owner.current(new ProcessTable().list())?.name().split("-")[0] as string;
		namespace.read = () => other;
		const theirs = owned((await exited()).pid, prefix());
		namespace.read = undefined;
		const ours = owned((await exited()).pid, prefix());
		plant(theirs);
		plant(ours);
		const store = await remote.open({ directory });
		expect(planted(theirs)).toEqual(there);
		expect(planted(ours)).toEqual(gone);
		expect(store.sweep).toEqual({ removed: names(ours).sort(), kept: names(theirs).sort(), failed: [] });
	});

	it("names what it makes after the pid namespace it reads", async () => {
		platform("linux");
		namespace.read = () => other;
		const owner = Owner.current(new ProcessTable().list());
		expect(owner?.name()).toMatch(new RegExp(`^${hash(spaceOf(other))}-${process.pid}-[0-9a-f-]{36}$`));
	});

	it("names what it makes by a UUID alone, and keeps every owned leftover, when Linux will not say its pid namespace", async () => {
		platform("linux");
		namespace.read = () => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		};
		const suffix = owned((await exited()).pid);
		plant(suffix);
		expect(Owner.current(new ProcessTable().list())).toBeUndefined();
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({ removed: [], kept: names(suffix), failed: [] });
	});

	it("keys by the host's name alone off Linux, reads no namespace, and still sweeps", async () => {
		platform("darwin");
		namespace.read = () => {
			throw new Error("a namespace was read off Linux");
		};
		const suffix = owned((await exited()).pid, hash(""));
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(gone);
		expect(store.sweep).toEqual({ removed: names(suffix), kept: [], failed: [] });
	});
});

describe("the names a call gives what it makes", { timeout: 60_000 }, () => {
	const ownedName = new RegExp(
		`^${host}-${process.pid}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
	);

	it("names its fetch ref and temporary index after this host and process", async () => {
		const run = vi.spyOn(RecordRepository.prototype, "run");
		const store = await remote.open({ directory });
		await store.writeCell("pull-0123456789abcdef", undefined, '"lease"');
		const fetch = run.mock.calls.map(([args]) => args).find((args) => args[0] === "fetch");
		const refspec = fetch?.find((arg) => arg.startsWith("+refs/heads/"));
		expect(refspec?.replace(/^.*:refs\/melian\/fetch\//, "")).toMatch(ownedName);
		const index = run.mock.calls.map(([, , options]) => options?.index).find((path) => path !== undefined);
		expect(index?.startsWith(join(records, "melian-index-"))).toBe(true);
		expect(index?.slice(join(records, "melian-index-").length)).toMatch(ownedName);
	});

	const at = "Mon Nov 16 01:00:00 2026";
	it.each<[string, () => ProcessEntry[]]>([
		["does not list this process", () => []],
		[
			"lists this pid with another parent, as a table read from another pid namespace can",
			() => [{ pid: process.pid, ppid: process.ppid + 1, start: at }],
		],
		["lists this parent with another pid", () => [{ pid: process.pid + 1, ppid: process.ppid, start: at }]],
	])("gives a plain UUID, which no sweep removes, when the table %s", async (_, list) => {
		const run = vi.spyOn(RecordRepository.prototype, "run");
		const store = await remote.open({ directory, processes: { list } });
		await store.writeCell("pull-0123456789abcdef", undefined, '"lease"');
		const fetch = run.mock.calls.map(([args]) => args).find((args) => args[0] === "fetch");
		const refspec = fetch?.find((arg) => arg.startsWith("+refs/heads/"));
		expect(refspec?.replace(/^.*:refs\/melian\/fetch\//, "")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});
});
