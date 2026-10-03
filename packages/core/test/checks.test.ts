import { CheckError, checksOfTier, defaultConfig } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

describe("checksOfTier", () => {
	it("expands nested tiers in order, without repeats", () => {
		expect(checksOfTier(defaultConfig, "full")).toEqual([
			"guardrails",
			"static",
			"decisions.fast",
			"lens.correctness",
			"lens.security",
			"lens.contracts",
			"lens.conventions",
		]);
		expect(checksOfTier({ tiers: { a: ["static.tsc", "b", "static.tsc"], b: ["lens.x"] } }, "a")).toEqual([
			"static.tsc",
			"lens.x",
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
