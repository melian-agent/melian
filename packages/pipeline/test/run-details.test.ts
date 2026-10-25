import type { ModelUsage, RequestReasoning } from "@melian-agent/core";
import { expect, it } from "vitest";
import { type Stage, StageTelemetry } from "../src/telemetry.ts";

const usage = (totalTokens: number, cacheRead: number, cost: number): ModelUsage => ({
	input: totalTokens - cacheRead,
	output: 0,
	cacheRead,
	cacheWrite: 0,
	totalTokens,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const reasoning = (requested: string, providerReported?: string): RequestReasoning => ({
	requested,
	source: "observed",
	sent: [],
	...(providerReported === undefined ? {} : { providerReported }),
});

const stage = (fields: Partial<Stage> & Pick<Stage, "name" | "subject">): Stage => ({
	id: `${fields.name}:${fields.subject}`,
	task: 1,
	outcome: "completed",
	timing: "available",
	startedAt: 1_000,
	endedAt: 2_000,
	durationMs: 1_000,
	reused: false,
	resumed: false,
	...fields,
});

const model = (id: string, tokens: number, cacheRead: number, cost: number, level: RequestReasoning) => ({
	models: { [id]: usage(tokens, cacheRead, cost) },
	total: usage(tokens, cacheRead, cost),
	requests: [{ model: id, usage: usage(tokens, cacheRead, cost), reasoning: level }],
});

it("projects each stage into a run row, with the preparation spans and the verification claims as one row each", () => {
	const telemetry = new StageTelemetry(
		"base..head",
		[
			stage({ name: "melian.check", subject: "static.tsc", durationMs: 12_000 }),
			stage({ name: "melian.check", subject: "guardrails", reused: true }),
			stage({ name: "melian.check", subject: "static.mutation", outcome: "timed-out" }),
			stage({
				name: "melian.triage",
				subject: "triage",
				usage: model("openai/gpt-5.6-terra", 12_000, 0, 0.03, reasoning("low")),
			}),
			stage({
				name: "melian.lens",
				subject: "correctness@18c49f913df8@careful",
				conversation: 4,
				usage: model("openai/gpt-6.1-sol", 820_000, 789_000, 1.25, reasoning("low", "medium")),
				tools: 28,
				limits: { tools: 30, tokens: 200_000 },
			}),
			stage({
				name: "melian.lens",
				subject: "tests@18c49f913df8@quick",
				outcome: "ended",
				ended: "tokens",
				usage: model("openai/gpt-6.1-sol", 10, 0, 0, reasoning("unset")),
			}),
			stage({
				name: "melian.verification.candidate",
				subject: "a,b",
				durationMs: 4_000,
				usage: model("anthropic/claude-sonnet-5-5", 3_000, 0, 0, reasoning("unset")),
			}),
			stage({
				name: "melian.verification.candidate",
				subject: "c",
				durationMs: 5_000,
				usage: model("anthropic/claude-sonnet-5-5", 1_000, 0, 0, reasoning("unset")),
			}),
			stage({ name: "melian.adjudication", subject: "adjudication", durationMs: 50 }),
			stage({ name: "melian.walkthrough", subject: "walkthrough" }),
			stage({ name: "melian.publication", subject: "publication" }),
		],
		{
			startedAt: 0,
			endedAt: 142_000,
			spans: [
				{ name: "bands", startedAt: 0, endedAt: 1_000, durationMs: 1_000 },
				{ name: "routes", startedAt: 1_000, endedAt: 3_200, durationMs: 2_200 },
				{ name: "routes.read", parent: "routes", startedAt: 1_000, endedAt: 2_000, durationMs: 1_000 },
			],
		},
	);

	expect(telemetry.runDetails()).toStrictEqual({
		durationMs: 142_000,
		stages: [
			{ name: "preparation", models: [], durationMs: 3_200, outcome: "ran" },
			{ name: "check static.tsc", models: [], durationMs: 12_000, outcome: "ran" },
			{ name: "check guardrails", models: [], durationMs: 1_000, outcome: "reused" },
			{ name: "check static.mutation", models: [], durationMs: 1_000, outcome: "timed-out" },
			{
				name: "triage",
				models: ["openai/gpt-5.6-terra low"],
				durationMs: 1_000,
				tokens: 12_000,
				cacheRead: 0,
				cost: 0.03,
				outcome: "ran",
			},
			{
				name: "lens correctness",
				level: "careful",
				models: ["openai/gpt-6.1-sol low (reported medium)"],
				durationMs: 1_000,
				tokens: 820_000,
				cacheRead: 789_000,
				cost: 1.25,
				outcome: "ran",
				tools: 28,
				limits: { tools: 30, tokens: 200_000 },
			},
			{
				name: "lens tests",
				level: "quick",
				models: ["openai/gpt-6.1-sol"],
				durationMs: 1_000,
				tokens: 10,
				cacheRead: 0,
				cost: 0,
				outcome: "ended",
				ended: "tokens",
			},
			{
				name: "verification 3 claims",
				models: ["anthropic/claude-sonnet-5-5"],
				durationMs: 9_000,
				tokens: 4_000,
				cacheRead: 0,
				cost: 0,
				outcome: "ran",
			},
			{ name: "adjudication", models: [], durationMs: 50, outcome: "ran" },
			{ name: "walkthrough", models: [], durationMs: 1_000, outcome: "ran" },
		],
	});
});

it("leaves out a review time and a preparation row it has no spans for", () => {
	const telemetry = new StageTelemetry("base..head", [stage({ name: "melian.triage", subject: "triage" })]);
	expect(telemetry.runDetails()).toStrictEqual({
		stages: [{ name: "triage", models: [], durationMs: 1_000, outcome: "ran" }],
	});
});

it("names a model without a request record, and a stage with no duration", () => {
	const telemetry = new StageTelemetry("base..head", [
		stage({
			name: "melian.walkthrough",
			subject: "walkthrough",
			durationMs: undefined,
			usage: { models: { "openai/gpt-5.6-terra": usage(5, 0, 0) }, total: usage(5, 0, 0) },
		}),
	]);
	expect(telemetry.runDetails().stages).toStrictEqual([
		{ name: "walkthrough", models: ["openai/gpt-5.6-terra"], tokens: 5, cacheRead: 0, cost: 0, outcome: "ran" },
	]);
});

it("opens the terminal view with the summary line the ledger shows", () => {
	const telemetry = new StageTelemetry("base..head", [
		stage({
			name: "melian.triage",
			subject: "triage",
			durationMs: 2_100,
			usage: model("openai/gpt-5.6-terra", 12_000, 3_000, 0.03, reasoning("low")),
		}),
	]);
	expect(telemetry.render().split("\n")[0]).toBe("Run: 12k tokens (25% cached) · $0.03 · openai/gpt-5.6-terra low");
});
