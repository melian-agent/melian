import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcessEntry, ProcessTable } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordRepository } from "../src/repository.ts";
import { Remote } from "./fixtures/remote.ts";

let remote: Remote;
let directory: string;
let records: string;
let outside: string;
let commit: string;
const children: ChildProcess[] = [];

const host = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
// A leftover's suffix as the store names it: this host's hash, the owner's pid and start time, and a UUID.
const owned = (pid: number, start: string, on = host) => `${on}-${pid}-${hex(start)}-${randomUUID()}`;
const self = () => {
	const start = new ProcessTable().start(process.pid);
	if (start === undefined) throw new Error("ps does not list this process");
	return { pid: process.pid, start };
};

// A throwaway process that exits on its own within a minute, stopped by its own pid.
async function live(): Promise<{ pid: number; start: string; child: ChildProcess }> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	children.push(child);
	await once(child, "spawn");
	const pid = child.pid as number;
	const start = new ProcessTable().start(pid);
	if (start === undefined) throw new Error(`ps does not list pid ${pid}`);
	return { pid, start, child };
}

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	await exited;
}

// A process that was live and has exited, so its pid and start time name no process now.
async function exited(): Promise<{ pid: number; start: string }> {
	const { pid, start, child } = await live();
	await stop(child);
	return { pid, start };
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
	vi.restoreAllMocks();
	for (const child of children.splice(0)) await stop(child);
	await remote.close();
	rmSync(outside, { recursive: true, force: true });
});

describe("the sweep when the store opens", { timeout: 60_000 }, () => {
	it("removes what a process that has exited left, and keeps the hint ref", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid, owner.start);
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(gone);
		expect(fetchRefs()).toEqual(["refs/melian/last"]);
		expect(store.sweep).toEqual({ removed: names(suffix), kept: [], failed: [] });
	});

	it("keeps what a live process holds, through a second handle's sweep", async () => {
		const owner = await live();
		const suffix = owned(owner.pid, owner.start);
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({ removed: [], kept: [], failed: [] });
	});

	it("keeps what this process holds", async () => {
		const owner = self();
		const suffix = owned(owner.pid, owner.start);
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(there);
		expect(store.sweep).toEqual({ removed: [], kept: [], failed: [] });
	});

	it("does not take a process that reuses the pid for the owner", async () => {
		const suffix = owned(process.pid, "Thu Jan  1 00:00:00 1970");
		plant(suffix);
		const store = await remote.open({ directory });
		expect(planted(suffix)).toEqual(gone);
		expect(store.sweep.removed).toEqual(names(suffix));
	});

	it("keeps and names what another host made, whose processes it cannot see", async () => {
		const owner = self();
		const suffix = owned(owner.pid, owner.start, "0123456789abcdef");
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
			`${host}-${owner.pid}-${hex(owner.start)}`,
			`${host}-0${owner.pid}-${hex(owner.start)}-${randomUUID()}`,
			`${host}-${owner.pid}-${hex(owner.start).toUpperCase()}-${randomUUID()}`,
			`${host}-${owner.pid}-${hex(owner.start)}-${randomUUID()}-x`,
			`${host}-${owner.pid}--${randomUUID()}`,
			`${host}-99999999999-${hex(owner.start)}-${randomUUID()}`,
			`${host}-${owner.pid}-${hex(owner.start)}f-${randomUUID()}`,
			`${host}-${owner.pid}-ff${hex(owner.start)}-${randomUUID()}`,
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

	it("sweeps nothing, and says why, when the process table cannot be read", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid, owner.start);
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
		expect(store.sweep).toEqual({
			removed: [],
			kept: [`records.git/melian-index-${unowned}`],
			failed: [],
			unread: "ps failed: no ps here",
		});
	});

	it("lists the leftovers before it reads the table, so a call that starts in between keeps its own", async () => {
		const table = new ProcessTable().list();
		const late = owned(4_000_000, "Thu Jan  1 00:00:00 1970");
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
		const folder = owned(owner.pid, owner.start);
		const index = owned(owner.pid, owner.start);
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
		const suffix = owned(owner.pid, owner.start);
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
		const folder = owned(owner.pid, owner.start);
		const index = owned(owner.pid, owner.start);
		writeFileSync(join(directory, `records.git.${folder}`), "file");
		mkdirSync(join(records, `melian-index-${index}`));
		const store = await remote.open({ directory });
		expect(kind(join(directory, `records.git.${folder}`))).toBe("file");
		expect(kind(join(records, `melian-index-${index}`))).toBe("directory");
		expect(store.sweep.kept).toEqual([`records.git.${folder}`, `records.git/melian-index-${index}`]);
	});

	it("keeps a ref below the fetch refs that is no fetch ref of Melian's", async () => {
		const owner = await exited();
		const suffix = `${owned(owner.pid, owner.start)}/deeper`;
		git(["update-ref", `refs/melian/fetch/${suffix}`, commit]);
		git(["update-ref", "refs/melian/other", commit]);
		const store = await remote.open({ directory });
		expect(fetchRefs()).toEqual([`refs/melian/fetch/${suffix}`, "refs/melian/last", "refs/melian/other"]);
		expect(store.sweep).toEqual({ removed: [], kept: [`refs/melian/fetch/${suffix}`], failed: [] });
	});

	it("names a stale leftover it could not remove, and still opens", async () => {
		const owner = await exited();
		const suffix = owned(owner.pid, owner.start);
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
		const suffix = owned(owner.pid, owner.start);
		const fresh = remote.host();
		mkdirSync(join(fresh, `records.git.${suffix}`), { recursive: true });
		const store = await remote.open({ directory: fresh });
		expect(kind(join(fresh, `records.git.${suffix}`))).toBe("absent");
		expect(store.sweep).toEqual({ removed: [`records.git.${suffix}`], kept: [], failed: [] });
	});
});

describe("the names a call gives what it makes", { timeout: 60_000 }, () => {
	const ownedName = (pid: number, start: string) =>
		new RegExp(`^${host}-${pid}-${hex(start)}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);

	it("names its fetch ref and temporary index after this host and process", async () => {
		const run = vi.spyOn(RecordRepository.prototype, "run");
		const store = await remote.open({ directory });
		await store.writeCell("pull-0123456789abcdef", undefined, '"lease"');
		const owner = self();
		const fetch = run.mock.calls.map(([args]) => args).find((args) => args[0] === "fetch");
		const refspec = fetch?.find((arg) => arg.startsWith("+refs/heads/"));
		expect(refspec?.replace(/^.*:refs\/melian\/fetch\//, "")).toMatch(ownedName(owner.pid, owner.start));
		const index = run.mock.calls.map(([, , options]) => options?.index).find((path) => path !== undefined);
		expect(index?.startsWith(join(records, "melian-index-"))).toBe(true);
		expect(index?.slice(join(records, "melian-index-").length)).toMatch(ownedName(owner.pid, owner.start));
	});

	it("gives a plain UUID, which no sweep removes, when this process's start time cannot be read", async () => {
		const run = vi.spyOn(RecordRepository.prototype, "run");
		const store = await remote.open({ directory, processes: { list: () => [] } });
		await store.writeCell("pull-0123456789abcdef", undefined, '"lease"');
		const fetch = run.mock.calls.map(([args]) => args).find((args) => args[0] === "fetch");
		const refspec = fetch?.find((arg) => arg.startsWith("+refs/heads/"));
		expect(refspec?.replace(/^.*:refs\/melian\/fetch\//, "")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});
});
