import { expect, it } from "vitest";
import { analyserOf } from "../src/analyser.ts";

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
