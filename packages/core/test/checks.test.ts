import { CheckError, checksOfTier, defaultConfig } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

describe("checksOfTier", () => {
	it("expands nested tiers and the static group in order, without repeats", () => {
		expect(checksOfTier(defaultConfig, "full")).toEqual([
			"guardrails",
			"static.biome",
			"static.tsc",
			"decisions.fast",
			"lens.correctness",
			"lens.security",
			"lens.contracts",
			"lens.conventions",
		]);
		expect(checksOfTier({ tiers: { a: ["static.tsc", "b"], b: ["static"] } }, "a")).toEqual([
			"static.tsc",
			"static.biome",
		]);
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
