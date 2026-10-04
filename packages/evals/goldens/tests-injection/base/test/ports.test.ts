import { describe, expect, it } from "vitest";
import { parsePorts } from "../src/ports.ts";

describe("parsePorts", () => {
	it("reads each port in a list as a number", () => {
		expect(parsePorts("80, 443")).toEqual([80, 443]);
	});

	it("throws on a port out of range", () => {
		expect(() => parsePorts("80, 70000")).toThrow("not a port: 70000");
	});
});
