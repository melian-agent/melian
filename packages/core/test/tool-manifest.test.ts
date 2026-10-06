import { readFileSync } from "node:fs";
import { ToolManifest } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const stored = JSON.parse(
	JSON.stringify(ToolManifest.parse(readFileSync(new URL("../../../tools.yaml", import.meta.url), "utf8")).toJSON()),
);

describe("ToolManifest", () => {
	it("links every execution miss to its comparison finding", () => {
		const manifest = ToolManifest.parse(JSON.stringify(stored));
		for (const miss of manifest.toJSON().misses) {
			expect(miss.record).toMatch(/^packages\/evals\/comparisons\/[^/]+\.md$/);
			const record = readFileSync(new URL(`../../../${miss.record}`, import.meta.url), "utf8");
			expect(record).toContain(miss.finding);
		}
	});

	it("reads all four pins and an empty needs-execution map", () => {
		const manifest = ToolManifest.parse(JSON.stringify(stored));
		expect(manifest.tool("enola").version).toBe("0.4.27");
		expect(Object.keys(manifest.tool("enola").platforms)).toHaveLength(4);
		expect(manifest.artifact("enola", "darwin-arm64").binary).toBe("enola-0.4.27-darwin-arm64");
		expect(manifest.toJSON().misses).toEqual([]);
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
