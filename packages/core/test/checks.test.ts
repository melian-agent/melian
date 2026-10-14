import { existsSync } from "node:fs";
import { CheckError, checksOfTier, defaultConfig, deterministicChecks } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

describe("checksOfTier", () => {
	it("expands nested tiers and the static group in order, without repeats", () => {
		expect(checksOfTier(defaultConfig, "full")).toEqual([
			"guardrails",
			"static.biome",
			"static.tsc",
			"decisions.fast",
			"lens.correctness",
			"lens.contracts",
			"lens.trust-boundary",
			"lens.removed-behaviour",
			"lens.tests",
			"lens.conventions",
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

	it("leaves static.mutation out of the static group, so only a tier that names it runs it", () => {
		expect(checksOfTier({ tiers: { a: ["static"] } }, "a")).toEqual(["static.biome", "static.tsc"]);
		expect(checksOfTier({ tiers: { a: ["static", "static.mutation"] } }, "a")).toEqual([
			"static.biome",
			"static.tsc",
			"static.mutation",
		]);
		expect(deterministicChecks).toContain("static.mutation");
	});

	it("passes decision questions through for the review to account for", () => {
		expect(checksOfTier({ tiers: { fast: ["guardrails", "decisions.fast"] } }, "fast")).toEqual([
			"guardrails",
			"decisions.fast",
		]);
	});

	it("names in the default tiers only checks that ship, and decisions.fast", () => {
		const builtinLens = (name: string) => existsSync(new URL(`../lenses/${name}/LENS.md`, import.meta.url));
		// decisions.fast is an allowed skip until a decision provider is configured.
		const deterministic: readonly string[] = [...deterministicChecks, "decisions.fast"];
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
