import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
	draft: false,
	tag_name: "v1.2.3",
	published_at: tools.tool.published,
	assets: [{ browser_download_url: pin.url, digest: `sha256:${pin.sha256}` }],
};

describe("tool release verification", () => {
	it("checks publication time and every digest with an injected fetch", async () => {
		const deadline = vi.spyOn(AbortSignal, "timeout");
		try {
			expect(
				await verifyReleases({
					tools,
					fetch: async (_url, options) => {
						expect(options.signal).toBeInstanceOf(AbortSignal);
						return Response.json(release);
					},
				}),
			).toEqual([]);
			expect(deadline).toHaveBeenCalledWith(30_000);
		} finally {
			deadline.mockRestore();
		}
	});
	it.each([
		{ label: "draft", change: { draft: true } },
		{ label: "wrong tag", change: { tag_name: "v9.0.0" } },
	])("rejects a $label release locally and in CI with valid dates and digests", async ({ change }) => {
		for (const ci of [false, true]) {
			const note = vi.fn();
			expect(
				await verifyReleases({ tools, ci, note, fetch: async () => Response.json({ ...release, ...change }) }),
			).toEqual(["tool: release unverified: release tag or publication time differs from the manifest"]);
			expect(note).not.toHaveBeenCalled();
		}
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
		).toEqual(["tool: release unverified: GitHub network unavailable; CI requires release verification"]);
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

it("sets the release gate status and prints only applicable age exceptions", () => {
	const directory = mkdtempSync(join(tmpdir(), "melian-release-entry-"));
	try {
		const script = fileURLToPath(new URL("./check-tools.mjs", import.meta.url));
		const hook = join(directory, "fetch.mjs");
		writeFileSync(join(directory, ".npmrc"), "min-release-age=2\n");
		for (const age of ["old", "excepted", "young"]) {
			const published = age === "old" ? tools.tool.published : new Date(Date.now() - 3_600_000).toISOString();
			const exception =
				age === "excepted" ? { exception: { reason: "reviewed test fixture", added: "2026-01-01" } } : {};
			writeFileSync(
				join(directory, "tools.yaml"),
				JSON.stringify({
					format_version: 1,
					tools: { tool: { ...tools.tool, version: "1.2.3", published, ...exception } },
					misses: [],
				}),
			);
			writeFileSync(
				hook,
				`globalThis.fetch = async () => Response.json(${JSON.stringify({ ...release, published_at: published })});`,
			);
			const child = spawnSync(process.execPath, ["--import", hook, script], { cwd: directory, encoding: "utf8" });
			expect(child.status).toBe(age === "young" ? 1 : 0);
			expect(child.stdout).toBe(
				age === "excepted" ? "tool release-age exception used: tool@1.2.3 (reviewed test fixture)\n" : "",
			);
			if (age === "young") expect(child.stderr).toContain("inside the 2-day window");
			else expect(child.stderr).toBe("");
		}
		writeFileSync(join(directory, "tools.yaml"), "{}");
		const child = spawnSync(process.execPath, ["--import", hook, script], { cwd: directory, encoding: "utf8" });
		expect(child.status).toBe(1);
		expect(child.stderr).toContain("format_version");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
