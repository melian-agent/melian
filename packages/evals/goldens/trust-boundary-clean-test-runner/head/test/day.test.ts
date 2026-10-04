import { describe, expect, it } from "vitest";
import { dayOf } from "../src/day.ts";

describe("dayOf", () => {
	it("names the day an instant falls on", () => {
		expect(dayOf(new Date("2026-10-04T23:30:00Z"))).toBe("2026-10-04");
	});
});
