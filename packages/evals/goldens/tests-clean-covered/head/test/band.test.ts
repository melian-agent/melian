import { describe, expect, it } from "vitest";
import { parseBand } from "../src/band.ts";

describe("parseBand", () => {
	it("reads both ends", () => {
		expect(parseBand({ drop: 0.2, accept: 0.8 })).toEqual({ drop: 0.2, accept: 0.8 });
	});

	it("refuses an end outside 0 to 1", () => {
		expect(() => parseBand({ drop: -0.1, accept: 0.8 })).toThrow("each end of a band is a number from 0 to 1");
	});

	it("refuses a drop above the accept", () => {
		expect(() => parseBand({ drop: 0.9, accept: 0.5 })).toThrow("a band's drop must not exceed its accept");
	});
});
