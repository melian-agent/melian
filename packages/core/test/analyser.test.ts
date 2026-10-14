import { describe, expect, it } from "vitest";
import { analyserOf, switchOffs } from "../src/analyser.ts";
import { CheckError } from "../src/errors.ts";
import { maxProgram } from "../src/pattern.ts";

it("names Enola policy inputs without claiming other analyser files", () => {
	for (const path of ["enola.yaml", "mcp-arch.yaml", "enola/constraints/layers.yaml", ".enola/suppressions.yaml"])
		expect(analyserOf(path)).toBe("Enola");
	expect(analyserOf("biome.json")).toBe("Biome");
	expect(analyserOf("stryker.config.json")).toBe("Stryker");
	expect(analyserOf("packages/a/stryker.config.mjs")).toBe("Stryker");
	expect(analyserOf("src/a.ts")).toBeUndefined();
	expect(analyserOf("not-stryker.config.json")).toBeUndefined();
});

it("names the Vitest files a Stryker run loads, by their whole basename", () => {
	const drives = "the Vitest run Stryker drives";
	for (const path of [
		"vitest.config.ts",
		"vitest.config.mts",
		"vitest.stryker.config.ts",
		"packages/a/vitest.config.js",
		"scripts/stryker-test-names.mjs",
		"stryker-test-names.cjs",
		"vitest.setup.ts",
		"packages/a/vitest.setup.mts",
		"vitest.setupFiles.ts",
		"vitest.stryker.setup.ts",
		"stryker.setup.mjs",
	])
		expect(analyserOf(path), path).toBe(drives);
	for (const path of [
		"myvitest.config.ts",
		"not-stryker-test-names.mjs",
		"vitestXconfig.ts",
		"vitest.strykerXconfig.ts",
		"vitest.stryker.configuration",
		"myvitest.setup.ts",
		"setup.ts",
		"test/setup.ts",
		"mystryker.setup.ts",
		"vitest.stryker.ts",
		"stryker-test-namesX.mjs",
		"strykerXtest-names.mjs",
		"stryker-test-names",
	])
		expect(analyserOf(path), path).toBeUndefined();
});

describe("Biome exclusions", () => {
	const biome = (ignore: string[]) => JSON.stringify({ files: { ignore } });
	const oversized = "a".repeat(maxProgram - 6);
	const refusal = {
		code: "unreadable",
		check: "guardrails",
		message: expect.stringContaining("biome.json holds a glob Melian refuses"),
	};

	it("refuses a later exclusion even when the first matches every changed path", () => {
		expect(() => switchOffs("biome.json", biome([]), biome(["**", oversized]), ["src/a.ts"])).toThrowError(
			CheckError,
		);
		expect(() => switchOffs("biome.json", biome([]), biome(["**", oversized]), ["src/a.ts"])).toThrowError(
			expect.objectContaining(refusal),
		);
	});

	it("refuses the directory form even when the bare glob matches", () => {
		expect(() => switchOffs("biome.json", biome([]), biome([oversized]), [oversized])).toThrowError(
			expect.objectContaining(refusal),
		);
	});

	it("accepts the directory form at the compiler limit", () => {
		const atLimit = "a".repeat(maxProgram - 7);
		expect(switchOffs("biome.json", biome([]), biome([atLimit]), [atLimit])).toEqual([
			`It makes Biome ignore ${atLimit}, which this change touches.`,
		]);
	});

	it("compiles exclusions even when no changed path belongs to that configuration", () => {
		expect(() => switchOffs("web/biome.json", biome([]), biome([oversized]), ["src/a.ts"])).toThrowError(CheckError);
	});

	it("refuses the base's exclusion even when the head excludes nothing", () => {
		expect(() => switchOffs("biome.json", biome([oversized]), biome([]), ["src/a.ts"])).toThrowError(CheckError);
	});

	it("normalises directory exclusions and compares them with the base", () => {
		expect(
			switchOffs("web/biome.json", biome(["./src/kept///"]), biome(["./src///"]), [
				"web/src/a.ts",
				"web/src/kept/b.ts",
				"other.ts",
			]),
		).toEqual(["It makes Biome ignore src/a.ts, which this change touches."]);
	});
});
