import { existsSync } from "node:fs";
import { CheckError, checksOfTier, defaultConfig } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

// The checks Melian runs without a model, `static`, the group pull request #18 expands into the static tools, and
// `decisions.fast`, an allowed skip until a decision provider is configured.
const deterministicChecks = ["guardrails", "static", "static.biome", "static.tsc", "decisions.fast"];

describe("checksOfTier", () => {
	it("expands nested tiers in order, without repeats", () => {
		expect(checksOfTier(defaultConfig, "full")).toEqual([
			"guardrails",
			"static",
			"decisions.fast",
			"lens.correctness",
			"lens.contracts",
		]);
		expect(checksOfTier({ tiers: { a: ["static.tsc", "b", "static.tsc"], b: ["lens.x"] } }, "a")).toEqual([
			"static.tsc",
			"lens.x",
		]);
	});

	it("names in the default tiers only checks that ship", () => {
		const builtinLens = (name: string) => existsSync(new URL(`../lenses/${name}/LENS.md`, import.meta.url));
		for (const tier of Object.keys(defaultConfig.tiers)) {
			for (const check of checksOfTier(defaultConfig, tier)) {
				const lens = check.startsWith("lens.") ? check.slice("lens.".length) : undefined;
				expect(lens === undefined ? deterministicChecks.includes(check) : builtinLens(lens), check).toBe(true);
			}
		}
	});

	it("treats a check named after an Object.prototype member as any other name", () => {
		expect(checksOfTier({ tiers: { fast: ["constructor", "toString", "__proto__"] } }, "fast")).toEqual([
			"constructor",
			"toString",
			"__proto__",
		]);
	});

	it("refuses an unknown tier and a tier that includes itself", () => {
		expect(() => checksOfTier(defaultConfig, "nope")).toThrow(CheckError);
		expect(() => checksOfTier({ tiers: { a: ["b"], b: ["a"] } }, "a")).toThrow(/tier a includes b includes a/);
	});
});
