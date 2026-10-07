import { readFileSync } from "node:fs";
import { ToolManifest, ToolManifestError } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const stored = JSON.parse(
	JSON.stringify(ToolManifest.parse(readFileSync(new URL("../../../tools.yaml", import.meta.url), "utf8")).toJSON()),
);

describe("ToolManifest", () => {
	it.each([
		{ change: { published: "2026-99-01T00:00:00Z" }, message: "enola: invalid publication timestamp" },
		{ change: { published: "2026-01-01" }, message: "enola: invalid publication timestamp" },
		{ change: { exception: { added: "2026-99-01", reason: "reviewed" } }, message: "enola: invalid exception" },
		{ change: { exception: { added: "2026-01-01", reason: " " } }, message: "enola: invalid exception" },
		{ change: { platforms: {} }, message: "enola: no platforms" },
	])("retains the typed manifest refusal: $message ($change)", ({ change, message }) => {
		const state = structuredClone(stored);
		Object.assign(state.tools.enola, change);
		try {
			ToolManifest.parse(JSON.stringify(state));
			throw new Error("accepted invalid manifest");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolManifestError);
			expect(error).toMatchObject({ name: "ToolManifestError", code: "invalidManifest", message });
		}
	});
	it("refuses malformed record keys, date formats, repository names and empty miss references", () => {
		const named = structuredClone(stored);
		named.tools["../enola"] = named.tools.enola;
		delete named.tools.enola;
		const platform = structuredClone(stored);
		platform.tools.enola.platforms.invalid = platform.tools.enola.platforms["darwin-arm64"];
		const repository = structuredClone(stored);
		repository.tools.enola.source.repository = "owner/repo/sub";
		for (const pin of Object.values(repository.tools.enola.platforms) as { url: string }[])
			pin.url = pin.url.replace("enola-labs/enola", "owner/repo/sub");
		const date = structuredClone(stored);
		date.tools.enola.published = "2026-01-01T00:00:00+01:00";
		const exception = structuredClone(stored);
		exception.tools.enola.exception.added = "January 1, 2026";
		const miss = structuredClone(stored);
		miss.misses[0].record = "";
		for (const [label, state] of Object.entries({ named, platform, repository, date, exception, miss }))
			expect(() => ToolManifest.parse(JSON.stringify(state)), label).toThrow(ToolManifestError);
	});
	it("links every execution miss to its comparison finding", () => {
		const manifest = ToolManifest.parse(JSON.stringify(stored));
		for (const miss of manifest.toJSON().misses) {
			expect(miss.record).toMatch(/^packages\/evals\/comparisons\/[^/]+\.md$/);
			const record = readFileSync(new URL(`../../../${miss.record}`, import.meta.url), "utf8");
			expect(record).toContain(miss.finding);
		}
	});

	it("reads all four pins and the recorded execution misses", () => {
		const manifest = ToolManifest.parse(JSON.stringify(stored));
		expect(manifest.tool("enola").version).toBe("0.4.27");
		expect(Object.keys(manifest.tool("enola").platforms)).toHaveLength(4);
		expect(manifest.artifact("enola", "darwin-arm64").binary).toBe("enola-0.4.27-darwin-arm64");
		expect(manifest.toJSON().misses.map((miss) => miss.finding)).toEqual([
			"M1",
			"M2",
			"L1",
			"L2",
			"L3",
			"L4",
			"L5",
			"L6",
			"L8",
			"L10",
			"L11",
			"L12",
			"L13",
		]);
		expect(() => manifest.tool("constructor")).toThrow("No tool");
		expect(() => manifest.artifact("enola", "windows-amd64")).toThrow("no pin");
	});

	it.each([
		{ url: "http://github.com/x" },
		{ url: "https://github.com/other/repo/releases/download/v0.4.27/enola.tar.gz" },
		{ url: "https://github.com/enola-labs/enola/releases/download/v9/enola.tar.gz" },
		{ binary: "enola\0hidden" },
		{ url: "https://example.com/x" },
		{ url: "https://github.com:8443/x" },
		{ sha256: "x" },
		{ binary: "../enola" },
		{ binary: "/enola" },
		{ binary: "dir/../enola" },
		{ url: "https://github.com/enola-labs/enola/releases/download/v0.4.27/enola.tar.gz?x=1" },
		{ url: "https://github.com/enola-labs/enola/releases/download/v0.4.27/enola.tar.gz#x" },
		{ binary: "dir\\enola" },
		{ binary: "./enola" },
		{ binary: "a//b" },
		{ binary: "enola/" },
	])("refuses unsafe downloads %j", (change) => {
		const state = structuredClone(stored);
		Object.assign(state.tools.enola.platforms["darwin-arm64"], change);
		expect(() => ToolManifest.parse(JSON.stringify(state))).toThrow();
	});

	it("refuses ranges, unknown keys, invalid timestamps, and future exceptions", () => {
		for (const change of [{ version: "^0.4.27" }, { unexpected: true }, { published: "yesterday" }]) {
			const state = structuredClone(stored);
			Object.assign(state.tools.enola, change);
			expect(() => ToolManifest.parse(JSON.stringify(state))).toThrow();
		}
		const state = structuredClone(stored);
		state.tools.enola.exception.added = "2026-10-09";
		expect(ToolManifest.parse(JSON.stringify(state)).check(Date.parse("2026-10-06T12:00:00Z"), 2)).toHaveLength(1);
	});

	it("refuses a young release without an exception and permits it after two days", () => {
		const state = structuredClone(stored);
		delete state.tools.enola.exception;
		const manifest = ToolManifest.parse(JSON.stringify(state));
		expect(manifest.check(Date.parse("2026-10-06T12:00:00Z"), 2)).toHaveLength(1);
		expect(manifest.check(Date.parse("2026-10-07T16:37:02Z"), 2)).toEqual([]);
		expect(ToolManifest.parse(JSON.stringify(stored)).check(Date.parse("2026-10-06T12:00:00Z"), 2)).toEqual([]);
	});
});
