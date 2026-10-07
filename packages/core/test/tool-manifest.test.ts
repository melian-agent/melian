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
	it.each([
		{ label: "a tool the manifest does not know", change: { tool: "bogus" } },
		{ label: "a record outside packages/evals/comparisons/", change: { record: "docs/design.md" } },
		{ label: "a record that climbs out of the directory", change: { record: "packages/evals/comparisons/../x.md" } },
		{ label: "a malformed finding ID", change: { finding: "ZZ" } },
		{ label: "an empty finding ID", change: { finding: "" } },
	])("refuses a miss with $label", ({ change }) => {
		const state = structuredClone(stored);
		Object.assign(state.misses[0], change);
		try {
			ToolManifest.parse(JSON.stringify(state));
			throw new Error("accepted invalid miss");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolManifestError);
			expect(error).toMatchObject({ code: "invalidManifest" });
		}
	});

	it("refuses a duplicate miss finding with a typed error", () => {
		const state = structuredClone(stored);
		state.misses.push(structuredClone(state.misses[0]));
		try {
			ToolManifest.parse(JSON.stringify(state));
			throw new Error("accepted duplicate miss");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolManifestError);
			expect(error).toMatchObject({ code: "invalidManifest", message: expect.stringContaining("duplicate miss") });
		}
	});

	it("round-trips a well-formed list of misses through toJSON", () => {
		const misses = [
			{ record: "packages/evals/comparisons/a.md", finding: "M1", tool: "repro-run" },
			{ record: "packages/evals/comparisons/a.md", finding: "L10", tool: "tests" },
			{ record: "packages/evals/comparisons/b-2.md", finding: "M1", tool: "none" },
		];
		const state = { ...structuredClone(stored), misses };
		expect(ToolManifest.parse(JSON.stringify(state)).toJSON().misses).toEqual(misses);
		expect(ToolManifest.parse(JSON.stringify({ ...state, misses: [] })).toJSON().misses).toEqual([]);
	});

	it("reads all four pins and the recorded execution misses", () => {
		const manifest = ToolManifest.parse(JSON.stringify(stored));
		expect(manifest.tool("enola").version).toBe("0.4.27");
		expect(Object.keys(manifest.tool("enola").platforms)).toHaveLength(4);
		expect(manifest.artifact("enola", "darwin-arm64").binary).toBe("enola-0.4.27-darwin-arm64");
		expect(manifest.toJSON().misses.map((miss) => miss.finding)).toEqual([
			"C1",
			"C2",
			"C3",
			"C4",
			"C5",
			"C6",
			"C7",
			"C8",
			"C10",
			"C12",
			"C13",
			"C14",
			"C15",
		]);
		expect(() => manifest.tool("constructor")).toThrow("No tool");
		expect(() => manifest.artifact("enola", "windows-amd64")).toThrow("no pin");
	});

	it("names only findings that have a row in the record it cites", () => {
		const manifest = ToolManifest.parse(JSON.stringify(stored));
		const misses = manifest.toJSON().misses;
		expect(misses.length).toBeGreaterThan(0);
		for (const miss of misses) {
			const text = readFileSync(new URL(`../../../${miss.record}`, import.meta.url), "utf8");
			const firstCells = text
				.split("\n")
				.filter((line) => line.startsWith("|"))
				.map((line) => line.split("|")[1]?.trim());
			expect(firstCells, `${miss.record} has no row for ${miss.finding}`).toContain(miss.finding);
		}
	});

	it.each([
		{ url: "http://github.com/enola-labs/enola/releases/download/v0.4.27/enola.tar.gz" },
		{ url: "https://github.com/other/repo/releases/download/v0.4.27/enola.tar.gz" },
		{ url: "https://github.com/enola-labs/enola/releases/download/v9/enola.tar.gz" },
		{ binary: "enola\0hidden" },
		{ url: "https://example.com/enola-labs/enola/releases/download/v0.4.27/enola.tar.gz" },
		{ url: "https://github.com:8443/enola-labs/enola/releases/download/v0.4.27/enola.tar.gz" },
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

	it("refuses a download URL whose dot-segments resolve outside the declared repository and tag", () => {
		const base = "https://github.com/enola-labs/enola/releases/download/v0.4.27/";
		for (const url of [
			`${base}../../../../../other/repo/releases/download/v1/x.tar.gz`,
			`${base}%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/other/repo/releases/download/v1/x.tar.gz`,
			`${base}./x.tar.gz`,
		]) {
			const state = structuredClone(stored);
			state.tools.enola.platforms["darwin-arm64"].url = url;
			expect(() => ToolManifest.parse(JSON.stringify(state)), url).toThrow(ToolManifestError);
		}
		const state = structuredClone(stored);
		state.tools.enola.source.repository = "../x";
		for (const pin of Object.values(state.tools.enola.platforms) as { url: string }[])
			pin.url = "https://github.com/x/releases/download/v0.4.27/x.tar.gz";
		state.tools.enola.source.tag = "v0.4.27";
		expect(() => ToolManifest.parse(JSON.stringify(state))).toThrow(ToolManifestError);
		state.tools.enola.source.repository = "enola-labs/..";
		expect(() => ToolManifest.parse(JSON.stringify(state))).toThrow(ToolManifestError);
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

	it.each([
		["a clock that is not a number", Number.NaN, 2],
		["a window that is not a number", 1_000, Number.NaN],
		["a negative window", 1_000, -1],
	])("refuses %s", (_label, now, window) => {
		const manifest = ToolManifest.parse(JSON.stringify(stored));
		expect(() => manifest.check(now, window)).toThrow(ToolManifestError);
		try {
			manifest.check(now, window);
		} catch (error) {
			expect(error).toMatchObject({ code: "quarantine" });
		}
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
