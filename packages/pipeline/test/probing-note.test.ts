import { describe, expect, it } from "vitest";
import { probingNote } from "../src/review.ts";

// A version 7 task stored a probing run's skipped attacks as a count, which its record renders without their numbers.
describe("a probing run's note", () => {
	it("names the skipped attacks a list holds", () => {
		expect(probingNote({ attacks: 3, probes: 2, milliseconds: 1500, skipped: [1, 3], unanswered: [] })).toBe(
			"it planned 3 attacks and ran 2 probes in 1.5 s, and skipped attacks 1, 3",
		);
	});

	it("counts the skipped attacks a version 7 task stored as a number", () => {
		expect(probingNote({ attacks: 3, probes: 1, milliseconds: 1500, skipped: 2, unanswered: [] })).toBe(
			"it planned 3 attacks and ran 1 probe in 1.5 s, and skipped 2 attacks",
		);
	});
});
