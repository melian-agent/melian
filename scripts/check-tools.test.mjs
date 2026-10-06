import { describe, expect, it, vi } from "vitest";
import { verifyReleases } from "./check-tools.mjs";

const pin = { url: "https://github.com/a/b/releases/download/v1.2.3/tool.tar.gz", sha256: "a".repeat(64) };
const tools = {
	tool: {
		source: { repository: "a/b", tag: "v1.2.3" },
		published: "2026-01-01T00:00:00Z",
		platforms: { "linux-amd64": pin },
	},
};
const release = {
	tag_name: "v1.2.3",
	published_at: tools.tool.published,
	assets: [{ browser_download_url: pin.url, digest: `sha256:${pin.sha256}` }],
};

describe("tool release verification", () => {
	it("checks publication time and every digest with an injected fetch", async () => {
		expect(await verifyReleases({ tools, fetch: async () => Response.json(release) })).toEqual([]);
	});
	it("fails closed for a moved digest, changed date, absent asset, or unavailable release", async () => {
		for (const response of [
			Response.json({ ...release, published_at: "2026-01-02T00:00:00Z" }),
			Response.json({ ...release, assets: [] }),
			Response.json({ ...release, assets: [{ ...release.assets[0], digest: `sha256:${"b".repeat(64)}` }] }),
			new Response("unavailable", { status: 503 }),
		])
			expect(await verifyReleases({ tools, ci: true, fetch: async () => response })).toHaveLength(1);
		expect(
			await verifyReleases({
				tools,
				ci: true,
				fetch: async () => {
					throw new Error("offline");
				},
			}),
		).toHaveLength(1);
	});
});

it("authenticates GitHub metadata and visibly skips unavailable networking only outside CI", async () => {
	const note = vi.fn();
	const download = vi.fn(async () => Response.json(release));
	expect(await verifyReleases({ tools, token: "test-token", fetch: download })).toEqual([]);
	expect(download.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
	for (const fetch of [
		async () => {
			throw new Error("offline");
		},
		async () => new Response("limited", { status: 429 }),
	]) {
		expect(await verifyReleases({ tools, fetch, ci: false, note })).toEqual([]);
		expect(note.mock.calls.at(-1)[0]).toContain("verification skipped");
		expect(await verifyReleases({ tools, fetch, ci: true, note })).toHaveLength(1);
	}
	expect(
		await verifyReleases({ tools, ci: false, note, fetch: async () => Response.json({ ...release, assets: [] }) }),
	).toHaveLength(1);
});
