import { defaultConfig, deterministicChecks, KeyedRequest, type RecordJson } from "@melian-agent/core";
import { keyCoverage } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";
import { type CheckRequestInput, checkRequest, checkReusable, writesFixedText } from "../src/check-request.ts";

const sample: CheckRequestInput = {
	config: defaultConfig,
	source: { kind: "revision", commit: "a".repeat(40) },
	tools: { enola: { version: "0.4.37", sha256: "b".repeat(64) } },
	analysers: { biome: { from: "checkout", version: "2.5.0" }, tsc: { from: "melian", version: "5.9.3" } },
	install: {
		digests: { "package-lock.json": "c".repeat(64), "node_modules/.package-lock.json": "d".repeat(64) },
		identified: true,
	},
	mutation: {
		stryker: { version: "10.0.0", installation: { core: "10.0.0" }, source: { from: "checkout", path: "/repo/x" } },
		writer: { trusted: true, by: "writer" },
		cold: false,
	},
	host: { platform: "linux", arch: "x64", node: "24.1.0", caseFolds: false },
	lang: "en_AU.UTF-8",
	policy: [{ file: "pay/melian.yaml", text: "tiers: { fast: [guardrails] }\n" }],
};

// The default configuration holds empty lists and maps; a change to one is still a change of configuration.
const vary = (_path: string, value: unknown) =>
	Array.isArray(value) ? ["x"] : typeof value === "object" && value !== null ? { x: "x" } : undefined;

describe("checkRequest", () => {
	it("keys every input but the display-only configuration, and the paths that name the host", () => {
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

	it("keys the tools' locale only when mutation runs the head's tests", () => {
		const { mutation: _, ...plain } = sample;
		expect(checkRequest({ ...sample, lang: "C.UTF-8" }).key).not.toBe(checkRequest(sample).key);
		expect(checkRequest({ ...sample, lang: null }).key).not.toBe(checkRequest(sample).key);
		expect(checkRequest({ ...plain, lang: "C.UTF-8" }).key).toBe(checkRequest(plain).key);
		expect(checkRequest({ ...plain, lang: null }).key).toBe(checkRequest(plain).key);
		expect(checkRequest(plain).request).not.toHaveProperty("lang");
	});

	it("keys the version of Melian's own code for every check it runs", () => {
		const { checks } = checkRequest(sample).request as { checks: Record<string, unknown> };
		expect(Object.keys(checks).sort()).toEqual([...deterministicChecks].sort());
		for (const version of Object.values(checks)) expect(version).toEqual(expect.any(Number));
	});

	it("keys Enola and the mutation check past the build whose findings held their tools' text", () => {
		const { checks } = checkRequest(sample).request as { checks: Record<string, number> };
		expect(checks["static.enola"]).toBeGreaterThanOrEqual(2);
		expect(checks["static.mutation"]).toBeGreaterThanOrEqual(2);
	});

	it("keys Enola past the build that ran a head's own recipes, so no run that build stored is reused", () => {
		const { checks } = checkRequest(sample).request as { checks: Record<string, number> };
		expect(checks["static.enola"]).toBeGreaterThanOrEqual(3);
	});

	it("keys guardrails past the build whose package.json notice named no npm script", () => {
		const { checks } = checkRequest(sample).request as { checks: Record<string, number> };
		expect(checks.guardrails).toBeGreaterThanOrEqual(2);
	});

	it("keys Enola past the build that dropped a base policy file with a newline in its name", () => {
		const { checks } = checkRequest(sample).request as { checks: Record<string, number> };
		expect(checks["static.enola"]).toBe(5);
	});

	it("marks a run not reusable under an unread policy or an unidentified install, and leaves a request with no policy unchanged", () => {
		expect(checkReusable({ ...sample, policy: "unread" })).toBe(false);
		expect(checkReusable(sample)).toBe(true);
		expect(checkReusable({ ...sample, install: { ...sample.install, identified: false } })).toBe(false);
		expect(checkRequest({ ...sample, policy: "unread" }).key).not.toBe(checkRequest(sample).key);
		const { policy: _, ...revision } = sample;
		expect(checkReusable(revision)).toBe(true);
		expect(checkRequest(revision).request).not.toHaveProperty("policy");
		expect(checkRequest({ ...revision, policy: undefined }).key).toBe(checkRequest(revision).key);
	});

	it("holds a fractional setting as its decimal text, since a request's numbers are safe integers", () => {
		const request = checkRequest(sample).request as { config: { comparison: { retirement: { recall: unknown } } } };
		expect(request.config.comparison.retirement.recall).toBe(String(defaultConfig.comparison.retirement.recall));
	});
});

describe("writesFixedText", () => {
	const asked = (request: RecordJson, producer = "check") => KeyedRequest.of<RecordJson>(producer, request);

	it.each(["static.biome", "static.tsc", "static.enola", "static.mutation"])(
		"proves %s from version 2 of its check, and not from version 1",
		(check) => {
			expect(writesFixedText(asked({ checks: { [check]: 2 } }), check)).toBe(true);
			expect(writesFixedText(asked({ checks: { [check]: 3 } }), check)).toBe(true);
			expect(writesFixedText(asked({ checks: { [check]: 1 } }), check)).toBe(false);
		},
	);

	it.each<[string, RecordJson, string?]>([
		["another producer's request", { checks: { "static.biome": 2 } }, "lens"],
		["a request with no checks", {}],
		["a request whose checks are null", { checks: null }],
		["a request whose checks are a number", { checks: 2 }],
		["a request that names the check's version as text", { checks: { "static.biome": "2" } }],
		["a request that names another check", { checks: { "static.tsc": 2 } }],
	])("proves nothing from %s", (_, request, producer) => {
		expect(writesFixedText(asked(request, producer), "static.biome")).toBe(false);
	});

	it("proves nothing for a check that has no fixed-text version", () => {
		expect(writesFixedText(asked({ checks: { guardrails: 9 } }), "guardrails")).toBe(false);
	});
});
