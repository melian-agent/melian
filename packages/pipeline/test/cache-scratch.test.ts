import { spawn } from "node:child_process";
import { once } from "node:events";
import type * as filesystem from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CoverageCache } from "../src/coverage-cache.ts";
import { GraphCache } from "../src/graph-cache.ts";
import { ToolCache } from "../src/tool-cache.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof filesystem>();
	return { ...original, lstat: vi.fn(original.lstat), readdir: vi.fn(original.readdir) };
});

let root: string;
afterEach(async () => {
	vi.restoreAllMocks();
	if (root) await rm(root, { recursive: true, force: true });
});

it("propagates filesystem failures while sweeping cache roots", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-error-"));
	const failure = Object.assign(new Error("cache root denied"), { code: "EACCES" });
	vi.mocked(lstat).mockRejectedValueOnce(failure);
	await expect(GraphCache.open(root)).rejects.toBe(failure);
});

it.each(["ENOENT", "EACCES"])("handles a legacy scratch stat failure with %s", async (code) => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-race-"));
	const graph = join(root, "graphs");
	const legacy = join(graph, ".graph-legacy");
	await mkdir(legacy, { recursive: true });
	const original = vi.mocked(lstat).getMockImplementation()!;
	const failure = Object.assign(new Error("legacy stat failed"), { code });
	vi.mocked(lstat).mockImplementation(async (...args) => {
		if (args[0] === legacy) throw failure;
		return original(...args);
	});
	if (code === "ENOENT") await expect(GraphCache.open(root)).resolves.toBeInstanceOf(GraphCache);
	else await expect(GraphCache.open(root)).rejects.toBe(failure);
});

it("retains process-owned scratch and its contents when liveness probes are denied", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-denied-"));
	const fetch = join(root, "tools", "enola", `.fetch-${process.pid}-partial`);
	const graph = join(root, "graphs", `.graph-${process.pid}-partial`);
	const coverage = join(root, "coverage", "key", "artifacts");
	for (const directory of [fetch, graph, coverage]) await mkdir(directory, { recursive: true });
	const partials = [
		join(fetch, "archive.part"),
		join(graph, "facts.jsonl"),
		join(coverage, `review.json.${process.pid}.${crypto.randomUUID()}.tmp`),
	];
	for (const path of partials) await writeFile(path, "active writer data");
	const probe = vi.spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error("liveness probe denied"), { code: "EPERM" });
	});
	await GraphCache.open(root);
	expect(probe).toHaveBeenCalledTimes(3);
	expect(probe).toHaveBeenCalledWith(process.pid, 0);
	for (const directory of [fetch, graph])
		await expect(lstat(directory).then((info) => info.isDirectory())).resolves.toBe(true);
	for (const path of partials) await expect(readFile(path, "utf8")).resolves.toBe("active writer data");
});

it("sweeps a killed cache writer on the next open while retaining live and published paths", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-"));
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	try {
		const platform = join(root, "tools", "enola", "1", "platform");
		const graph = join(root, "graphs");
		const coverage = join(root, "coverage", "key", "artifacts");
		for (const directory of [platform, graph, coverage]) await mkdir(directory, { recursive: true });
		const abandoned = [
			join(platform, `.fetch-${child.pid}-partial`),
			join(graph, `.graph-${child.pid}-partial`),
			join(graph, `.graph-${child.pid}-partial-rejected`),
		];
		for (const directory of abandoned) await mkdir(directory);
		const partialFile = join(coverage, `review.json.${child.pid}.${crypto.randomUUID()}.tmp`);
		await writeFile(partialFile, "partial");
		abandoned.push(partialFile);
		const live = join(platform, `.fetch-${process.pid}-live`);
		const published = join(platform, "entry-winner");
		await mkdir(live);
		await mkdir(published);
		await ToolCache.open(root);
		for (const path of abandoned) expect(await lstat(path)).toBeDefined();
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		await GraphCache.open(root);
		await CoverageCache.open(root);
		for (const path of abandoned) await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(live)).isDirectory()).toBe(true);
		expect((await lstat(published)).isDirectory()).toBe(true);
	} finally {
		child.kill("SIGKILL");
	}
});

it("sweeps old legacy scratch but keeps recent legacy writes and ignores directory symlinks", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-legacy-"));
	const graph = join(root, "graphs");
	await mkdir(graph);
	const old = join(graph, ".graph-old-rejected"),
		recent = join(graph, ".graph-recent");
	await mkdir(old);
	await mkdir(recent);
	await utimes(old, new Date(0), new Date(0));
	const outside = join(root, "outside");
	await mkdir(outside);
	const sentinel = join(outside, ".graph-old");
	await mkdir(sentinel);
	await utimes(sentinel, new Date(0), new Date(0));
	await symlink(outside, join(graph, "linked"));
	await GraphCache.open(root);
	await expect(lstat(old)).rejects.toMatchObject({ code: "ENOENT" });
	expect((await lstat(recent)).isDirectory()).toBe(true);
	expect((await lstat(sentinel)).isDirectory()).toBe(true);
});
