import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphSnapshot, ToolManifest } from "@melian-agent/core";
import { StorePrune, StorePruneError } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it } from "vitest";
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
const manifest = ToolManifest.parse(
	JSON.stringify({
		format_version: 1,
		tools: {
			enola: {
				version: "0.0.1",
				source: { repository: "test/enola", tag: "v0.0.1" },
				published: "2020-01-01T00:00:00Z",
				platforms: {
					"darwin-arm64": {
						url: "https://github.com/test/enola/releases/download/v0.0.1/e.tar.gz",
						sha256: digest,
					},
				},
			},
		},
		misses: [],
	}),
);
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
		manifest,
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
	const graphBytes = Object.values(graphFiles).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
	const entryBytes = (await lstat(join(state, "graphs", dead, "entry.json"))).size;
	expect(prune.entries[0]?.bytes).toBe(graphBytes + entryBytes + 10);
	expect(await prune.apply()).toEqual({ removed: prune.entries, live: [] });
	expect(await exists(`graphs/${dead}`)).toBe(false);
	expect(await exists(`coverage/${dead}`)).toBe(false);
	expect((await readdir(join(state, "graphs"))).filter((name) => name.startsWith(".prune-"))).toEqual([]);
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

it("keeps every pinned tool entry and removes an unpinned one at the first level that fails", async () => {
	const pinned = `tools/enola/0.0.1/darwin-arm64/${digest}`;
	const unpinned = [
		`tools/enola/0.0.1/darwin-arm64/${"f".repeat(64)}`,
		"tools/enola/0.0.1/linux-x64",
		"tools/enola/0.0.2",
		"tools/other",
	];
	for (const path of [pinned, ...unpinned]) {
		await mkdir(join(state, path), { recursive: true });
		await writeFile(join(state, path, "enola"), "12345");
	}
	await age(pinned, 400 * day);
	const prune = await plan();
	expect(prune.entries).toEqual(unpinned.map((path) => ({ kind: "unpinned tool", paths: [path], bytes: 5 })));
	await prune.apply();
	expect(await exists(`${pinned}/enola`)).toBe(true);
	for (const path of unpinned) expect(await exists(path)).toBe(false);
});

it("removes a tool directory a name like a prototype property holds, since the manifest pins none", async () => {
	await mkdir(join(state, "tools", "constructor"), { recursive: true });
	await mkdir(join(state, "tools", "enola", "0.0.1", "toString"), { recursive: true });
	expect(kinds(await plan())).toEqual([
		["unpinned tool", "tools/constructor"],
		["unpinned tool", "tools/enola/0.0.1/toString"],
	]);
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
			"mutation/not-a-key",
			"tools/stray",
			"tools/linked",
		].sort(),
	);
	expect(prune.changesets).toEqual({ files: 2, bytes: 15 });
	expect(await exists("scripted/pull-3.sqlite")).toBe(true);
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
	const prune = await StorePrune.open(repo, { root: join(state, "absent"), manifest, now });
	expect(prune).toMatchObject({ entries: [], kept: [], changesets: { files: 0, bytes: 0 }, live: [] });
});

it("refuses when git cannot answer", async () => {
	const notRepo = await mkdtemp(join(tmpdir(), "melian-prune-norepo-"));
	outside.push(notRepo);
	await expect(StorePrune.open(notRepo, { root: state, manifest, now })).rejects.toMatchObject({
		name: "StorePruneError",
		code: "gitFailed",
	});
	await expect(StorePrune.open(notRepo, { root: state, manifest, now })).rejects.toBeInstanceOf(StorePruneError);
});

it("reads a graph whose entry.json is not a file as unreadable", async () => {
	const name = "9".repeat(64);
	await mkdir(join(state, "graphs", name, "entry.json"), { recursive: true });
	await age(`graphs/${name}`, 2 * day);
	expect(kinds(await plan())).toEqual([["unreadable graph", `graphs/${name}`]]);
});
