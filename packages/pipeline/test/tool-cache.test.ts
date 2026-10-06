import { createHash } from "node:crypto";
import type * as fs from "node:fs/promises";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCache } from "../src/tool-cache.ts";
import { testTool, toolArchive } from "./fixtures/tool-archive.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, rm: vi.fn(original.rm) };
});

let root: string;
beforeEach(async () => {
	vi.clearAllMocks();
	root = await mkdtemp(join(tmpdir(), "melian-tools-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("ToolCache", () => {
	it("checks a missing cache without creating directories", async () => {
		const directory = join(root, "absent");
		const bytes = toolArchive([{ name: "enola", text: "binary" }]);
		const download = vi.fn(async () => new Response(bytes));
		const cache = await ToolCache.open(directory, { fetch: download });
		expect(await cache.readiness(testTool(bytes), "darwin-arm64")).toBe("not-fetched");
		await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(download).not.toHaveBeenCalled();
	});

	it("extracts only the pinned binary and verifies every cached use, repairing a swap", async () => {
		const script = "#!/bin/sh\nprintf '%s' '{\"runs\":[{\"results\":[]}]}'\n";
		const bytes = toolArchive([
			{ name: "enola", text: script },
			{ name: "LICENSE", text: "licence" },
		]);
		await writeFile(join(root, "fixture.tar.gz"), bytes);
		const download = vi.fn(async () => new Response(await readFile(join(root, "fixture.tar.gz"))));
		const cache = await ToolCache.open(root, { fetch: download });
		const tool = testTool(bytes);
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("not-fetched");
		const binary = await cache.materialise(tool, "darwin-arm64");
		expect(await readFile(binary, "utf8")).toBe(script);
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("verified");
		await cache.materialise(tool, "darwin-arm64");
		expect(download).toHaveBeenCalledTimes(1);
		await writeFile(binary, "swapped");
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
		const repaired = await cache.materialise(tool, "darwin-arm64");
		expect(download).toHaveBeenCalledTimes(2);
		expect(await readFile(repaired, "utf8")).toBe(script);
	});

	it("refuses a forged executable and sidecar without trusting their matching hashes", async () => {
		const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
		const download = vi.fn(async () => new Response(bytes));
		const cache = await ToolCache.open(root, { fetch: download });
		const tool = testTool(bytes);
		const binary = await cache.materialise(tool, "darwin-arm64");
		await writeFile(binary, "forged");
		await writeFile(
			join(dirname(binary), "receipt.json"),
			JSON.stringify({
				format_version: 1,
				archive: tool.platforms["darwin-arm64"]!.sha256,
				binary: createHash("sha256").update("forged").digest("hex"),
			}),
		);
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
		const repaired = await cache.materialise(tool, "darwin-arm64");
		expect(await readFile(repaired, "utf8")).toBe("trusted");
		expect(download).toHaveBeenCalledTimes(2);
		await writeFile(join(dirname(repaired), "archive"), "forged archive");
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
	});

	it("publishes concurrent downloads without removing a returned executable", async () => {
		const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
		let release!: () => void;
		const barrier = new Promise<void>((done) => {
			release = done;
		});
		const download = vi.fn(async () => {
			if (download.mock.calls.length === 2) release();
			await barrier;
			return new Response(bytes);
		});
		const first = await ToolCache.open(root, { fetch: download });
		const second = await ToolCache.open(root, { fetch: download });
		const tool = testTool(bytes);
		const binaries = await Promise.all([
			first.materialise(tool, "darwin-arm64"),
			second.materialise(tool, "darwin-arm64"),
		]);
		for (const binary of binaries) expect(await readFile(binary, "utf8")).toBe("trusted");
		const removals = vi.mocked(rm).mock.calls.filter(([path]) => !String(path).includes(".fetch-"));
		expect(removals).toEqual([]);
		await writeFile(binaries[0]!, "corrupt");
		const repaired = await first.materialise(tool, "darwin-arm64");
		expect(await readFile(repaired, "utf8")).toBe("trusted");
		expect(vi.mocked(rm).mock.calls.filter(([path]) => !String(path).includes(".fetch-"))).toEqual([]);
	});

	it("refuses a wrong digest before attempting extraction, and fetch errors", async () => {
		const bytes = toolArchive([{ name: "enola", text: "binary" }]);
		const cache = await ToolCache.open(root, { fetch: async () => new Response("not even gzip") });
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
			code: "invalidOutput",
			message: expect.stringContaining("SHA-256 mismatch"),
		});
		const broken = await ToolCache.open(root, {
			fetch: async () => {
				throw new Error("offline");
			},
		});
		await expect(broken.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({ code: "toolFailed" });
	});

	it.each([{ name: "enola", kind: "2" }, { name: "enola", kind: "1" }, { name: "../enola" }, { name: "/enola" }])(
		"refuses dangerous archive entries %j",
		async (entry) => {
			const bytes = toolArchive([
				{ ...entry, text: "outside" },
				{ name: "enola", text: "trusted" },
			]);
			const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
			await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
				code: "invalidOutput",
				message: expect.stringContaining("Unsafe tar entry"),
			});
		},
	);

	it("refuses a symlink to a byte-identical binary", async () => {
		const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		const tool = testTool(bytes);
		const binary = await cache.materialise(tool, "darwin-arm64");
		const target = join(root, "identical");
		await writeFile(target, "trusted", { mode: 0o755 });
		await rm(binary);
		await symlink(target, binary);
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
	});

	it.each(["duplicate", "unterminated"])("refuses a %s binary archive", async (kind) => {
		let bytes = toolArchive([
			{ name: "enola", text: "trusted" },
			...(kind === "duplicate" ? [{ name: "enola", text: "trusted" }] : []),
		]);
		if (kind === "unterminated") bytes = gzipSync(gunzipSync(bytes).subarray(0, -1024));
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({ code: "invalidOutput" });
	});

	it("refuses bytes hidden after a tar name terminator", async () => {
		const bytes = toolArchive([{ name: "enola\0../../x", text: "trusted" }]);
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
			code: "invalidOutput",
			message: expect.stringContaining("NUL"),
		});
	});

	it("refuses absent binary, unsupported platform, and a young release", async () => {
		const bytes = toolArchive([{ name: "LICENSE", text: "licence" }]);
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		const tool = testTool(bytes);
		await expect(cache.materialise(tool, "darwin-arm64")).rejects.toMatchObject({ code: "invalidOutput" });
		await expect(cache.materialise(tool, "windows-amd64")).rejects.toMatchObject({ code: "toolMissing" });
		await expect(
			cache.materialise({ ...tool, published: new Date().toISOString() }, "darwin-arm64"),
		).rejects.toMatchObject({ code: "toolFailed" });
	});

	it("supports a standalone executable with no archive path", async () => {
		const bytes = Buffer.from("#!/bin/sh\nexit 0\n");
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		const tool = testTool(bytes);
		delete tool.platforms["darwin-arm64"]!.binary;
		expect(await readFile(await cache.materialise(tool, "darwin-arm64"))).toEqual(bytes);
	});
});

it("reads the configured quarantine window rather than assuming two days", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const tool = { ...testTool(bytes), published: new Date(Date.now() - 3 * 86_400_000).toISOString() };
	const download = vi.fn(async () => new Response(bytes));
	const strict = await ToolCache.open(root, { fetch: download, npmrc: "min-release-age=4\n" });
	await expect(strict.materialise(tool, "darwin-arm64")).rejects.toMatchObject({ code: "toolFailed" });
	expect(download).not.toHaveBeenCalled();
	const relaxed = await ToolCache.open(root, { fetch: download, npmrc: "min-release-age=2.5\n" });
	expect(await relaxed.materialise(tool, "darwin-arm64")).toBeTruthy();
});
