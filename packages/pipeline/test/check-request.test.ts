import { defaultConfig, deterministicChecks } from "@melian-agent/core";
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
	it("keys every input but the display-only configuration and the paths that name the host", () => {
		const excluded = ["config.output", "config.publish.emoji", "mutation.stryker.source.path"];
		expect(keyCoverage(checkRequest, sample, { vary, excluded })).toEqual([]);
	});

	it("keys a run the same whatever the terminal and comments show", () => {
		const shown = checkRequest({
			...sample,
			config: { ...defaultConfig, output: { emoji: "off" }, publish: { ...defaultConfig.publish, emoji: "off" } },
		});
		expect(shown.key).toBe(checkRequest(sample).key);
	});

	it("keys a run the same from another checkout or preference file", () => {
		const moved = checkRequest({
			...sample,
			source: { kind: "worktree", preferences: "/home/other/.config/melian/config.yaml" },
			mutation: sample.mutation && {
				...sample.mutation,
				stryker: { ...sample.mutation.stryker, source: { from: "checkout", path: "/elsewhere/x" } },
			},
		});
		const here = checkRequest({
			...sample,
			source: { kind: "worktree", preferences: "/home/me/.config/melian/config.yaml" },
		});
		expect(moved.key).toBe(here.key);
		expect(JSON.stringify(moved.request)).not.toMatch(/elsewhere|home/);
	});

	it("keys a run without mutation testing apart from one with it", () => {
		const { mutation: _, ...plain } = sample;
		const request = checkRequest(plain);
		expect(request.request).not.toHaveProperty("mutation");
		expect(request.key).not.toBe(checkRequest(sample).key);
		expect(request.producer).toBe("check");
	});

	it("keys the version of Melian's own code for every check it runs", () => {
		const { checks } = checkRequest(sample).request as { checks: Record<string, unknown> };
		expect(Object.keys(checks).sort()).toEqual([...deterministicChecks].sort());
		for (const version of Object.values(checks)) expect(version).toEqual(expect.any(Number));
	});

	it("holds a fractional setting as its decimal text, since a request's numbers are safe integers", () => {
		const request = checkRequest(sample).request as { config: { comparison: { retirement: { recall: unknown } } } };
		expect(request.config.comparison.retirement.recall).toBe(String(defaultConfig.comparison.retirement.recall));
	});
});
