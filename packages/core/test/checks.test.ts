import { existsSync } from "node:fs";
import { CheckError, checksOfTier, defaultConfig, deterministicChecks } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

describe("checksOfTier", () => {
	it("expands nested tiers and the static group in order, without repeats", () => {
		expect(checksOfTier(defaultConfig, "full")).toEqual([
			"guardrails",
			"static.biome",
			"static.tsc",
			"lens.correctness",
			"lens.contracts",
		]);
		expect(checksOfTier({ tiers: { a: ["static.tsc", "b", "static.tsc"], b: ["lens.x"] } }, "a")).toEqual([
			"static.tsc",
			"lens.x",
		]);
		expect(checksOfTier({ tiers: { a: ["static.tsc", "b"], b: ["static"] } }, "a")).toEqual([
			"static.tsc",
			"static.biome",
		]);
	});

	it("passes decision questions through for the review to account for", () => {
		expect(checksOfTier({ tiers: { fast: ["guardrails", "decisions.fast"] } }, "fast")).toEqual([
			"guardrails",
			"decisions.fast",
		]);
	});

	it("names in the default tiers only checks that ship", () => {
		const builtinLens = (name: string) => existsSync(new URL(`../lenses/${name}/LENS.md`, import.meta.url));
		const deterministic: readonly string[] = deterministicChecks;
		for (const tier of Object.keys(defaultConfig.tiers)) {
			for (const check of checksOfTier(defaultConfig, tier)) {
				const lens = check.startsWith("lens.") ? check.slice("lens.".length) : undefined;
				expect(lens === undefined ? deterministic.includes(check) : builtinLens(lens), check).toBe(true);
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
