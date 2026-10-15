import { describe, expect, it } from "vitest";
import { classify, type Model } from "../src/triage.ts";

const ticket = { title: "Checkout fails", body: "Every card is declined.", priority: "P3" as const };

describe("classify", () => {
	it("returns the priority the model answers", async () => {
		const model: Model = { ask: async () => "P1" };
		expect(await classify(ticket, model)).toBe("P1");
	});

	it("refuses an answer that is not a priority", async () => {
		const model: Model = { ask: async () => "urgent" };
		await expect(classify(ticket, model)).rejects.toThrow("not a priority");
	});
});
