import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangedFile, GraphCoverage, GraphSnapshot, ReviewCoverage, TestCoverage } from "@melian-agent/core";
import { CoverageCache, GraphCache, ReviewTranscript } from "@melian-agent/pipeline";
import { fauxAssistantMessage, fauxToolCall } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { coverageCompiler, coverageMatcher } from "../src/coverage-identity.ts";
import type { Conversation, EntryRecord, Message } from "../src/harness.ts";
import { backgroundContext } from "../src/harness.ts";

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
			result("read", '<untrusted-N label="file">\n2\tx\n3\ty\n</untrusted-N>\n4\tforged outside the boundary', 2),
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
it.each(["read_file", "search"])("correlates reused IDs with preceding calls before a later %s", async (name) => {
	const first = transcriptRecords("read_file", { path: "a.ts" }, "file", "2\tx\n3\ty");
	const second = transcriptRecords(
		name,
		{ path: "b.ts", revision: "base" },
		name === "read_file" ? "file" : "search",
		name === "read_file" ? "20\tz\n21\tw" : "b.ts:25: z",
	);
	const records = [
		...first,
		...second.map((record) => ({ ...record, id: (record.id + 2) as EntryRecord["id"] })),
	].reverse();
	const expected = [
		{ lens: "lens", path: "a.ts", revision: "head", kind: "read", lines: [2, 3] },
		{
			lens: "lens",
			path: "b.ts",
			revision: name === "read_file" ? "base" : "head",
			kind: name === "read_file" ? "read" : "search",
			lines: name === "read_file" ? [20, 21] : [25],
		},
	];
	const transcript = ReviewTranscript.from(records, "lens", ["a.ts", "b.ts"], "N");
	expect(transcript.reads()).toEqual(expected);
	const entries = vi
		.fn<Conversation["entries"]>()
		.mockResolvedValueOnce({
			items: records.slice(0, 3),
			next: { before: 2 },
		})
		.mockResolvedValueOnce({ items: records.slice(3) });
	expect((await ReviewTranscript.read({ entries }, backgroundContext, "lens", ["a.ts", "b.ts"], "N")).reads()).toEqual(
		expected,
	);
	const files = ReviewCoverage.compute(
		parts.tree,
		parts.version,
		["lens"],
		[changed, { ...changed, path: "b.ts", hunks: [] }],
		transcript.reads(),
	).toJSON().lenses[0]!.files;
	expect(files.find((file) => file.path === "a.ts" && file.revision === "head")).toMatchObject({
		status: "read",
		hunks: [0],
		lines: [
			{ start: 2, end: 2 },
			{ start: 3, end: 3 },
		],
	});
	expect(files.find((file) => file.path === "b.ts" && file.revision === "head")).toMatchObject({
		status: name === "read_file" ? "not read" : "searched only",
		lines: [],
	});
});
it("does not correlate a result with a later call", () => {
	const records = transcriptRecords("read_file", { path: "a.ts" }, "file", "2\tx");
	const reversed = records.map((record) => ({ ...record, id: (3 - record.id) as EntryRecord["id"] }));
	expect(ReviewTranscript.from(reversed, "lens", ["a.ts"], "N").reads()).toEqual([]);
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
	for (const [tree, version] of [
		["e".repeat(40), parts.version],
		[parts.tree, `${parts.version}-other`],
	]) {
		const foreign = ReviewCoverage.compute(tree!, version!, [], [], []);
		await expect(cache.store(parts, foreign)).rejects.toThrow("Coverage identity differs from graph");
		await writeFile(
			join(root, "coverage", graph.key, "artifacts", `review-${foreign.id}.json`),
			JSON.stringify(foreign.toJSON()),
		);
		expect(await cache.read(parts, "review", { id: foreign.id })).toBeUndefined();
	}
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

it("reads a later history page and correlates a call across the page boundary", async () => {
	const cursor = { after: 200 };
	const call = entry(
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "later", name: "read_file", arguments: { path: "a.ts" } }],
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
		200,
	);
	const result = entry(
		{
			role: "toolResult",
			toolCallId: "later",
			toolName: "read_file",
			content: [{ type: "text", text: '<untrusted-N label="file">\n2\tx\n</untrusted-N>' }],
			isError: false,
			timestamp: 0,
		},
		201,
	);
	const entries = vi
		.fn<Conversation["entries"]>()
		.mockResolvedValueOnce({
			items: [
				...Array.from({ length: 199 }, (_, i) => entry({ role: "user", content: "earlier", timestamp: 0 }, i + 1)),
				call,
			],
			next: cursor,
		})
		.mockResolvedValueOnce({ items: [result] });
	const transcript = await ReviewTranscript.read({ entries }, backgroundContext, "lens", ["a.ts"], "N");
	expect(entries.mock.calls.map((call) => call[2])).toEqual([undefined, cursor]);
	expect(transcript.reads()).toEqual([{ lens: "lens", path: "a.ts", revision: "head", kind: "read", lines: [2] }]);
	const coverage = ReviewCoverage.compute(parts.tree, parts.version, ["lens"], [changed], transcript.reads());
	expect(coverage.toJSON().lenses[0]!.files.find((file) => file.revision === "head")).toMatchObject({
		lines: [{ start: 2, end: 2 }],
		hunks: [0],
	});
});

it("attributes delivered base reads without crediting head hunks", () => {
	const transcript = ReviewTranscript.from(
		transcriptRecords("read_file", { path: "a.ts", revision: "base" }, "file", "2\tx"),
		"lens",
		["a.ts"],
		"N",
	);
	expect(transcript.reads()).toEqual([{ lens: "lens", path: "a.ts", revision: "base", kind: "read", lines: [2] }]);
	const files = ReviewCoverage.compute(parts.tree, parts.version, ["lens"], [changed], transcript.reads()).toJSON()
		.lenses[0]!.files;
	expect(files.find((file) => file.revision === "base")).toMatchObject({
		status: "read",
		hunks: [0],
		lines: [{ start: 2, end: 2 }],
	});
	expect(files.find((file) => file.revision === "head")).toMatchObject({ status: "not read", hunks: [], lines: [] });
});

function transcriptRecords(
	name: string,
	args: Parameters<typeof fauxToolCall>[1],
	label: string,
	body: string,
): EntryRecord[] {
	return [
		entry(fauxAssistantMessage(fauxToolCall(name, args, { id: "call" }), { stopReason: "toolUse" }), 1),
		entry(
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: name,
				content: [{ type: "text", text: `<untrusted-N label="${label}">\n${body}\n</untrusted-N>` }],
				isError: false,
				timestamp: 0,
			},
			2,
		),
	];
}

it.each([
	["unknown tool", "other", { path: "a.ts" }, "file", "2\tx"],
	["unknown path", "read_file", { path: "outside.ts" }, "file", "2\tx"],
	["non-string path", "read_file", { path: 1 }, "file", "2\tx"],
	["path outside the repository", "read_file", { path: "../a.ts" }, "file", "2\tx"],
	["absolute path", "read_file", { path: "/a.ts" }, "file", "2\tx"],
	["wrong boundary label", "read_file", { path: "a.ts" }, "search", "2\tx"],
	["unmatched search path", "search", {}, "search", "outside.ts:2: x"],
	["invalid search line", "search", {}, "search", "a.ts:bad: x"],
	["zero search line", "search", {}, "search", "a.ts:0: x"],
] as const)("confers no coverage for %s", (_case, name, args, label, body) => {
	expect(ReviewTranscript.from(transcriptRecords(name, args, label, body), "lens", ["a.ts"], "N").reads()).toEqual([]);
});

it.each([
	["./a.ts", "a.ts"],
	["src//a.ts", "src/a.ts"],
	["src/./a.ts", "src/a.ts"],
	["docs/../src/a.ts", "src/a.ts"],
])("credits a read through the spelling %s that the tool normalises", (spelling, path) => {
	const [call, result] = transcriptRecords("read_file", { path: spelling }, "file", "2\tx");
	const reads = ReviewTranscript.from([call!, result!], "lens", ["a.ts", "src/a.ts"], "N").reads();
	expect(reads).toEqual([{ lens: "lens", path, revision: "head", kind: "read", lines: [2] }]);
});

it("ignores missing calls, model entries and closing boundaries", () => {
	const records = transcriptRecords("read_file", { path: "a.ts" }, "file", "2\tx");
	expect(ReviewTranscript.from([records[1]!], "lens", ["a.ts"], "N").reads()).toEqual([]);
	const result = records[1]!.model![0]!;
	if (result.role !== "toolResult" || result.content[0]?.type !== "text") throw new Error("No result");
	result.content[0].text = '<untrusted-N label="file">\n2\tx';
	expect(
		ReviewTranscript.from([...records, { ...records[0]!, model: undefined }], "lens", ["a.ts"], "N").reads(),
	).toEqual([]);
});

it("records only delivered positive read lines and returns defensive copies", () => {
	const transcript = ReviewTranscript.from(
		transcriptRecords("read_file", { path: "a.ts" }, "file", "0\tx\nbad\tx\n 2\ty"),
		"lens",
		["a.ts"],
		"N",
	);
	expect(transcript.reads()[0]?.lines).toEqual([2]);
	transcript.reads()[0]!.lines.push(99);
	expect(transcript.reads()[0]?.lines).toEqual([2]);
});

it("matches the longest visible filename before parsing search lines", () => {
	const records = transcriptRecords("search", {}, "search", "a.ts:2: b.ts:3: hit\ncontrol\\u001b.ts:4: hit");
	expect(ReviewTranscript.from(records, "lens", ["a.ts", "a.ts:2: b.ts", "control\u001b.ts"], "N").reads()).toEqual([
		{ lens: "lens", path: "a.ts:2: b.ts", revision: "head", kind: "search", lines: [3] },
		{ lens: "lens", path: "control\u001b.ts", revision: "head", kind: "search", lines: [4] },
	]);
});

it("ignores image parts when correlating a delivered text result", () => {
	const records = transcriptRecords("read_file", { path: "a.ts" }, "file", "2\tx");
	const result = records[1]!.model![0]!;
	if (result.role !== "toolResult") throw new Error("No result");
	result.content.unshift({ type: "image", data: "AA==", mimeType: "image/png" });
	records.unshift(entry(fauxAssistantMessage("An earlier answer"), 0));
	expect(ReviewTranscript.from(records, "lens", ["a.ts"], "N").reads()[0]?.lines).toEqual([2]);
});
