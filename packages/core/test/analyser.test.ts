import { expect, it } from "vitest";
import { analyserOf } from "../src/analyser.ts";

it("names Enola policy inputs without claiming other analyser files", () => {
	for (const path of ["enola.yaml", "mcp-arch.yaml", "enola/constraints/layers.yaml", ".enola/suppressions.yaml"])
		expect(analyserOf(path)).toBe("Enola");
	expect(analyserOf("biome.json")).toBe("Biome");
	expect(analyserOf("stryker.config.json")).toBe("Stryker");
	expect(analyserOf("packages/a/stryker.config.mjs")).toBe("Stryker");
	expect(analyserOf("src/a.ts")).toBeUndefined();
});
