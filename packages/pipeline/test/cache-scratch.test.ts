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
	return { ...original, lstat: vi.fn(original.lstat), rm: vi.fn(original.rm), readdir: vi.fn(original.readdir) };
});

let root: string;
afterEach(async () => {
	vi.restoreAllMocks();
	if (root) await rm(root, { recursive: true, force: true });
});

it("opens despite filesystem failures while sweeping cache roots", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-error-"));
	const failure = Object.assign(new Error("cache root denied"), { code: "EACCES" });
	vi.mocked(lstat).mockRejectedValueOnce(failure);
	await expect(GraphCache.open(root)).resolves.toBeInstanceOf(GraphCache);
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
	await expect(GraphCache.open(root)).resolves.toBeInstanceOf(GraphCache);
});

it("opens when a dead writer's scratch cannot be removed", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-readonly-"));
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await once(child, "exit");
	const dead = join(root, "graphs", `.graph-${child.pid}-partial`);
	const old = join(root, "graphs", ".graph-old");
	for (const directory of [dead, old]) await mkdir(directory, { recursive: true });
	await utimes(old, new Date(0), new Date(0));
	const failure = Object.assign(new Error("read-only file system"), { code: "EROFS" });
	vi.mocked(rm).mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
	await expect(GraphCache.open(root)).resolves.toBeInstanceOf(GraphCache);
	expect(rm).toHaveBeenCalledWith(dead, { recursive: true, force: true });
	expect(rm).toHaveBeenCalledWith(old, { recursive: true, force: true });
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

it("keeps legacy scratch just inside the one-day window and removes it just outside", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-window-"));
	const graph = join(root, "graphs");
	await mkdir(graph);
	const inside = join(graph, ".graph-inside"),
		outside = join(graph, ".graph-outside");
	await mkdir(inside);
	await mkdir(outside);
	const age = (milliseconds: number) => new Date(Date.now() - milliseconds);
	await utimes(inside, age(86_400_000 - 60_000), age(86_400_000 - 60_000));
	await utimes(outside, age(86_400_000 + 60_000), age(86_400_000 + 60_000));
	await GraphCache.open(root);
	expect((await lstat(inside)).isDirectory()).toBe(true);
	await expect(lstat(outside)).rejects.toMatchObject({ code: "ENOENT" });
});

it("sweeps dead scratch six directories below a cache root and leaves what lies deeper", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-depth-"));
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await once(child, "exit");
	const six = join(root, "tools", "a", "b", "c", "d", "e", "f");
	const seven = join(six, "g");
	await mkdir(seven, { recursive: true });
	const reachable = join(six, `.fetch-${child.pid}-partial`);
	const beyond = join(seven, `.fetch-${child.pid}-partial`);
	await mkdir(reachable);
	await mkdir(beyond);
	await ToolCache.open(root);
	await expect(lstat(reachable)).rejects.toMatchObject({ code: "ENOENT" });
	expect((await lstat(beyond)).isDirectory()).toBe(true);
});

it("sweeps old legacy scratch files with no process ID and keeps recent ones", async () => {
	root = await mkdtemp(join(tmpdir(), "melian-scratch-files-"));
	const artifacts = join(root, "coverage", "key", "artifacts");
	await mkdir(artifacts, { recursive: true });
	const names = () =>
		[`.x-${crypto.randomUUID()}.json`, `y.${crypto.randomUUID()}.tmp`].map((name) => join(artifacts, name));
	const old = names();
	const recent = names();
	for (const path of [...old, ...recent]) await writeFile(path, "legacy");
	for (const path of old) await utimes(path, new Date(0), new Date(0));
	await CoverageCache.open(root);
	for (const path of old) await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
	for (const path of recent) expect((await lstat(path)).isFile()).toBe(true);
});
