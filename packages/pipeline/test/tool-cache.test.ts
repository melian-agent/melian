import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCache } from "../src/tool-cache.ts";
import { testTool, toolArchive } from "./fixtures/tool-archive.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "melian-tools-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("ToolCache", () => {
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
		await cache.materialise(tool, "darwin-arm64");
		expect(download).toHaveBeenCalledTimes(2);
		expect(await readFile(binary, "utf8")).toBe(script);
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
			const bytes = toolArchive([{ ...entry, text: "outside" }]);
			const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
			await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
				code: "invalidOutput",
			});
		},
	);

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
