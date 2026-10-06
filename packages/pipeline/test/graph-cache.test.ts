import type * as filesystem from "node:fs/promises";
import { type FileHandle, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphSnapshot, graphFiles } from "@melian-agent/core";
import { GraphCache } from "@melian-agent/pipeline";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof filesystem>();
	return { ...original, open: vi.fn(original.open), rename: vi.fn(original.rename) };
});

let root: string;
afterEach(async () => {
	vi.restoreAllMocks();
	if (root) await rm(root, { recursive: true, force: true });
});
const parts = { tree: "a".repeat(40), version: "0.4.27", binary: "b".repeat(64), config: "c".repeat(64) };
const files = {
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

it.each(["ENOENT", "EACCES"])("handles a rejected-entry rename failure with %s", async (code) => {
	root = await mkdtemp(join(tmpdir(), "melian-graph-race-"));
	const cache = await GraphCache.open(root);
	const snapshot = GraphSnapshot.create(parts, files);
	await cache.store(snapshot);
	const directory = join(root, "graphs", snapshot.key);
	await writeFile(join(directory, "facts.jsonl"), "corrupt");
	const original = vi.mocked(rename).getMockImplementation()!;
	const failure = Object.assign(new Error("rejected rename failed"), { code });
	vi.mocked(rename).mockImplementation(async (from, to) => {
		if (from === directory) {
			if (code === "ENOENT") await rm(directory, { recursive: true });
			throw failure;
		}
		return original(from, to);
	});
	if (code === "ENOENT") {
		await cache.store(snapshot);
		expect((await cache.read(parts))?.key).toBe(snapshot.key);
	} else await expect(cache.store(snapshot)).rejects.toBe(failure);
	expect((await readdir(join(root, "graphs"))).filter((path) => path.startsWith(".graph-"))).toEqual([]);
});

it.each([false, true])("accepts a failed replacement only with a valid concurrent winner: %s", async (winner) => {
	root = await mkdtemp(join(tmpdir(), "melian-graph-winner-"));
	const cache = await GraphCache.open(root);
	const snapshot = GraphSnapshot.create(parts, files);
	await cache.store(snapshot);
	const directory = join(root, "graphs", snapshot.key);
	await writeFile(join(directory, "facts.jsonl"), "corrupt");
	const original = vi.mocked(rename).getMockImplementation()!;
	const failure = new Error("replacement failed");
	let publications = 0;
	vi.mocked(rename).mockImplementation(async (from, to) => {
		if (to === directory && ++publications === 2) {
			if (winner) {
				await mkdir(directory);
				for (const [name, text] of Object.entries(snapshot.files())) await writeFile(join(directory, name), text);
				await writeFile(join(directory, "entry.json"), JSON.stringify(snapshot.toJSON()));
			}
			throw failure;
		}
		return original(from, to);
	});
	if (winner) {
		await cache.store(snapshot);
		expect((await cache.read(parts))?.key).toBe(snapshot.key);
	} else await expect(cache.store(snapshot)).rejects.toBe(failure);
	expect((await readdir(join(root, "graphs"))).filter((path) => path.startsWith(".graph-"))).toEqual([]);
});

it("closes every bounded graph reader", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-graph-close-"));
	const cache = await GraphCache.open(root);
	const snapshot = GraphSnapshot.create(parts, files);
	await cache.store(snapshot);
	const original = vi.mocked(open).getMockImplementation()!;
	const handles: FileHandle[] = [];
	vi.mocked(open).mockImplementation(async (...args) => {
		const handle = await original(...args);
		vi.spyOn(handle, "close");
		handles.push(handle);
		return handle;
	});
	try {
		expect((await cache.read(parts))?.key).toBe(snapshot.key);
		expect(handles).toHaveLength(6);
		for (const handle of handles) expect(handle.close).toHaveBeenCalledOnce();
	} finally {
		for (const handle of handles) await handle.close();
	}
});
it.each([...graphFiles, "entry.json"])("rejects byte-identical symlinked %s artifacts", async (name) => {
	root = await mkdtemp(join(tmpdir(), "melian-graph-symlink-"));
	const cache = await GraphCache.open(root);
	const snapshot = GraphSnapshot.create(parts, files);
	await cache.store(snapshot);
	expect((await cache.read(parts))?.files()).toEqual(files);
	const artifact = join(root, "graphs", snapshot.key, name);
	const outside = join(root, `${name}.outside`);
	const bytes = await readFile(artifact);
	await rename(artifact, outside);
	await symlink(outside, artifact);
	expect(await readFile(artifact)).toEqual(bytes);
	expect(await cache.read(parts)).toBeUndefined();
	expect(await readFile(outside)).toEqual(bytes);
	await rm(artifact);
	await rename(outside, artifact);
	expect((await cache.read(parts))?.files()).toEqual(files);
});

it("publishes once under concurrency and shares an identical tree across commits", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-graph-"));
	const cache = await GraphCache.open(root);
	const snapshot = GraphSnapshot.create(parts, files);
	expect(await cache.read(parts)).toBeUndefined();
	await Promise.all([cache.store(snapshot), cache.store(snapshot), cache.store(snapshot)]);
	expect((await cache.read(parts))?.files()).toEqual(files);
	expect((await cache.read(parts))?.snapshotId).toBe(snapshot.snapshotId);
	for (const changed of [
		{ tree: "e".repeat(40) },
		{ version: "0.4.28" },
		{ binary: "e".repeat(64) },
		{ config: "e".repeat(64) },
	])
		expect(await cache.read({ ...parts, ...changed })).toBeUndefined();
});
it("recomputes corrupt and incompatible entries, ignoring abandoned temporary directories", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-graph-"));
	const cache = await GraphCache.open(root);
	const snapshot = GraphSnapshot.create(parts, files);
	await cache.store(snapshot);
	const directory = join(root, "graphs", snapshot.key);
	await writeFile(join(directory, "facts.jsonl"), "swapped");
	expect(await cache.read(parts)).toBeUndefined();
	await cache.store(snapshot);
	expect((await cache.read(parts))?.files()).toEqual(files);
	const entry = JSON.parse(await readFile(join(directory, "entry.json"), "utf8"));
	entry.format_version = 2;
	await writeFile(join(directory, "entry.json"), JSON.stringify(entry));
	expect(await cache.read(parts)).toBeUndefined();
	expect(() => GraphSnapshot.create(parts, { ...files, "facts.jsonl": "{}" })).toThrow();
	expect(() => GraphSnapshot.create(parts, { ...files, "receipt.json": '{"format_version":2}' })).toThrow();
});

it("repairs a regular file occupying the graph entry directory", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-graph-file-"));
	const cache = await GraphCache.open(root);
	const snapshot = GraphSnapshot.create(parts, files);
	await writeFile(join(root, "graphs", snapshot.key), "corrupt");
	expect(await cache.read(parts)).toBeUndefined();
	await cache.store(snapshot);
	expect((await cache.read(parts))?.files()).toEqual(files);
});
