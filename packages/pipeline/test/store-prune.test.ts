import { spawnSync } from "node:child_process";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphSnapshot, TestCoverage } from "@melian-agent/core";
import { StorePrune, StorePruneError } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoverageCache } from "../src/coverage-cache.ts";
import { GraphCache } from "../src/graph-cache.ts";
import {
	type ConversationId,
	backgroundContext as context,
	createRegistry,
	defineDoc,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { createFakeModels } from "../src/testing.ts";
import { commit, createRepository, gitIn, removeRepository } from "./fixtures/repo.ts";

const day = 86_400_000;
const digest = "e".repeat(64);
const graphFiles = {
	"facts.jsonl": '{"id":"a","kind":"symbol","name":"Alpha"}\n',
	"insights.json": "[]",
	"receipt.json": JSON.stringify({
		format_version: 1,
		enola_version: "0.4.27",
		snapshot_id: `sha256:${"d".repeat(64)}`,
	}),
	"snapshot.meta.json": "{}",
	"run.json": "{}",
};

let repo: string;
let state: string;
let outside: string[];
let now: number;
beforeEach(async () => {
	repo = createRepository();
	commit(repo, { "a.ts": "export const a = 1;\n" });
	state = await realpath(await mkdtemp(join(tmpdir(), "melian-prune-state-")));
	outside = [];
	now = Date.now();
});
afterEach(async () => {
	for (const path of outside) {
		spawnSync("git", ["-C", repo, "worktree", "unlock", path]);
		spawnSync("git", ["-C", repo, "worktree", "remove", "--force", path]);
		await rm(path, { recursive: true, force: true });
	}
	removeRepository(repo);
	await rm(state, { recursive: true, force: true });
});

const tree = (commitish: string) => gitIn(repo, "rev-parse", `${commitish}^{tree}`);
const plan = (options: { now?: number; env?: NodeJS.ProcessEnv } = {}) =>
	StorePrune.open(repo, {
		root: state,
		now: options.now ?? now,
		...(options.env ? { env: options.env } : {}),
	});
const exists = async (path: string) =>
	lstat(join(state, path)).then(
		() => true,
		() => false,
	);
const kinds = (prune: StorePrune) => prune.entries.map((entry) => [entry.kind, ...entry.paths]);

// Stores a graph for `forTree` created `age` milliseconds before `now`, with a coverage directory of ten bytes.
async function graph(forTree: string, age: number): Promise<string> {
	const cache = await GraphCache.open(state);
	const snapshot = GraphSnapshot.create(
		{ tree: forTree, version: "0.4.27", binary: "b".repeat(64), config: "c".repeat(64) },
		graphFiles,
		new Date(now - age),
	);
	await cache.store(snapshot);
	await mkdir(join(state, "coverage", snapshot.key), { recursive: true });
	await writeFile(join(state, "coverage", snapshot.key, "index.json"), "0123456789");
	return snapshot.key;
}

async function worktree(lock?: string): Promise<string> {
	const path = join(await realpath(tmpdir()), `melian-prune-worktree-${crypto.randomUUID()}`);
	outside.push(path);
	gitIn(repo, "worktree", "add", "--quiet", "--detach", ...(lock ? ["--lock", "--reason", lock] : []), path, "HEAD");
	return path;
}

function deadPid(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid;
}

async function age(path: string, milliseconds: number): Promise<number> {
	const when = new Date(now - milliseconds);
	await utimes(join(state, path), when, when);
	return (await lstat(join(state, path))).mtimeMs;
}

it("removes a graph older than seven days whose tree no live commit holds, with its coverage", async () => {
	const dead = await graph("f".repeat(40), 7 * day + 1);
	const prune = await plan();
	expect(prune.entries).toEqual([
		{ kind: "graph", paths: [`graphs/${dead}`, `coverage/${dead}`], bytes: expect.any(Number) },
	]);
	expect(prune.kept).toEqual([]);
	const graphBytes = Object.values(graphFiles).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
	const entryBytes = (await lstat(join(state, "graphs", dead, "entry.json"))).size;
	expect(prune.entries[0]?.bytes).toBe(graphBytes + entryBytes + 10);
	expect(await prune.apply()).toEqual({ removed: prune.entries, live: [] });
	expect(await exists(`graphs/${dead}`)).toBe(false);
	expect(await exists(`coverage/${dead}`)).toBe(false);
	expect((await readdir(join(state, "graphs"))).filter((name) => name.startsWith(".prune-"))).toEqual([]);
});

it("leaves a read of pruned coverage by its content ID a miss, even once the graph is rebuilt", async () => {
	const parts = { tree: "f".repeat(40), version: "0.4.27", binary: "b".repeat(64), config: "c".repeat(64) };
	const old = GraphSnapshot.create(parts, graphFiles, new Date(now - 7 * day - 1));
	await (await GraphCache.open(state)).store(old);
	const coverage = await CoverageCache.open(state);
	const id = await coverage.store(parts, TestCoverage.unavailable(parts.tree, parts.version));
	expect((await coverage.read(parts, "test", { id }))?.id).toBe(id);
	const prune = await plan();
	expect(kinds(prune)).toEqual([["graph", `graphs/${old.key}`, `coverage/${old.key}`]]);
	await prune.apply();
	await expect(coverage.read(parts, "test", { id })).resolves.toBeUndefined();
	await (await GraphCache.open(state)).store(GraphSnapshot.create(parts, graphFiles, new Date(now)));
	await expect(coverage.read(parts, "test", { id })).resolves.toBeUndefined();
});

it("keeps a dead tree's graph created exactly seven days ago and removes it a millisecond later", async () => {
	await graph("f".repeat(40), 7 * day);
	expect((await plan()).entries).toEqual([]);
	expect(kinds(await plan({ now: now + 1 })).map(([kind]) => kind)).toEqual(["graph"]);
});

it("keeps an old graph whose tree is a branch tip, a remote-tracking ref, or a detached worktree's HEAD", async () => {
	const first = gitIn(repo, "rev-parse", "HEAD");
	const branch = await graph(tree(first), 30 * day);
	const remote = commit(repo, { "b.ts": "export const b = 2;\n" });
	gitIn(repo, "update-ref", "refs/remotes/origin/gone", remote);
	const detached = commit(repo, { "c.ts": "export const c = 3;\n" });
	await worktree();
	gitIn(outside[0] ?? "", "checkout", "--quiet", "--detach", detached);
	gitIn(repo, "reset", "--quiet", "--hard", first);
	expect(gitIn(repo, "for-each-ref", "--contains", detached, "--format=%(refname)")).toBe("");
	const remoteGraph = await graph(tree(remote), 30 * day);
	const worktreeGraph = await graph(tree(detached), 30 * day);
	expect((await plan()).entries).toEqual([]);
	for (const key of [branch, remoteGraph, worktreeGraph]) expect(await exists(`graphs/${key}`)).toBe(true);
});

it("does not count a commit held only under refs/melian/pull/ as live", async () => {
	const pulled = commit(repo, { "p.ts": "export const p = 1;\n" });
	gitIn(repo, "update-ref", "refs/melian/pull/7/head", pulled);
	gitIn(repo, "reset", "--quiet", "--hard", "HEAD~1");
	const key = await graph(tree(pulled), 8 * day);
	expect(kinds(await plan())).toEqual([["graph", `graphs/${key}`, `coverage/${key}`]]);
});

it("removes a graph with no readable entry once it is more than a day old, and keeps its coverage until then", async () => {
	const name = "1".repeat(64);
	await mkdir(join(state, "graphs", name), { recursive: true });
	await mkdir(join(state, "coverage", name), { recursive: true });
	const mtime = await age(`graphs/${name}`, day);
	expect((await plan({ now: mtime + day })).entries).toEqual([]);
	expect(kinds(await plan({ now: mtime + day + 1 }))).toEqual([
		["unreadable graph", `graphs/${name}`],
		["orphan coverage", `coverage/${name}`],
	]);
});

it.each([
	["no entry.json", undefined],
	["text that is not JSON", "{"],
	["JSON that is not an object", "null"],
	[
		"an entry naming another key",
		JSON.stringify({
			format_version: 1,
			key: "2".repeat(64),
			parts: { tree: "f".repeat(40) },
			created: "2020-01-01T00:00:00Z",
		}),
	],
	[
		"an entry with no tree",
		JSON.stringify({ format_version: 1, key: "1".repeat(64), parts: {}, created: "2020-01-01T00:00:00Z" }),
	],
	["JSON that is a number", "1"],
	[
		"an entry with no parts",
		JSON.stringify({ format_version: 1, key: "1".repeat(64), created: "2020-01-01T00:00:00Z" }),
	],
	[
		"an entry whose creation time is a number",
		JSON.stringify({ format_version: 1, key: "1".repeat(64), parts: { tree: "f".repeat(40) }, created: 0 }),
	],
	[
		"an entry with no creation time",
		JSON.stringify({ format_version: 1, key: "1".repeat(64), parts: { tree: "f".repeat(40) } }),
	],
])("reads a graph with %s as unreadable", async (_, text) => {
	const name = "1".repeat(64);
	await mkdir(join(state, "graphs", name), { recursive: true });
	if (text !== undefined) await writeFile(join(state, "graphs", name, "entry.json"), text);
	await age(`graphs/${name}`, 2 * day);
	expect(kinds(await plan())).toEqual([["unreadable graph", `graphs/${name}`]]);
});

it("reads as unreadable an entry the graph contract refuses, though it names its key, a live tree and a future time", async () => {
	const name = "1".repeat(64);
	await mkdir(join(state, "graphs", name), { recursive: true });
	await writeFile(
		join(state, "graphs", name, "entry.json"),
		JSON.stringify({
			format_version: 1,
			key: name,
			parts: { tree: tree("HEAD") },
			created: "2099-01-01T00:00:00.000Z",
		}),
	);
	await age(`graphs/${name}`, 2 * day);
	expect(kinds(await plan())).toEqual([["unreadable graph", `graphs/${name}`]]);
});

it("keeps an old graph whose entry is a format it does not know, and its coverage", async () => {
	const name = "3".repeat(64);
	await mkdir(join(state, "graphs", name), { recursive: true });
	await mkdir(join(state, "coverage", name), { recursive: true });
	await writeFile(
		join(state, "graphs", name, "entry.json"),
		JSON.stringify({
			format_version: 2,
			key: name,
			parts: { tree: "f".repeat(40) },
			created: "2020-01-01T00:00:00Z",
		}),
	);
	await age(`graphs/${name}`, 30 * day);
	const prune = await plan();
	expect(prune.entries).toEqual([]);
	expect(prune.kept).toEqual([`graphs/${name}`]);
});

it("removes coverage whose graph is gone and keeps coverage of a kept graph", async () => {
	const kept = await graph(tree("HEAD"), day);
	const orphan = "4".repeat(64);
	await mkdir(join(state, "coverage", orphan), { recursive: true });
	await writeFile(join(state, "coverage", orphan, "index.json"), "0123456789");
	const prune = await plan();
	expect(prune.entries).toEqual([{ kind: "orphan coverage", paths: [`coverage/${orphan}`], bytes: 10 }]);
	await prune.apply();
	expect(await exists(`coverage/${orphan}`)).toBe(false);
	expect(await exists(`coverage/${kept}`)).toBe(true);
});

it("removes a mutation partition nothing wrote for more than fourteen days, judged by its newest file", async () => {
	const name = "5".repeat(64);
	await mkdir(join(state, "mutation", name, "report"), { recursive: true });
	await writeFile(join(state, "mutation", name, "report", "mutation.json"), "{}");
	await age(`mutation/${name}/report/mutation.json`, 30 * day);
	await age(`mutation/${name}/report`, 30 * day);
	const newest = await age(`mutation/${name}`, 14 * day);
	expect((await plan({ now: newest + 14 * day })).entries).toEqual([]);
	expect(kinds(await plan({ now: newest + 14 * day + 1 }))).toEqual([["mutation partition", `mutation/${name}`]]);
	await writeFile(join(state, "mutation", name, "report", "recent.json"), "{}");
	await age(`mutation/${name}/report/recent.json`, 13 * day);
	await age(`mutation/${name}/report`, 30 * day);
	await age(`mutation/${name}`, 30 * day);
	expect((await plan()).entries).toEqual([]);
});

it("does not remove a mutation partition written to after the plan was made", async () => {
	const name = "6".repeat(64);
	await mkdir(join(state, "mutation", name), { recursive: true });
	await age(`mutation/${name}`, 20 * day);
	const prune = await plan();
	expect(kinds(prune)).toEqual([["mutation partition", `mutation/${name}`]]);
	await writeFile(join(state, "mutation", name, "report.json"), "{}");
	expect(await prune.apply()).toEqual({ removed: [], live: [] });
	expect(await exists(`mutation/${name}/report.json`)).toBe(true);
});

it("keeps every tool entry, pinned or not, until the tool-cache decision's condition for pruning is met", async () => {
	const paths = [`tools/enola/0.0.1/darwin-arm64/${digest}`, "tools/enola/0.0.2", "tools/other"];
	for (const path of paths) {
		await mkdir(join(state, path), { recursive: true });
		await writeFile(join(state, path, "enola"), "12345");
		await age(path, 400 * day);
	}
	const prune = await plan();
	expect(prune.entries).toEqual([]);
	expect(prune.kept).toEqual([]);
	await prune.apply();
	for (const path of paths) expect(await exists(`${path}/enola`)).toBe(true);
});

it("keeps changesets, scripted stores, links, scratch and anything it does not recognise", async () => {
	for (const name of ["pull-1.sqlite", "range-2.sqlite"]) await writeFile(join(state, name), "12345");
	await writeFile(join(state, "pull-1.sqlite-wal"), "123");
	await writeFile(join(state, "pull-1.sqlite-shm"), "12");
	await mkdir(join(state, "scripted"), { recursive: true });
	await writeFile(join(state, "scripted", "pull-3.sqlite"), "x");
	await mkdir(join(state, "ledger"), { recursive: true });
	await writeFile(join(state, "notes.txt"), "x");
	await mkdir(join(state, "graphs", "not-a-key"), { recursive: true });
	await mkdir(join(state, "coverage", "not-a-key"), { recursive: true });
	await mkdir(join(state, "mutation", "not-a-key"), { recursive: true });
	await mkdir(join(state, "tools"), { recursive: true });
	await writeFile(join(state, "tools", "stray"), "x");
	const elsewhere = await mkdtemp(join(tmpdir(), "melian-prune-elsewhere-"));
	outside.push(elsewhere);
	await symlink(elsewhere, join(state, "tools", "linked"));
	await symlink(elsewhere, join(state, "graphs", "7".repeat(64)));
	await mkdir(join(state, "graphs", `.graph-${process.pid}-partial`), { recursive: true });
	await mkdir(join(state, "mutation", `.prune-${process.pid}-moved`), { recursive: true });
	await writeFile(join(state, "coverage", `x.${process.pid}.${crypto.randomUUID()}.tmp`), "x");
	const nearScratch = `x.${process.pid}.${crypto.randomUUID()}.tmpx`;
	await writeFile(join(state, "coverage", nearScratch), "x");
	for (const path of ["graphs", "coverage", "mutation", "tools", "ledger", "scripted"]) await age(path, 400 * day);
	const prune = await plan();
	expect(prune.entries).toEqual([]);
	expect([...prune.kept].sort()).toEqual(
		[
			"ledger",
			"notes.txt",
			"graphs/not-a-key",
			`graphs/${"7".repeat(64)}`,
			"coverage/not-a-key",
			`coverage/${nearScratch}`,
			"mutation/not-a-key",
		].sort(),
	);
	expect(prune.changesets).toEqual({ files: 2, bytes: 15 });
	expect(await exists("scripted/pull-3.sqlite")).toBe(true);
	expect(await exists("tools/stray")).toBe(true);
	expect(await exists("tools/linked")).toBe(true);
});

it("lists a name that only contains .sqlite as not recognised, and leaves it out of the changeset count", async () => {
	await writeFile(join(state, "pull-1.sqlite"), "12345");
	for (const name of ["pull-1.sqlite.bak", "pull-1.sqlite-walx", "pull-1.sqlite-journal"])
		await writeFile(join(state, name), "1");
	const prune = await plan();
	expect([...prune.kept].sort()).toEqual(["pull-1.sqlite-journal", "pull-1.sqlite-walx", "pull-1.sqlite.bak"]);
	expect(prune.changesets).toEqual({ files: 1, bytes: 5 });
});

it("leaves a changeset store byte for byte as it was, and the store reopens", async () => {
	const file = join(state, "pull-9.sqlite");
	const Note = defineDoc<{ text: string }>({
		kind: "melian.test-note",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({ text: "" }),
	});
	const fake = createFakeModels();
	const open = async () =>
		openHarness(await openSqliteStorage(file), { models: fake.models, registry: createRegistry() });
	const first = await open();
	let rootId: ConversationId | undefined;
	try {
		const root = await first.root(context, { agent: { model: fake.ref() } });
		rootId = root.id;
		await root.commit(async (tx) => {
			(await tx.doc(Note, root.id)).text = "kept";
		}, context);
		await graph("f".repeat(40), 30 * day);
		const before = await sqliteBytes();
		expect(Object.keys(before)).toContain("pull-9.sqlite");
		const prune = await plan();
		expect(prune.entries.map((entry) => entry.kind)).toEqual(["graph"]);
		expect(prune.changesets.files).toBe(1);
		await prune.apply();
		expect(await sqliteBytes()).toEqual(before);
	} finally {
		await first.close(context);
	}
	const second = await open();
	try {
		expect(await second.snapshot(Note, rootId!, context)).toEqual({ text: "kept" });
	} finally {
		await second.close(context);
	}
});

async function sqliteBytes(): Promise<Record<string, string>> {
	const bytes: Record<string, string> = {};
	for (const name of await readdir(state))
		if (name.includes(".sqlite")) bytes[name] = (await readFile(join(state, name))).toString("base64");
	return bytes;
}

it("removes nothing beside a live static run and names it", async () => {
	await graph("f".repeat(40), 30 * day);
	const path = await worktree(`melian-static pid ${process.pid}`);
	const prune = await plan();
	expect(prune.live).toEqual([{ pid: process.pid, worktree: path }]);
	expect(prune.entries).toHaveLength(1);
	expect(await prune.apply()).toEqual({ removed: [], live: [{ pid: process.pid, worktree: path }] });
	expect(await exists(prune.entries[0]?.paths[0] ?? "")).toBe(true);
});

it.each([
	["a dead process", () => `melian-static pid ${deadPid()}`],
	["pid 1", () => "melian-static pid 1"],
	["pid 0", () => "melian-static pid 0"],
	["another reason", () => `someone else pid ${process.pid}`],
	["a reason that only starts like a run's", () => `melian-static pid ${process.pid} extra`],
])("does not count a lock held by %s as a live run", async (_, reason) => {
	await graph("f".repeat(40), 30 * day);
	await worktree(reason());
	const prune = await plan();
	expect(prune.live).toEqual([]);
	expect((await prune.apply()).removed).toHaveLength(1);
});

it("stops when a static run starts after the plan was made", async () => {
	const first = await graph("f".repeat(40), 30 * day);
	const prune = await plan();
	expect(prune.live).toEqual([]);
	const path = await worktree(`melian-static pid ${process.pid}`);
	expect(await prune.apply()).toEqual({ removed: [], live: [{ pid: process.pid, worktree: path }] });
	expect(await exists(`graphs/${first}`)).toBe(true);
});

it("skips a path that is already gone when it applies", async () => {
	const key = await graph("f".repeat(40), 30 * day);
	const prune = await plan();
	await rm(join(state, "coverage", key), { recursive: true });
	expect((await prune.apply()).removed).toEqual(prune.entries);
	expect(await exists(`graphs/${key}`)).toBe(false);
});

it("ignores git's repository variables from the caller's environment", async () => {
	const key = await graph(tree("HEAD"), 30 * day);
	const prune = await plan({ env: { ...process.env, GIT_DIR: join(state, "nowhere"), GIT_WORK_TREE: state } });
	expect(prune.entries).toEqual([]);
	expect(await exists(`graphs/${key}`)).toBe(true);
});

it("plans nothing for a state directory that does not exist yet", async () => {
	const prune = await StorePrune.open(repo, { root: join(state, "absent"), now });
	expect(prune).toMatchObject({ entries: [], kept: [], changesets: { files: 0, bytes: 0 }, live: [] });
});

it("refuses when git cannot answer", async () => {
	const notRepo = await mkdtemp(join(tmpdir(), "melian-prune-norepo-"));
	outside.push(notRepo);
	await expect(StorePrune.open(notRepo, { root: state, now })).rejects.toMatchObject({
		name: "StorePruneError",
		code: "gitFailed",
	});
	await expect(StorePrune.open(notRepo, { root: state, now })).rejects.toBeInstanceOf(StorePruneError);
	await expect(StorePrune.open(notRepo, { root: state, now })).rejects.toThrow(
		/^git worktree failed: fatal: not a git repository[^\n]*$/,
	);
});

it("reads a graph whose entry.json is not a file as unreadable", async () => {
	const name = "9".repeat(64);
	await mkdir(join(state, "graphs", name, "entry.json"), { recursive: true });
	await age(`graphs/${name}`, 2 * day);
	expect(kinds(await plan())).toEqual([["unreadable graph", `graphs/${name}`]]);
});

it("refuses with the reason git could not start when no git is on the path it was given", async () => {
	const empty = await mkdtemp(join(tmpdir(), "melian-prune-path-"));
	outside.push(empty);
	await expect(plan({ env: { PATH: empty } })).rejects.toMatchObject({
		code: "gitFailed",
		message: "git worktree failed: spawn git ENOENT",
	});
});

it("counts a lock whose process it may not signal as a live run", async () => {
	await graph("f".repeat(40), 30 * day);
	const pid = deadPid();
	const path = await worktree(`melian-static pid ${pid}`);
	const kill = process.kill.bind(process);
	const spy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
		if (target !== pid) return kill(target, signal);
		throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
	});
	try {
		const prune = await plan();
		expect(prune.live).toEqual([{ pid, worktree: path }]);
		expect(await prune.apply()).toEqual({ removed: [], live: [{ pid, worktree: path }] });
	} finally {
		spy.mockRestore();
	}
});

it("keeps a cache directory whose name only contains a key", async () => {
	const names = [`x${"a".repeat(64)}`, `${"a".repeat(64)}x`];
	for (const folder of ["graphs", "coverage", "mutation"])
		for (const name of names) await mkdir(join(state, folder, name), { recursive: true });
	for (const folder of ["graphs", "coverage", "mutation"])
		for (const name of names) await age(`${folder}/${name}`, 400 * day);
	const prune = await plan();
	expect(prune.entries).toEqual([]);
	expect([...prune.kept].sort()).toEqual(
		["graphs", "coverage", "mutation"].flatMap((folder) => names.map((name) => `${folder}/${name}`)).sort(),
	);
});

it("keeps a file or a link where a cache folder belongs, and a file with a key's name", async () => {
	const elsewhere = await mkdtemp(join(tmpdir(), "melian-prune-elsewhere-"));
	outside.push(elsewhere);
	await writeFile(join(state, "coverage"), "x");
	await symlink(elsewhere, join(state, "mutation"));
	await mkdir(join(state, "graphs"), { recursive: true });
	await writeFile(join(state, "graphs", "8".repeat(64)), "x");
	await age(`graphs/${"8".repeat(64)}`, 400 * day);
	const prune = await plan();
	expect(prune.entries).toEqual([]);
	expect([...prune.kept].sort()).toEqual(["coverage", `graphs/${"8".repeat(64)}`, "mutation"]);
});

it("counts only a graph's own bytes when it has no coverage", async () => {
	const dead = await graph("f".repeat(40), 30 * day);
	await rm(join(state, "coverage", dead), { recursive: true });
	const graphBytes = Object.values(graphFiles).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
	const entryBytes = (await lstat(join(state, "graphs", dead, "entry.json"))).size;
	expect((await plan()).entries).toEqual([
		{ kind: "graph", paths: [`graphs/${dead}`, `coverage/${dead}`], bytes: graphBytes + entryBytes },
	]);
});

it("refuses when a path it measures cannot be read for a reason other than being gone", async () => {
	const dead = await graph("f".repeat(40), 30 * day);
	await rm(join(state, "coverage"), { recursive: true });
	await writeFile(join(state, "coverage"), "x");
	const error = await plan().catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(StorePruneError);
	const cause = (error as StorePruneError).cause as NodeJS.ErrnoException;
	expect(cause.code).toBe("ENOTDIR");
	expect(error).toMatchObject({
		code: "unreadable",
		message: `Melian cannot read its state directory at ${state}: ${cause.message}`,
	});
	expect(await exists(`graphs/${dead}`)).toBe(true);
});

it("refuses a state directory that is a file inside, rather than planning nothing", async () => {
	await rm(state, { recursive: true });
	await writeFile(state, "x");
	await expect(plan()).rejects.toMatchObject({ code: "unreadable" });
});

it("reads an entry.json of exactly the size limit and refuses one a byte past it", async () => {
	const limit = 1024 * 1024;
	const snapshot = GraphSnapshot.create(
		{ tree: "f".repeat(40), version: "0.4.27", binary: "b".repeat(64), config: "c".repeat(64) },
		graphFiles,
		new Date(now - 30 * day),
	);
	const name = snapshot.key;
	const json = JSON.stringify(snapshot.toJSON());
	await mkdir(join(state, "graphs", name), { recursive: true });
	await writeFile(join(state, "graphs", name, "entry.json"), json.padEnd(limit, " "));
	await age(`graphs/${name}`, 2 * day);
	expect(kinds(await plan())).toEqual([["graph", `graphs/${name}`, `coverage/${name}`]]);
	await writeFile(join(state, "graphs", name, "entry.json"), json.padEnd(limit + 1, " "));
	await age(`graphs/${name}`, 2 * day);
	expect(kinds(await plan())).toEqual([["unreadable graph", `graphs/${name}`]]);
});

it("lists entries in name order, whatever order the directory returns", async () => {
	const names = ["e", "c", "f", "a", "b", "d"].map((letter) => letter.repeat(64));
	for (const name of names) await mkdir(join(state, "coverage", name), { recursive: true });
	expect(kinds(await plan())).toEqual([...names].sort().map((name) => ["orphan coverage", `coverage/${name}`]));
});

it("orders names as JavaScript compares them, not as the directory's bytes do", async () => {
	// UTF-8 bytes put U+FFFD before U+10000; UTF-16 code units put it after.
	const names = ["\u{FFFD}", "\u{10000}"];
	for (const name of names) await mkdir(join(state, name), { recursive: true });
	expect((await plan()).kept).toEqual(["\u{10000}", "\u{FFFD}"]);
});

it("refuses a graph whose entry it may not read, rather than reading it as unreadable", async (test) => {
	if (process.getuid?.() === 0) {
		process.stderr.write("skipped: root reads a file of mode 0\n");
		test.skip();
	}
	const name = "b".repeat(64);
	await mkdir(join(state, "graphs", name), { recursive: true });
	await writeFile(join(state, "graphs", name, "entry.json"), "{}");
	await chmod(join(state, "graphs", name, "entry.json"), 0);
	await age(`graphs/${name}`, 2 * day);
	await expect(plan()).rejects.toMatchObject({ code: "unreadable" });
	expect(await exists(`graphs/${name}`)).toBe(true);
});

it("never removes a changeset, a scripted store or a name it does not recognise, whatever changes after the plan", async () => {
	const dead = await graph("f".repeat(40), 8 * day);
	const orphan = `coverage/${"a".repeat(64)}`;
	await mkdir(join(state, orphan), { recursive: true });
	await writeFile(join(state, orphan, "index.json"), "12345");
	const prune = await plan();
	expect(kinds(prune)).toEqual([
		["graph", `graphs/${dead}`, `coverage/${dead}`],
		["orphan coverage", orphan],
	]);
	const elsewhere = await mkdtemp(join(tmpdir(), "melian-prune-elsewhere-"));
	outside.push(elsewhere);
	await writeFile(join(elsewhere, "pull-9.sqlite"), "theirs");
	await rm(join(state, orphan), { recursive: true });
	await symlink(elsewhere, join(state, orphan));
	const written = {
		"pull-1.sqlite": "changeset",
		"pull-1.sqlite-wal": "wal",
		"pull-1.sqlite-shm": "shm",
		"scripted/pull-2.sqlite": "scripted",
		"notes.txt": "mine",
		"ledger/entry": "ledger",
	};
	for (const [path, text] of Object.entries(written)) {
		await mkdir(join(state, path, ".."), { recursive: true });
		await writeFile(join(state, path), text);
	}
	expect(await prune.apply()).toEqual({ removed: prune.entries, live: [] });
	for (const [path, text] of Object.entries(written)) expect(await readFile(join(state, path), "utf8")).toBe(text);
	expect(await readFile(join(elsewhere, "pull-9.sqlite"), "utf8")).toBe("theirs");
	expect(await exists(orphan)).toBe(false);
	expect(await exists(`graphs/${dead}`)).toBe(false);
});

it("keeps an old graph whose tree only a branch that is not checked out holds", async () => {
	const kept = commit(repo, { "k.ts": "export const k = 1;\n" });
	gitIn(repo, "branch", "kept", kept);
	gitIn(repo, "reset", "--quiet", "--hard", "HEAD~1");
	const key = await graph(tree(kept), 30 * day);
	expect((await plan()).entries).toEqual([]);
	expect(await exists(`graphs/${key}`)).toBe(true);
});

it("keeps a file with a key's name in coverage and mutation", async () => {
	for (const folder of ["coverage", "mutation"]) {
		await mkdir(join(state, folder), { recursive: true });
		await writeFile(join(state, folder, "9".repeat(64)), "x");
		await age(`${folder}/${"9".repeat(64)}`, 400 * day);
	}
	const prune = await plan();
	expect(prune.entries).toEqual([]);
	expect(prune.kept).toEqual([`coverage/${"9".repeat(64)}`, `mutation/${"9".repeat(64)}`]);
});

it("leaves a scratch name under tools to CacheScratch", async () => {
	await mkdir(join(state, "tools", `.fetch-${process.pid}-partial`), { recursive: true });
	const prune = await plan();
	expect(prune.entries).toEqual([]);
	expect(prune.kept).toEqual([]);
});

it("reports a run that was live at the plan even when there is nothing to remove", async () => {
	const path = await worktree(`melian-static pid ${process.pid}`);
	const prune = await plan();
	expect(prune.entries).toEqual([]);
	expect(await prune.apply()).toEqual({ removed: [], live: [{ pid: process.pid, worktree: path }] });
});

it("removes an old mutation partition when it applies", async () => {
	const name = "3".repeat(64);
	await mkdir(join(state, "mutation", name), { recursive: true });
	const newest = await age(`mutation/${name}`, 20 * day);
	const prune = await plan({ now: newest + 20 * day });
	expect(kinds(prune)).toEqual([["mutation partition", `mutation/${name}`]]);
	expect(await prune.apply()).toEqual({ removed: prune.entries, live: [] });
	expect(await exists(`mutation/${name}`)).toBe(false);
});

it("keeps a planned mutation partition written exactly fourteen days before the plan when it applies", async () => {
	const name = "4".repeat(64);
	await mkdir(join(state, "mutation", name), { recursive: true });
	const newest = await age(`mutation/${name}`, 14 * day);
	await age(`mutation/${name}`, 30 * day);
	const prune = await plan({ now: newest + 14 * day });
	expect(kinds(prune)).toEqual([["mutation partition", `mutation/${name}`]]);
	expect(await age(`mutation/${name}`, 14 * day)).toBe(newest);
	expect(await prune.apply()).toEqual({ removed: [], live: [] });
	expect(await exists(`mutation/${name}`)).toBe(true);
});

it("does not report an entry whose cache folder became a link after the plan, and leaves what the link names", async () => {
	const key = await graph("f".repeat(40), 30 * day);
	const prune = await plan();
	const elsewhere = await mkdtemp(join(tmpdir(), "melian-prune-elsewhere-"));
	outside.push(elsewhere);
	await mkdir(join(elsewhere, key));
	await writeFile(join(elsewhere, key, "index.json"), "theirs");
	await rm(join(state, "coverage"), { recursive: true });
	await symlink(elsewhere, join(state, "coverage"));
	expect(await prune.apply()).toEqual({ removed: [], live: [] });
	expect(await readFile(join(elsewhere, key, "index.json"), "utf8")).toBe("theirs");
	expect(await readdir(elsewhere)).toEqual([key]);
	expect(await exists(`graphs/${key}`)).toBe(false);
});

it("removes and reports nothing through a state directory swapped for a link after the plan", async () => {
	const key = await graph("f".repeat(40), 30 * day);
	const prune = await plan();
	const moved = `${state}-moved`;
	outside.push(moved);
	await rename(state, moved);
	await symlink(moved, state);
	expect(await prune.apply()).toEqual({ removed: [], live: [] });
	expect(await readdir(join(moved, "graphs"))).toEqual([key]);
	expect(await readdir(join(moved, "coverage"))).toEqual([key]);
});

it("refuses a state directory swapped for a file after the plan", async () => {
	const key = await graph("f".repeat(40), 30 * day);
	const prune = await plan();
	const moved = `${state}-moved`;
	outside.push(moved);
	await rename(state, moved);
	await writeFile(state, "x");
	await expect(prune.apply()).rejects.toMatchObject({ code: "ENOTDIR" });
	expect(await readdir(join(moved, "graphs"))).toEqual([key]);
});

it("stops at a removal that fails for a reason other than the path being gone", async () => {
	const key = await graph("f".repeat(40), 30 * day);
	const prune = await plan();
	await rm(join(state, "graphs"), { recursive: true });
	await writeFile(join(state, "graphs"), "x");
	await expect(prune.apply()).rejects.toMatchObject({ code: "ENOTDIR" });
	expect(await exists(`coverage/${key}`)).toBe(true);
});

it("keeps a file at a removed graph's coverage path, which it lists as not recognised", async () => {
	const dead = await graph("f".repeat(40), 7 * day + 1);
	await rm(join(state, "coverage", dead), { recursive: true });
	await writeFile(join(state, "coverage", dead), "user notes");
	const prune = await plan();
	expect(prune.entries).toEqual([{ kind: "graph", paths: [`graphs/${dead}`], bytes: expect.any(Number) }]);
	expect(prune.kept).toEqual([`coverage/${dead}`]);
	await prune.apply();
	expect(await readFile(join(state, "coverage", dead), "utf8")).toBe("user notes");
	expect(await exists(`graphs/${dead}`)).toBe(false);
});

it("keeps a link at a removed graph's coverage path, which it lists as not recognised", async () => {
	const dead = await graph("f".repeat(40), 7 * day + 1);
	const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "melian-prune-elsewhere-")));
	outside.push(elsewhere);
	await rm(join(state, "coverage", dead), { recursive: true });
	await symlink(elsewhere, join(state, "coverage", dead));
	const prune = await plan();
	expect(prune.entries).toEqual([{ kind: "graph", paths: [`graphs/${dead}`], bytes: expect.any(Number) }]);
	expect(prune.kept).toEqual([`coverage/${dead}`]);
	await prune.apply();
	expect((await lstat(join(state, "coverage", dead))).isSymbolicLink()).toBe(true);
});

it("refuses a state directory that is itself a link, naming it, and removes nothing", async () => {
	const real = `${state}-real`;
	outside.push(real);
	await rename(state, real);
	await symlink(real, state);
	const dead = await graph("f".repeat(40), 30 * day);
	await writeFile(join(state, "pull-1.sqlite"), "changeset");
	await expect(plan()).rejects.toEqual(
		new StorePruneError(
			"linked",
			`Melian's state directory at ${state} is a link, and prune does not follow a linked state directory. Set MELIAN_STATE_DIR to a directory of your choice, move the files the link points to into the state directory melian doctor then names, and run prune again`,
		),
	);
	expect(await readdir(join(real, "graphs"))).toEqual([dead]);
	expect(await readdir(join(real, "coverage"))).toEqual([dead]);
});

it("removes on an unchanged store exactly what the plan lists, of every kind", async () => {
	const dead = await graph("f".repeat(40), 30 * day);
	await mkdir(join(state, "graphs", "1".repeat(64)), { recursive: true });
	await age(`graphs/${"1".repeat(64)}`, 2 * day);
	await mkdir(join(state, "coverage", "2".repeat(64)), { recursive: true });
	await mkdir(join(state, "mutation", "3".repeat(64)), { recursive: true });
	await age(`mutation/${"3".repeat(64)}`, 20 * day);
	await writeFile(join(state, "pull-1.sqlite"), "changeset");
	const prune = await plan();
	expect(kinds(prune)).toEqual([
		["unreadable graph", `graphs/${"1".repeat(64)}`],
		["graph", `graphs/${dead}`, `coverage/${dead}`],
		["orphan coverage", `coverage/${"2".repeat(64)}`],
		["mutation partition", `mutation/${"3".repeat(64)}`],
	]);
	expect(prune.changesets).toEqual({ files: 1, bytes: 9 });
	expect(await prune.apply()).toEqual({ removed: prune.entries, live: [] });
	for (const entry of prune.entries) for (const path of entry.paths) expect(await exists(path)).toBe(false);
	expect(await readFile(join(state, "pull-1.sqlite"), "utf8")).toBe("changeset");
});

it("plans and removes a graph alone when its coverage folder is a link, and reports what it removed", async () => {
	const dead = await graph("f".repeat(40), 30 * day);
	const real = `${state}-coverage`;
	outside.push(real);
	await rename(join(state, "coverage"), real);
	await symlink(real, join(state, "coverage"));
	const prune = await plan();
	expect(prune.entries).toEqual([{ kind: "graph", paths: [`graphs/${dead}`], bytes: expect.any(Number) }]);
	expect(prune.kept).toEqual(["coverage"]);
	expect(await prune.apply()).toEqual({ removed: prune.entries, live: [] });
	expect(await exists(`graphs/${dead}`)).toBe(false);
	expect(await readdir(real)).toEqual([dead]);
});

it("takes a graph's coverage with it when another cache folder is a link", async () => {
	const dead = await graph("f".repeat(40), 30 * day);
	const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "melian-prune-elsewhere-")));
	outside.push(elsewhere);
	await symlink(elsewhere, join(state, "mutation"));
	expect(kinds(await plan())).toEqual([["graph", `graphs/${dead}`, `coverage/${dead}`]]);
});
