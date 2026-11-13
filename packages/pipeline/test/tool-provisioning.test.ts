import type * as processes from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ToolManifest } from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CacheLocation, ToolProvisioning } from "../src/tool-provisioning.ts";
import { createRepository, removeRepository } from "./fixtures/repo.ts";
import { testTool, toolArchive } from "./fixtures/tool-archive.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof processes>();
	return { ...original, execFile: vi.fn(original.execFile) };
});

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
	expect(vi.mocked(execFile).mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 10_000 });
	const identity = createHash("sha256").update(realpathSync(common)).digest("hex").slice(0, 16);
	expect((await CacheLocation.open(repo, { ...process.env, MELIAN_STATE_DIR: "cache" })).root).toBe(
		join(repo, "cache", identity),
	);
	await expect(CacheLocation.open(join(repo, "missing"))).rejects.toThrow();
});

it("opens bundled pins without fetching and materialises an injected local archive", async () => {
	const bundled = await ToolProvisioning.open(repo);
	expect(bundled.tool("enola").version).toBe("0.4.40");
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
		env: {},
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
		env: {},
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

const releaseUrl = "https://api.github.com/repos/test/enola/releases/tags/v0.0.1";
const assetUrl = "https://api.github.com/repos/test/enola/releases/assets/42";
const publicUrl = "https://github.com/test/enola/releases/download/v0.0.1/enola.tar.gz";

// Answers only the request a pin should make: release metadata and the asset for the expected token, or the public
// URL with no headers when no token is expected.
function provisioningHost(bytes: Buffer, authorization: string | undefined) {
	return vi.fn(async (url: string, options: { headers?: Record<string, string> }) => {
		const asked = options.headers?.authorization;
		if (url === releaseUrl && authorization !== undefined && asked === authorization)
			return new Response(JSON.stringify({ assets: [{ id: 42, browser_download_url: publicUrl }] }));
		if (url === assetUrl && authorization !== undefined && asked === authorization)
			return new Response(new Uint8Array(bytes));
		if (url === publicUrl && authorization === undefined && options.headers === undefined)
			return new Response(new Uint8Array(bytes));
		return new Response("unexpected request", { status: 400 });
	});
}

async function provision(env: NodeJS.ProcessEnv | undefined, download: ReturnType<typeof provisioningHost>) {
	const { name: _name, ...pin } = testTool(toolArchive([{ name: "enola", text: "#!/bin/sh\necho local\n" }]));
	const manifest = ToolManifest.parse(JSON.stringify({ format_version: 1, tools: { enola: pin }, misses: [] }));
	const tools = await ToolProvisioning.open(repo, {
		manifest,
		root: join(repo, "cache"),
		platform: "darwin-arm64",
		fetch: download,
		...(env === undefined ? {} : { env }),
	});
	return readFileSync(await tools.binary("enola"), "utf8");
}

it.each([
	["GITHUB_TOKEN", { GITHUB_TOKEN: "fake-github-token", GH_TOKEN: "fake-gh-token" }, "Bearer fake-github-token"],
	["GH_TOKEN", { GH_TOKEN: " fake-gh-token " }, "Bearer fake-gh-token"],
	["GH_TOKEN past a blank GITHUB_TOKEN", { GITHUB_TOKEN: " ", GH_TOKEN: "fake-gh-token" }, "Bearer fake-gh-token"],
	["no token", { GITHUB_TOKEN: "", GH_TOKEN: "" }, undefined],
	["an empty environment", {}, undefined],
])("fetches through the release API with %s", async (_case, env, authorization) => {
	const bytes = toolArchive([{ name: "enola", text: "#!/bin/sh\necho local\n" }]);
	const download = provisioningHost(bytes, authorization);
	expect(await provision(env, download)).toBe("#!/bin/sh\necho local\n");
	expect(download.mock.calls.map(([url]) => url)).toEqual(
		authorization === undefined ? [publicUrl] : [releaseUrl, assetUrl],
	);
});

it("ignores the process environment's token when no environment is given", async () => {
	vi.stubEnv("GITHUB_TOKEN", "fake-process-token");
	vi.stubEnv("GH_TOKEN", "fake-process-token");
	try {
		const bytes = toolArchive([{ name: "enola", text: "#!/bin/sh\necho local\n" }]);
		const download = provisioningHost(bytes, undefined);
		expect(await provision(undefined, download)).toBe("#!/bin/sh\necho local\n");
		expect(download.mock.calls.map(([url]) => url)).toEqual([publicUrl]);
	} finally {
		vi.unstubAllEnvs();
	}
});
