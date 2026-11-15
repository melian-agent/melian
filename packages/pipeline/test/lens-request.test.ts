import { keyCoverage } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";
import { continuePrompt, lensRequest } from "../src/lens-request.ts";
import { lensListedTools, recordPlan, reportFinding, runProbe, skipAttack } from "../src/lens-tools.ts";
import { answerPrompt, recordPlanPrompt } from "../src/probing.ts";
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
		tools: ["read_file", "search"],
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
	escalateAt: "P1",
	escalation: { next: "d".repeat(64) },
	graph: { tree: "e".repeat(40), version: "0.4.0", binary: "f".repeat(64), config: "1".repeat(64) },
};

type Sample = typeof sample;

// The run as the review builds it: whatever is quoted, inside boundaries of the nonce it is rendered under.
function build(input: Sample) {
	const { escalation, ...rest } = input;
	return lensRequest({
		...rest,
		...(escalation === undefined ? {} : { escalation }),
		run: (nonce) => ({
			...input.run,
			instructions: `<untrusted-${nonce}>${input.run.instructions}</untrusted-${nonce}>`,
			prompt: `<untrusted-${nonce}>${input.run.prompt}</untrusted-${nonce}>`,
		}),
	});
}

const specOf = ({ name, description, parameters }: { name: string; description: string; parameters: unknown }) => ({
	name,
	description,
	parameters,
});

describe("lensRequest", () => {
	it("keys every input but the nonce", () => {
		const tools = ["read_file", "search", "list_files", "graph_definitions"];
		const vary = (name: string, value: unknown) =>
			name.startsWith("run.tools.") ? tools.find((tool) => tool !== value) : undefined;
		expect(keyCoverage(build, sample, { excluded: ["nonce"], vary })).toEqual([]);
	});

	it("shows the lens its run under the review's nonce, and keys it under the fixed one", () => {
		const asked = build(sample);
		expect(asked.producer).toBe("lens");
		expect(asked.unkeyed.nonce.instructions).toBe(
			`<untrusted-${"a".repeat(24)}>Find defects.</untrusted-${"a".repeat(24)}>`,
		);
		expect(asked.request.run).toEqual({
			...sample.run,
			instructions: `<untrusted-${identityNonce}>Find defects.</untrusted-${identityNonce}>`,
			prompt: `<untrusted-${identityNonce}>+const total = price * count;</untrusted-${identityNonce}>`,
		});
		expect(JSON.stringify(asked.request)).not.toContain("a".repeat(24));
	});

	it("keys the system prompt's policy and every tool the run's conversations are offered, by its whole definition", () => {
		const { request } = build(sample);
		expect(request.policy).toBe(injectionPolicy(identityNonce));
		expect(request.continue).toBe(continuePrompt);
		expect(request.tools).toEqual(
			[lensListedTools.read_file, lensListedTools.search, reportFinding, recordPlan].map(specOf),
		);
		expect(request.probing).toEqual({
			tools: [lensListedTools.read_file, lensListedTools.search, reportFinding, runProbe, skipAttack].map(specOf),
			plan: recordPlanPrompt,
			answer: answerPrompt([1, 2]),
		});
	});

	it("offers a run that does not probe no planner tool, and keys no probing text", () => {
		const { probe: _, ...run } = sample.run;
		const { request } = lensRequest({ ...sample, run: () => run });
		expect(request.tools).toEqual([lensListedTools.read_file, lensListedTools.search, reportFinding].map(specOf));
		expect(request).not.toHaveProperty("probing");
	});

	it("keys a capped escalation apart from one that moves on, and both apart from none", () => {
		const moves = build(sample).key;
		const capped = build({ ...sample, escalation: { cap: "at its ceiling" } as unknown as Sample["escalation"] }).key;
		const none = build({ ...sample, escalation: undefined as unknown as Sample["escalation"] }).key;
		expect(new Set([moves, capped, none]).size).toBe(3);
	});

	it("keys a review without callers apart from one with them", () => {
		const { graph: _, ...rest } = sample;
		const without = lensRequest({ ...rest, run: () => sample.run });
		expect(without.request).not.toHaveProperty("graph");
		expect(without.key).not.toBe(lensRequest({ ...sample, run: () => sample.run }).key);
	});
});
