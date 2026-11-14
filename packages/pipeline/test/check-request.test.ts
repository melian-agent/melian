import { defaultConfig } from "@melian-agent/core";
import { keyCoverage } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";
import { type CheckRequestInput, checkRequest } from "../src/check-request.ts";

const sample: CheckRequestInput = {
	config: defaultConfig,
	source: { kind: "revision", commit: "a".repeat(40) },
	tools: { enola: { version: "0.4.37", sha256: "b".repeat(64) } },
	analysers: { biome: { from: "checkout", version: "2.5.0" }, tsc: { from: "melian", version: "5.9.3" } },
	mutation: {
		stryker: { version: "10.0.0", installation: { core: "10.0.0" }, source: { from: "checkout", path: "/repo/x" } },
		writer: { trusted: true, by: "writer" },
		cold: false,
	},
	host: { platform: "linux", arch: "x64", node: "24.1.0", caseFolds: false },
};

// The default configuration holds empty lists and maps; a change to one is still a change of configuration.
const vary = (_path: string, value: unknown) =>
	Array.isArray(value) ? ["x"] : typeof value === "object" && value !== null ? { x: "x" } : undefined;

describe("checkRequest", () => {
	it("keys every input but the display-only configuration", () => {
		const excluded = ["config.output", "config.publish.emoji"];
		expect(keyCoverage(checkRequest, sample, { vary, excluded })).toEqual([]);
	});

	it("keys a run the same whatever the terminal and comments show", () => {
		const shown = checkRequest({
			...sample,
			config: { ...defaultConfig, output: { emoji: "off" }, publish: { ...defaultConfig.publish, emoji: "off" } },
		});
		expect(shown.key).toBe(checkRequest(sample).key);
	});

	it("keys a run without mutation testing apart from one with it", () => {
		const { mutation: _, ...plain } = sample;
		const request = checkRequest(plain);
		expect(request.request).not.toHaveProperty("mutation");
		expect(request.key).not.toBe(checkRequest(sample).key);
		expect(request.producer).toBe("check");
	});

	it("holds a fractional setting as its decimal text, since a request's numbers are safe integers", () => {
		const request = checkRequest(sample).request as { config: { comparison: { retirement: { recall: unknown } } } };
		expect(request.config.comparison.retirement.recall).toBe(String(defaultConfig.comparison.retirement.recall));
	});
});
