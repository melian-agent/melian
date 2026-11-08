import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ToolCache, type ToolFetch } from "../src/tool-cache.ts";
import { testTool, toolArchive } from "./fixtures/tool-archive.ts";

const token = "ghs_fakeTokenOnlyForTests0123456789";
const release = "https://api.github.com/repos/test/enola/releases/tags/v0.0.1";
const asset = "https://api.github.com/repos/test/enola/releases/assets/42";
const signed = "https://release-assets.githubusercontent.com/github-production-release-asset/42?sig=abc";
const pinned = "https://github.com/test/enola/releases/download/v0.0.1/enola.tar.gz";
const api = {
	authorization: `Bearer ${token}`,
	"user-agent": "melian-tool-cache",
	"x-github-api-version": "2022-11-28",
};
const metadataLimit = 4 * 1024 * 1024;

type Call = { url: string; options: Parameters<ToolFetch>[1] };
type Route = (options: Parameters<ToolFetch>[1]) => Response | Promise<Response>;

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "melian-release-api-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
const wrong = toolArchive([{ name: "enola", text: "swapped" }]);

function listing(assets: unknown[]): string {
	return JSON.stringify({ tag_name: "v0.0.1", assets });
}

// Each route answers only the request it is asked: the right credential, media type and redirect mode.
function host(routes: Record<string, Route>): { calls: Call[]; fetch: ToolFetch } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (url, options) => {
			calls.push({ url, options });
			const route = routes[url];
			if (route === undefined) throw new Error(`unexpected request ${url}`);
			return route(options);
		},
	};
}

const releaseRoute =
	(body: string | null, status = 200): Route =>
	(options) =>
		options.headers?.authorization === `Bearer ${token}` && options.headers.accept === "application/vnd.github+json"
			? new Response(body, { status })
			: new Response("Bad credentials", { status: 401 });

const assetRoute =
	(response: () => Response): Route =>
	(options) =>
		options.headers?.authorization === `Bearer ${token}` &&
		options.headers.accept === "application/octet-stream" &&
		options.redirect === "manual"
			? response()
			: new Response("wrong request", { status: 415 });

const signedRoute =
	(body: Buffer): Route =>
	(options) =>
		options.headers?.authorization === undefined
			? new Response(new Uint8Array(body))
			: new Response("token sent to the asset host", { status: 400 });

const publicRoute =
	(body: Buffer | null, status = 200): Route =>
	(options) =>
		options.headers === undefined
			? new Response(body === null ? null : new Uint8Array(body), { status })
			: new Response("public URL asked with headers", { status: 400 });

const redirect = () => new Response(null, { status: 302, headers: { location: signed } });
const good = listing([
	{ id: 7, name: "enola.sha256", browser_download_url: `${pinned}.sha256` },
	{ id: 42, name: "enola.tar.gz", browser_download_url: pinned },
]);

it("fetches a pin through the release API when a token is set, and never asks the public URL", async () => {
	const github = host({
		[release]: releaseRoute(good),
		[asset]: assetRoute(redirect),
		[signed]: signedRoute(bytes),
	});
	const cache = await ToolCache.open(root, { fetch: github.fetch, token });
	expect(await readFile(await cache.materialise(testTool(bytes), "darwin-arm64"), "utf8")).toBe("trusted");
	expect(github.calls).toEqual([
		{
			url: release,
			options: { signal: expect.any(AbortSignal), headers: { ...api, accept: "application/vnd.github+json" } },
		},
		{
			url: asset,
			options: {
				signal: expect.any(AbortSignal),
				headers: { ...api, accept: "application/octet-stream" },
				redirect: "manual",
			},
		},
		{ url: signed, options: { signal: expect.any(AbortSignal) } },
	]);
});

it("takes an asset the API serves without a redirect", async () => {
	const github = host({
		[release]: releaseRoute(good),
		[asset]: assetRoute(() => new Response(new Uint8Array(bytes))),
	});
	const cache = await ToolCache.open(root, { fetch: github.fetch, token });
	expect(await readFile(await cache.materialise(testTool(bytes), "darwin-arm64"), "utf8")).toBe("trusted");
	expect(github.calls.map((call) => call.url)).toEqual([release, asset]);
});

it("accepts the lowest asset id", async () => {
	const github = host({
		[release]: releaseRoute(listing([{ id: 1, browser_download_url: pinned }])),
		"https://api.github.com/repos/test/enola/releases/assets/1": assetRoute(
			() => new Response(new Uint8Array(bytes)),
		),
	});
	const cache = await ToolCache.open(root, { fetch: github.fetch, token });
	expect(await readFile(await cache.materialise(testTool(bytes), "darwin-arm64"), "utf8")).toBe("trusted");
	expect(github.calls.map((call) => call.url)).not.toContain(pinned);
});

it("uses the public URL alone when no token is set", async () => {
	const github = host({ [pinned]: publicRoute(bytes) });
	const cache = await ToolCache.open(root, { fetch: github.fetch });
	expect(await readFile(await cache.materialise(testTool(bytes), "darwin-arm64"), "utf8")).toBe("trusted");
	expect(github.calls).toEqual([{ url: pinned, options: { signal: expect.any(AbortSignal) } }]);
});

const served = (id: number) => ({
	[`https://api.github.com/repos/test/enola/releases/assets/${id}`]: assetRoute(redirect),
	[signed]: signedRoute(bytes),
});

// Each case names the requests it expects before the public URL; the API would succeed wherever the guard allowed it.
it.each<[string, Record<string, Route>, string[]]>([
	["the release answers 504", { [release]: releaseRoute("upstream timeout", 504) }, [release]],
	["the release answers 404", { [release]: releaseRoute("Not Found", 404) }, [release]],
	["the release answers 500 with an asset listing", { [release]: releaseRoute(good, 500), ...served(42) }, [release]],
	["the release has no body", { [release]: releaseRoute(null) }, [release]],
	[
		"the release request fails",
		{
			[release]: () => {
				throw new TypeError("fetch failed");
			},
		},
		[release],
	],
	["the release is not JSON", { [release]: releaseRoute("<html>") }, [release]],
	["the release lists no assets", { [release]: releaseRoute(JSON.stringify({ tag_name: "v0.0.1" })) }, [release]],
	[
		"the release lists only another asset",
		{ [release]: releaseRoute(listing([{ id: 7, browser_download_url: `${pinned}.sha256` }])), ...served(7) },
		[release],
	],
	[
		"the asset id is zero",
		{ [release]: releaseRoute(listing([{ id: 0, browser_download_url: pinned }])), ...served(0) },
		[release],
	],
	[
		"the asset id is a string",
		{ [release]: releaseRoute(listing([{ id: "42", browser_download_url: pinned }])), ...served(42) },
		[release],
	],
	[
		"the asset id is a fraction",
		{ [release]: releaseRoute(listing([{ id: 4.5, browser_download_url: pinned }])), ...served(4.5) },
		[release],
	],
	[
		"the release metadata is one byte past 4 MiB",
		{ [release]: releaseRoute(good.padEnd(metadataLimit + 1, " ")), ...served(42) },
		[release],
	],
	[
		"the asset answers 404",
		{ [release]: releaseRoute(good), [asset]: assetRoute(() => new Response("Not Found", { status: 404 })) },
		[release, asset],
	],
	[
		"the asset redirect target answers 504",
		{
			[release]: releaseRoute(good),
			[asset]: assetRoute(redirect),
			[signed]: () => new Response("timeout", { status: 504 }),
		},
		[release, asset, signed],
	],
])("falls back to the public URL when %s", async (_case, routes, before) => {
	const github = host({ ...routes, [pinned]: publicRoute(bytes) });
	const cache = await ToolCache.open(root, { fetch: github.fetch, token });
	expect(await readFile(await cache.materialise(testTool(bytes), "darwin-arm64"), "utf8")).toBe("trusted");
	expect(github.calls.map((call) => call.url)).toEqual([...before, pinned]);
	expect(github.calls.at(-1)).toEqual({ url: pinned, options: { signal: expect.any(AbortSignal) } });
});

it("falls back to the public URL when the API body breaks after the download began", async () => {
	const broken = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(bytes.subarray(0, 10)));
			controller.error(new TypeError("terminated"));
		},
	});
	const github = host({
		[release]: releaseRoute(good),
		[asset]: assetRoute(() => new Response(broken)),
		[pinned]: publicRoute(bytes),
	});
	const cache = await ToolCache.open(root, { fetch: github.fetch, token });
	expect(await readFile(await cache.materialise(testTool(bytes), "darwin-arm64"), "utf8")).toBe("trusted");
	expect(github.calls.map((call) => call.url)).toEqual([release, asset, pinned]);
});

it("reads release metadata of exactly 4 MiB", async () => {
	const github = host({
		[release]: releaseRoute(good.padEnd(metadataLimit, " ")),
		[asset]: assetRoute(redirect),
		[signed]: signedRoute(bytes),
	});
	const cache = await ToolCache.open(root, { fetch: github.fetch, token });
	expect(await readFile(await cache.materialise(testTool(bytes), "darwin-arm64"), "utf8")).toBe("trusted");
	expect(github.calls.map((call) => call.url)).toEqual([release, asset, signed]);
});

it("refuses a release API body that differs from the pin, without asking the public URL", async () => {
	const github = host({
		[release]: releaseRoute(good),
		[asset]: assetRoute(redirect),
		[signed]: signedRoute(wrong),
		[pinned]: publicRoute(bytes),
	});
	const cache = await ToolCache.open(root, { fetch: github.fetch, token });
	await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
		code: "invalidOutput",
		message: "Tool archive SHA-256 mismatch; nothing extracted",
	});
	expect(github.calls.map((call) => call.url)).toEqual([release, asset, signed]);
});

it("refuses an oversized release API body without asking the public URL", async () => {
	const huge = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(128 * 1024 * 1024 + 1));
			controller.close();
		},
	});
	const github = host({
		[release]: releaseRoute(good),
		[asset]: assetRoute(() => new Response(huge)),
		[pinned]: publicRoute(bytes),
	});
	const cache = await ToolCache.open(root, { fetch: github.fetch, token });
	await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({ code: "outputTooLarge" });
	expect(github.calls.map((call) => call.url)).toEqual([release, asset]);
});

it.each([
	["no token", undefined],
	["a failed release API", token],
])("refuses a public URL body that differs from the pin with %s", async (_case, configured) => {
	const github = host({ [release]: releaseRoute("Not Found", 404), [pinned]: publicRoute(wrong) });
	const cache = await ToolCache.open(root, { fetch: github.fetch, token: configured });
	await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
		code: "invalidOutput",
		message: "Tool archive SHA-256 mismatch; nothing extracted",
	});
	expect(github.calls.at(-1)?.url).toBe(pinned);
});

it("keeps the token out of every error and stored file", async () => {
	const failing = host({
		[release]: releaseRoute("server error", 500),
		[pinned]: publicRoute(null, 504),
	});
	const failed = await ToolCache.open(root, { fetch: failing.fetch, token });
	const error = await failed.materialise(testTool(bytes), "darwin-arm64").catch((caught: unknown) => caught);
	expect(error).toMatchObject({ code: "toolFailed", message: "Download failed: HTTP 504" });
	expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(token);
	expect(JSON.stringify(error)).not.toContain(token);

	const github = host({ [release]: releaseRoute(good), [asset]: assetRoute(redirect), [signed]: signedRoute(bytes) });
	const cache = await ToolCache.open(root, { fetch: github.fetch, token });
	await cache.materialise(testTool(bytes), "darwin-arm64");
	expect(inspect(cache, { depth: 10, showHidden: true })).not.toContain(token);
	expect(JSON.stringify(cache)).not.toContain(token);
	const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
	expect(files.length).toBeGreaterThan(0);
	for (const file of files) expect(await readFile(join(file.parentPath, file.name), "utf8")).not.toContain(token);
});
