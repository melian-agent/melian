import { createHash } from "node:crypto";
import type * as filesystem from "node:fs/promises";
import { type FileHandle, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphCoverage, GraphSnapshot, TestCoverage } from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoverageCache } from "../src/coverage-cache.ts";
import { coverageCompiler, coverageMatcher } from "../src/coverage-identity.ts";
import { GraphCache } from "../src/graph-cache.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof filesystem>();
	return { ...original, open: vi.fn(original.open), rename: vi.fn(original.rename) };
});

let root: string;
let cache: CoverageCache;
const parts = { tree: "a".repeat(40), version: "0.4.27", binary: "b".repeat(64), config: "c".repeat(64) };
const artifact = TestCoverage.unavailable(parts.tree, parts.version);
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "melian-coverage-cache-"));
	await (await GraphCache.open(root)).store(
		GraphSnapshot.create(parts, {
			"facts.jsonl": "",
			"insights.json": "[]",
			"receipt.json": JSON.stringify({
				format_version: 1,
				enola_version: parts.version,
				snapshot_id: `sha256:${"d".repeat(64)}`,
			}),
		}),
	);
	cache = await CoverageCache.open(root);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

it.each(["index", "artifact"])("rejects a byte-identical symlinked coverage %s", async (kind) => {
	await cache.store(parts, artifact);
	const directory = join(root, "coverage", GraphSnapshot.key(parts));
	const name = (await readdir(directory)).find((file) => file.endsWith(".json"))!;
	const path = kind === "index" ? join(directory, name) : join(directory, "artifacts", `test-${artifact.id}.json`);
	const outside = join(root, "outside.json");
	const bytes = await readFile(path);
	await rename(path, outside);
	await symlink(outside, path);
	expect(await cache.read(parts, "test")).toBeUndefined();
	expect(await readFile(outside)).toEqual(bytes);
	await rm(path);
	await rename(outside, path);
	expect((await cache.read(parts, "test"))?.id).toBe(artifact.id);
});

it.each([false, true])("closes coverage handles after a stat refusal: %s", async (fail) => {
	await cache.store(parts, artifact);
	const original = vi.mocked(open).getMockImplementation()!;
	const handles: FileHandle[] = [];
	vi.mocked(open).mockImplementation(async (...args) => {
		const handle = await original(...args);
		if (String(args[0]).includes("/coverage/")) {
			vi.spyOn(handle, "close");
			if (fail) vi.spyOn(handle, "stat").mockRejectedValue(new Error("stat failed"));
			handles.push(handle);
		}
		return handle;
	});
	try {
		expect((await cache.read(parts, "test", { id: artifact.id }))?.id).toBe(fail ? undefined : artifact.id);
		expect(handles).toHaveLength(1);
		expect(handles[0]!.close).toHaveBeenCalledOnce();
	} finally {
		for (const handle of handles) await handle.close();
	}
});

it("removes partial coverage files when publishing fails", async () => {
	const failure = new Error("rename failed");
	vi.mocked(rename).mockRejectedValueOnce(failure);
	await expect(cache.store(parts, artifact)).rejects.toBe(failure);
	const paths = await readdir(join(root, "coverage"), { recursive: true });
	expect(paths.filter((path) => path.endsWith(".tmp"))).toEqual([]);
});

it("records an explicit matcher version in the producer index", async () => {
	const custom = await CoverageCache.open(root, { matcher: "custom-matcher@2" });
	await custom.store(
		parts,
		GraphCoverage.compute(
			parts.tree,
			parts.version,
			{ format_version: 1, compiler: coverageCompiler, files: [], symbols: [] },
			{ call: () => undefined, import: () => undefined },
		),
	);
	const directory = join(root, "coverage", GraphSnapshot.key(parts));
	const index = (await readdir(directory)).find((path) => path.startsWith("graph-"))!;
	expect(JSON.parse(await readFile(join(directory, index), "utf8"))).toMatchObject({
		producer: { matcher: "custom-matcher@2" },
	});
});

it.each([
	[0, true],
	[1, false],
])("reads a coverage artifact %i bytes over the 16 MiB limit as a hit: %s", async (over, hit) => {
	vi.mocked(open).mockReset();
	await cache.store(parts, artifact);
	const path = join(root, "coverage", GraphSnapshot.key(parts), "artifacts", `test-${artifact.id}.json`);
	const text = await readFile(path, "utf8");
	await writeFile(path, text + " ".repeat(16 * 1024 * 1024 + over - Buffer.byteLength(text)));
	expect((await cache.read(parts, "test", { id: artifact.id }))?.id).toBe(hit ? artifact.id : undefined);
});

it("misses an automatic lookup whose indexed graph coverage came from another compiler", async () => {
	vi.mocked(open).mockReset();
	const other = await CoverageCache.open(root, { compiler: "other-compiler@1" });
	const stale = GraphCoverage.compute(
		parts.tree,
		parts.version,
		{ format_version: 1, compiler: "other-compiler@1", files: [], symbols: [] },
		{ call: () => undefined, import: () => undefined },
	);
	await other.store(parts, stale);
	const directory = join(root, "coverage", GraphSnapshot.key(parts));
	const producer = { schema: 1, compiler: coverageCompiler, matcher: coverageMatcher };
	const key = createHash("sha256").update(JSON.stringify(producer)).digest("hex");
	await writeFile(join(directory, `graph-${key}.json`), JSON.stringify({ format_version: 1, producer, id: stale.id }));
	expect(await cache.read(parts, "graph")).toBeUndefined();
	expect((await cache.read(parts, "graph", { id: stale.id }))?.id).toBe(stale.id);
});
