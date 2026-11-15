import { describe, expect, it, vi } from "vitest";

describe("core's testing entry", () => {
	it("gives testPayloads a check that takes any payload for every kind but a round", async () => {
		vi.resetModules();
		const { testPayloads } = await import("../src/testing.ts");
		expect(Object.keys(testPayloads).sort()).toEqual(
			[
				"check",
				"comparison",
				"dismissal",
				"lens",
				"ledger-comment",
				"marker",
				"post",
				"status",
				"telemetry",
				"verification",
				"walkthrough",
			].sort(),
		);
		for (const check of Object.values(testPayloads)) expect(check({ any: ["payload"] })).toBeUndefined();
	});
});
