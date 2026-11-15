import { readFileSync } from "node:fs";
import type { LensToolName, Severity } from "@melian-agent/core";
import { keyCoverage } from "@melian-agent/core/testing";
import { describe, expect, it, vi } from "vitest";
import { piVersions } from "../src/harness.ts";
import { continuePrompt, lensRequest } from "../src/lens-request.ts";
import {
	injectionPolicySection,
	lensListedTools,
	recordPlan,
	reportFinding,
	runProbe,
	skipAttack,
} from "../src/lens-tools.ts";
import { probingWording } from "../src/probing.ts";
import { identityNonce, injectionPolicy } from "../src/untrusted.ts";

const sample = {
	run: {
		key: "correctness@1@careful",
		name: "correctness",
		version: "1",
		level: "careful",
		band: "quick-thorough",
		route: [{ provider: "anthropic", modelId: "claude-a" }],
		thinking: "high",
		verify: true,
		instructions: "Find defects.",
		standards: ["docs/guidelines/pipeline.md"],
		standardsOmitted: true,
		tools: ["read_file", "search"] as LensToolName[],
		severities: ["P1", "P2"],
		rules: [{ id: "logic-error", description: "A wrong result." }],
		budget: { findings: 8, tokens: 600_000, tools: 90 },
		coverage: { scope: "files", paths: ["src/**"], nearer: ["src/a/**"], moved: ["old/a.ts"] },
		prompt: "+const total = price * count;",
		unread: "git could not read the head",
		probe: {
			route: [{ provider: "openai-codex", modelId: "gpt-b" }],
			thinking: "low",
			instructions: "Run the plan.",
			environment: {
				writer: { trusted: true, by: "reviewer" },
				trustWriters: true,
				timeout: 30,
				read: ["/usr/lib"],
				host: { platform: "linux", sandbox: "bubblewrap", arch: "x64", node: "24.1.0" },
			},
			onLevelTier: true,
		},
	},
	nonce: "a".repeat(24),
	base: "b".repeat(40),
	head: "c".repeat(40),
	escalateAt: "P1" as Severity,
	escalation: { next: "d".repeat(64) },
	callers: "## Callers\nsrc/b.ts calls total()",
	standards: {
		sections: [{ path: "AGENTS.md", content: "Keep functions small." }],
		source: { kind: "revision", commit: "b".repeat(40) },
		trusted: "revision",
	},
};

type Sample = typeof sample;

// The run as the review builds it: whatever is quoted, inside boundaries of the nonce it is rendered under, with the
// caller section when asked for it.
function build(input: Sample, request = lensRequest) {
	const { escalation, callers, ...rest } = input;
	return request({
		...rest,
		...(escalation === undefined ? {} : { escalation }),
		run: (nonce, withCallers) => ({
			...input.run,
			instructions: `<untrusted-${nonce}>${input.run.instructions}</untrusted-${nonce}>${withCallers ? callers : ""}`,
			prompt: `<untrusted-${nonce}>${input.run.prompt}</untrusted-${nonce}>`,
		}),
	});
}

const specOf = ({
	name,
	description,
	parameters,
	outputLimits,
	argumentBytes,
}: {
	name: string;
	description: string;
	parameters: unknown;
	outputLimits?: unknown;
	argumentBytes?: number;
}) => ({
	name,
	description,
	parameters,
	...(outputLimits === undefined ? {} : { outputLimits }),
	...(argumentBytes === undefined ? {} : { argumentBytes }),
});

describe("lensRequest", () => {
	it("keys every input but the nonce", () => {
		const tools = ["read_file", "search", "list_files", "graph_definitions"];
		const vary = (name: string, value: unknown) =>
			name.startsWith("run.tools.") ? tools.find((tool) => tool !== value) : undefined;
		expect(keyCoverage(build, sample, { excluded: ["nonce", "callers"], vary })).toEqual([]);
	});

	it("shows the lens its run under the review's nonce with its callers, and keys it under the fixed one without", () => {
		const asked = build(sample);
		expect(asked.producer).toBe("lens");
		expect(asked.unkeyed.nonce).toBe("a".repeat(24));
		expect(asked.unkeyed.bestEffort).toEqual({
			...sample.run,
			instructions: `<untrusted-${"a".repeat(24)}>Find defects.</untrusted-${"a".repeat(24)}>${sample.callers}`,
			prompt: `<untrusted-${"a".repeat(24)}>+const total = price * count;</untrusted-${"a".repeat(24)}>`,
		});
		expect(asked.request.run).toEqual({
			...sample.run,
			instructions: `<untrusted-${identityNonce}>Find defects.</untrusted-${identityNonce}>`,
			prompt: `<untrusted-${identityNonce}>+const total = price * count;</untrusted-${identityNonce}>`,
		});
		expect(JSON.stringify(asked.request)).not.toContain("a".repeat(24));
	});

	it("keys the system prompt's policy and every tool the run's conversations are offered, by its whole definition", () => {
		const { request } = build(sample);
		expect(request.policy).toEqual({ section: "injection_policy", text: injectionPolicy(identityNonce) });
		expect(request.continue).toBe(continuePrompt);
		expect(request.tools).toEqual(
			[lensListedTools.read_file, lensListedTools.search, reportFinding, recordPlan].map(specOf),
		);
		expect(request.probing).toEqual({
			tools: [lensListedTools.read_file, lensListedTools.search, reportFinding, runProbe, skipAttack].map(specOf),
		});
	});

	it("keys the installed Pi Durable and pi-ai releases, which render the conversation and send it", () => {
		const pins = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies;
		expect(build(sample).request.pi).toEqual({
			durable: pins["@earendil-works/pi-durable"],
			ai: pins["@earendil-works/pi-ai"],
		});
	});

	it("asks again when Pi Durable, pi-ai or the policy's section name changes", () => {
		const before = build(sample).key;
		const versions = piVersions as { durable: string; ai: string };
		const policy = injectionPolicySection as { key: string };
		const changes: [object, string, string][] = [
			[versions, "durable", "9.9.9"],
			[versions, "ai", "9.9.9"],
			[policy, "key", "policy"],
		];
		for (const [target, field, value] of changes) {
			const record = target as Record<string, string>;
			const original = record[field]!;
			try {
				record[field] = value;
				expect(build(sample).key, field).not.toBe(before);
			} finally {
				record[field] = original;
			}
		}
		expect(build(sample).key).toBe(before);
	});

	it("keys each offered tool's output limits and argument bound, and the bounds every tool cuts what it shows to", () => {
		const { request } = build(sample);
		expect(request.limits).toEqual({ shownBytes: 48 * 1024, readLines: 2000 });
		const read = request.tools.find(({ name }) => name === "read_file") as Record<string, unknown>;
		expect(read.outputLimits).toEqual(lensListedTools.read_file.outputLimits);
		expect(read.argumentBytes).toBe(8192);
		const plan = request.tools.find(({ name }) => name === "record_plan") as Record<string, unknown>;
		expect(plan.argumentBytes).toBe(recordPlan.argumentBytes);
		const before = build(sample).key;
		const tool = lensListedTools.read_file as { outputLimits?: { maxBytes?: number; maxLines?: number } };
		const original = tool.outputLimits;
		try {
			tool.outputLimits = { ...original, maxBytes: 1024 };
			expect(build(sample).key).not.toBe(before);
		} finally {
			tool.outputLimits = original;
		}
		expect(build(sample).key).toBe(before);
	});

	it("keys list_mutants by a description that carries its cap, so a new cap asks again", async () => {
		const asking = { ...sample, run: { ...sample.run, tools: ["list_mutants"] as LensToolName[] } };
		const before = build(asking);
		expect(before.request.tools).toContainEqual(specOf(lensListedTools.list_mutants));
		vi.resetModules();
		vi.doMock("../src/mutant-listing.ts", async (original) => ({
			...(await original<object>()),
			maxListedMutants: 100,
		}));
		try {
			const reloaded = await import("../src/lens-request.ts");
			const tools = await import("../src/lens-tools.ts");
			expect(tools.lensListedTools.list_mutants.description).toContain("At most 100 a call");
			expect(build(asking, reloaded.lensRequest).key).not.toBe(before.key);
		} finally {
			vi.doUnmock("../src/mutant-listing.ts");
			vi.resetModules();
		}
	});

	it("offers a run that does not probe no planner tool, and keys no probing text", () => {
		const { probe: _, ...run } = sample.run;
		const { callers: _c, ...rest } = sample;
		const { request } = lensRequest({ ...rest, run: () => run });
		expect(request.tools).toEqual([lensListedTools.read_file, lensListedTools.search, reportFinding].map(specOf));
		expect(request).not.toHaveProperty("probing");
	});

	it("keys a capped escalation apart from one that moves on, and both apart from none", () => {
		const moves = build(sample).key;
		const capped = build({ ...sample, escalation: { cap: "at its ceiling" } as unknown as Sample["escalation"] }).key;
		const none = build({ ...sample, escalation: undefined as unknown as Sample["escalation"] }).key;
		expect(new Set([moves, capped, none]).size).toBe(3);
	});

	it("keys the whole probing wording table for a run that probes or carries its findings on, and only then", () => {
		const { probe: _, ...plain } = sample.run;
		const capped = { cap: "at its ceiling" } as unknown as Sample["escalation"];
		const none = undefined as unknown as Sample["escalation"];
		expect(build(sample).request.wording).toEqual(probingWording);
		expect(build({ ...sample, escalation: none }).request.wording).toEqual(probingWording);
		expect(build({ ...sample, run: plain as Sample["run"] }).request.wording).toEqual(probingWording);
		expect(build({ ...sample, run: plain as Sample["run"], escalation: capped }).request).not.toHaveProperty(
			"wording",
		);
		expect(build({ ...sample, run: plain as Sample["run"], escalation: none }).request).not.toHaveProperty("wording");
	});

	it("writes neither escalation field for a run with no escalation severity and no next run", () => {
		const { escalateAt: _e, ...rest } = sample;
		const { request } = build({ ...rest, escalation: undefined } as unknown as Sample);
		expect(request).not.toHaveProperty("escalateAt");
		expect(request).not.toHaveProperty("escalation");
	});

	it("keys a review whose callers are unavailable as one with them, since they are best effort", () => {
		expect(build({ ...sample, callers: "" }).key).toBe(build(sample).key);
		expect(JSON.stringify(build(sample).request)).not.toContain("calls total()");
	});
});
