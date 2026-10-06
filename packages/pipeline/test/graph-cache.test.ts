import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphSnapshot } from "@melian-agent/core";
import { GraphCache } from "@melian-agent/pipeline";
import { afterEach, expect, it } from "vitest";

let root: string;
afterEach(async () => {
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
