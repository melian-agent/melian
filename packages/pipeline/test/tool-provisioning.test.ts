import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ToolManifest } from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CacheLocation, ToolProvisioning } from "../src/tool-provisioning.ts";
import { createRepository, removeRepository } from "./fixtures/repo.ts";
import { testTool, toolArchive } from "./fixtures/tool-archive.ts";

let repo: string;
beforeEach(() => {
	repo = createRepository();
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

it("shares the git common directory and namespaces an explicit state location", async () => {
	const common = join(repo, ".git");
	expect(
		(
			await CacheLocation.open(repo, {
				...process.env,
				GIT_DIR: "/missing",
				GIT_WORK_TREE: "/missing",
				MELIAN_STATE_DIR: "",
			})
		).root,
	).toBe(join(common, "melian"));
	const identity = createHash("sha256").update(realpathSync(common)).digest("hex").slice(0, 16);
	expect((await CacheLocation.open(repo, { ...process.env, MELIAN_STATE_DIR: "cache" })).root).toBe(
		join(repo, "cache", identity),
	);
	await expect(CacheLocation.open(join(repo, "missing"))).rejects.toThrow();
});

it("opens bundled pins without fetching and materialises an injected local archive", async () => {
	const bundled = await ToolProvisioning.open(repo);
	expect(bundled.tool("enola").version).toBe("0.4.27");
	expect(bundled.cache.root).toBe(join(repo, ".git", "melian"));
	expect(bundled.platform).toBe(`${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`);
	const bytes = toolArchive([{ name: "enola", text: "#!/bin/sh\necho local\n" }]);
	const { name, ...pin } = testTool(bytes);
	expect(name).toBe("enola");
	const manifest = ToolManifest.parse(JSON.stringify({ format_version: 1, tools: { enola: pin }, misses: [] }));
	const download = vi.fn(async () => new Response(new Uint8Array(bytes)));
	const tools = await ToolProvisioning.open(repo, {
		manifest,
		root: join(repo, "cache"),
		platform: "darwin-arm64",
		fetch: download,
	});
	expect(tools.tool("enola").version).toBe("0.0.1");
	expect(readFileSync(await tools.binary("enola"), "utf8")).toBe("#!/bin/sh\necho local\n");
	expect(download).toHaveBeenCalledTimes(1);
	await expect(tools.binary("absent")).rejects.toMatchObject({ code: "toolMissing", check: "static.absent" });
	const failed = await ToolProvisioning.open(repo, {
		manifest,
		root: join(repo, "failed"),
		platform: "darwin-arm64",
		fetch: async () => {
			throw "local refusal";
		},
	});
	await expect(failed.binary("enola")).rejects.toMatchObject({
		code: "toolFailed",
		check: "static.enola",
		message: expect.stringContaining("local refusal"),
	});
	vi.spyOn(tools.cache, "materialise").mockRejectedValueOnce("raw cache rejection");
	await expect(tools.binary("enola")).rejects.toMatchObject({ code: "toolFailed", message: "raw cache rejection" });
});
