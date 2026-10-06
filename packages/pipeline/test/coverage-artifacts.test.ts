import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangedFile, GraphCoverage, GraphSnapshot, ReviewCoverage, TestCoverage } from "@melian-agent/core";
import { CoverageCache, GraphCache, ReviewTranscript } from "@melian-agent/pipeline";
import { afterEach, expect, it } from "vitest";
import { coverageCompiler, coverageMatcher } from "../src/coverage-identity.ts";
import type { EntryRecord, Message } from "../src/harness.ts";

let root: string;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});
const parts = { tree: "a".repeat(40), version: "0.4.27", binary: "b".repeat(64), config: "c".repeat(64) };
const changed: ChangedFile = {
	path: "a.ts",
	status: "modified",
	binary: false,
	hunks: [{ file: "a.ts", index: 0, oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, header: "", text: "" }],
};
function entry(message: Message, id: number): EntryRecord {
	return {
		id: id as EntryRecord["id"],
		conversationId: 1 as EntryRecord["conversationId"],
		kind: "test",
		model: [message],
	};
}
it("counts delivered lines and search matches, excluding failed and refused reads", () => {
	const calls = entry(
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "read", name: "read_file", arguments: { path: "a.ts", maxLines: 2000 } },
				{ type: "toolCall", id: "refused", name: "read_file", arguments: { path: "b.ts" } },
				{ type: "toolCall", id: "search", name: "search", arguments: { pattern: "x" } },
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		},
		1,
	);
	const result = (id: string, text: string, n: number, isError = false) =>
		entry(
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "read_file",
				content: [{ type: "text", text }],
				isError,
				timestamp: 0,
			},
			n,
		);
	const transcript = ReviewTranscript.from(
		[
			result("search", '<untrusted-N label="search">\nb.ts:9: x\n</untrusted-N>', 4),
			result("refused", "[not run: budget ended]", 3),
			result("read", '<untrusted-N label="file">\n2\tx\n3\ty\n</untrusted-N>\n[lines 4 onward not shown]', 2),
			calls,
		],
		"lens",
		["a.ts", "b.ts", "c.ts"],
		"N",
	);
	const artifact = ReviewCoverage.compute(
		parts.tree,
		parts.version,
		["lens"],
		[changed, { ...changed, path: "b.ts", hunks: [] }, { ...changed, path: "c.ts", hunks: [] }],
		transcript.reads(),
		[{ file: "a.ts", line: 1, column: 1, endLine: 4, name: "Alpha", kind: "function" }],
	);
	const files = artifact.toJSON().lenses[0]!.files.filter((file) => file.revision === "head");
	expect(files.map((file) => file.status)).toEqual(["read", "searched only", "not read"]);
	expect(files[0]).toMatchObject({
		lines: [
			{ start: 2, end: 2 },
			{ start: 3, end: 3 },
		],
		hunks: [0],
		functions: [{ name: "Alpha", line: 1 }],
	});
	expect(
		ReviewTranscript.from(
			[result("read", '<untrusted-N label="file">\n2\tx\n</untrusted-N>', 5, true), calls],
			"lens",
			["a.ts"],
			"N",
		).reads(),
	).toEqual([]);
	expect(() => ReviewCoverage.from({ ...artifact.toJSON(), extra: true })).toThrow();
	expect(() =>
		TestCoverage.from({ format_version: 1, tree: parts.tree, version: parts.version, status: "available" }),
	).toThrow();
});
it("stores three content identities beside a verified graph and treats corruption as absent", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-artifacts-"));
	const graph = GraphSnapshot.create(parts, {
		"facts.jsonl": "",
		"insights.json": "[]",
		"receipt.json": JSON.stringify({
			format_version: 1,
			enola_version: parts.version,
			snapshot_id: `sha256:${"d".repeat(64)}`,
		}),
	});
	await (await GraphCache.open(root)).store(graph);
	const cache = await CoverageCache.open(root);
	const measured = GraphCoverage.compute(
		parts.tree,
		parts.version,
		{ format_version: 1, compiler: coverageCompiler, files: [], symbols: [] },
		{ call: () => undefined, import: () => undefined },
	);
	const review = ReviewCoverage.compute(parts.tree, parts.version, [], [], []),
		test = TestCoverage.unavailable(parts.tree, parts.version);
	for (const [name, artifact] of [
		["graph", measured],
		["review", review],
		["test", test],
	] as const) {
		expect(await cache.store(parts, artifact)).toBe(artifact.id);
		expect((await cache.read(parts, name, { id: artifact.id }))?.id).toBe(artifact.id);
	}
	await writeFile(join(root, "graphs", graph.key, "facts.jsonl"), "corrupt");
	await (await GraphCache.open(root)).store(graph);
	for (const [name, artifact] of [
		["graph", measured],
		["review", review],
		["test", test],
	] as const)
		expect((await cache.read(parts, name, { id: artifact.id }))?.id).toBe(artifact.id);
	expect(test.toJSON()).toMatchObject({
		status: "unavailable",
		reason: expect.stringContaining("container isolation"),
	});
	await writeFile(join(root, "coverage", graph.key, "artifacts", `review-${review.id}.json`), "{}");
	expect(await cache.read(parts, "review", { id: review.id })).toBeUndefined();
	await expect(cache.store({ ...parts, tree: "e".repeat(40) }, review)).rejects.toThrow();
	const oversized = ReviewCoverage.compute(parts.tree, parts.version, ["x".repeat(16 * 1024 * 1024)], [], []);
	await expect(cache.store(parts, oversized)).rejects.toThrow("16 MiB cache limit");
});

it("retains distinct repeat-review artifacts by their recorded content IDs", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-coverage-repeat-"));
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
	const cache = await CoverageCache.open(root);
	const first = ReviewCoverage.compute(parts.tree, parts.version, ["lens"], [changed], []);
	const second = ReviewCoverage.compute(
		parts.tree,
		parts.version,
		["lens"],
		[changed],
		[{ lens: "lens", path: "a.ts", revision: "head", kind: "read", lines: [2] }],
	);
	await cache.store(parts, first, { review: "first-run" });
	await cache.store(parts, second, { review: "second-run" });
	expect((await cache.read(parts, "review", { id: first.id }))?.toJSON()).toEqual(first.toJSON());
	expect((await cache.read(parts, "review", { id: second.id }))?.toJSON()).toEqual(second.toJSON());
	expect((await cache.read(parts, "review", { review: "first-run" }))?.id).toBe(first.id);
	expect((await cache.read(parts, "review", { review: "second-run" }))?.id).toBe(second.id);
	expect(await cache.read(parts, "review")).toBeUndefined();
});

it("invalidates graph coverage on compiler or matcher upgrades while retaining evidence by ID", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-coverage-producer-"));
	const graph = GraphSnapshot.create(parts, {
		"facts.jsonl": "",
		"insights.json": "[]",
		"receipt.json": JSON.stringify({
			format_version: 1,
			enola_version: parts.version,
			snapshot_id: `sha256:${"d".repeat(64)}`,
		}),
	});
	await (await GraphCache.open(root)).store(graph);
	const cache = await CoverageCache.open(root);
	const measured = GraphCoverage.compute(
		parts.tree,
		parts.version,
		{ format_version: 1, compiler: coverageCompiler, files: [], symbols: [] },
		{ call: () => undefined, import: () => undefined },
	);
	await cache.store(parts, measured);
	expect((await cache.read(parts, "graph"))?.id).toBe(measured.id);
	for (const producer of [{ compiler: "typescript@next/unstable/sync" }, { matcher: "enola-coverage@next" }]) {
		const upgraded = await CoverageCache.open(root, producer);
		expect(await upgraded.read(parts, "graph")).toBeUndefined();
		expect((await upgraded.read(parts, "graph", { id: measured.id }))?.id).toBe(measured.id);
		const fresh = GraphCoverage.compute(
			parts.tree,
			parts.version,
			{ format_version: 1, compiler: producer.compiler ?? coverageCompiler, files: [], symbols: [] },
			{ call: () => undefined, import: () => undefined },
		);
		await upgraded.store(parts, fresh);
		expect((await upgraded.read(parts, "graph"))?.id).toBe(fresh.id);
		expect((await cache.read(parts, "graph"))?.id).toBe(measured.id);
	}
	const directory = join(root, "coverage", graph.key);
	const indexes = (await readdir(directory)).filter((name) => name.startsWith("graph-"));
	expect(indexes).toHaveLength(3);
	for (const index of indexes)
		await writeFile(
			join(directory, index),
			JSON.stringify({
				format_version: 1,
				producer: { schema: 1, compiler: coverageCompiler, matcher: `${coverageMatcher}-tampered` },
				id: measured.id,
			}),
		);
	expect(await cache.read(parts, "graph")).toBeUndefined();
	await expect((await CoverageCache.open(root, { compiler: "wrong" })).store(parts, measured)).rejects.toThrow(
		"compiler differs",
	);
	const test = TestCoverage.unavailable(parts.tree, parts.version, "first reason");
	await cache.store(parts, test);
	await cache.store(parts, TestCoverage.unavailable(parts.tree, parts.version, "second reason"));
	expect((await cache.read(parts, "test", { id: test.id }))?.toJSON()).toEqual(test.toJSON());
	await writeFile(
		join(directory, "artifacts", `graph-${measured.id}.json`),
		JSON.stringify(
			GraphCoverage.compute(
				parts.tree,
				parts.version,
				{ format_version: 1, compiler: "forged", files: [], symbols: [] },
				{ call: () => undefined, import: () => undefined },
			).toJSON(),
		),
	);
	expect(await cache.read(parts, "graph", { id: measured.id })).toBeUndefined();
});
