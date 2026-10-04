import { describe, expect, it } from "vitest";
import { type Hunk, overlapsChange } from "../src/overlap.ts";

// Lines 10 to 12 at the base became lines 10 and 11 at head.
const edit: Hunk = { oldStart: 10, oldLines: 3, newStart: 10, newLines: 2 };

describe("overlapsChange", () => {
	it("counts a location on a line the change wrote", () => {
		expect(overlapsChange([edit], { line: 11 })).toBe(true);
	});

	it("counts a range that reaches into the change", () => {
		expect(overlapsChange([edit], { line: 5, endLine: 10 })).toBe(true);
	});

	it("does not count a line just past the change", () => {
		expect(overlapsChange([edit], { line: 12 })).toBe(false);
	});
});
