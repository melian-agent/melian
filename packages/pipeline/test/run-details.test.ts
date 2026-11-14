import { type ModelUsage, type RequestReasoning, RunDetails } from "@melian-agent/core";
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
			{ name: "check guardrails", models: [], outcome: "reused" },
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
			{ name: "walkthrough", models: [], durationMs: 1_000, outcome: "ran", usageIncomplete: true },
		],
	});
});

it("leaves out a review time and a preparation row it has no spans for", () => {
	const telemetry = new StageTelemetry("base..head", [stage({ name: "melian.triage", subject: "triage" })]);
	expect(telemetry.runDetails()).toStrictEqual({
		stages: [{ name: "triage", models: [], durationMs: 1_000, outcome: "ran", usageIncomplete: true }],
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

it("charges only a verification claim this review ran, and keeps an outcome other than ran", () => {
	const claim = (subject: string, fields: Partial<Stage>) =>
		stage({
			name: "melian.verification.candidate",
			subject,
			usage: model("anthropic/claude-sonnet-5-5", 1_000, 0, 0.1, reasoning("unset")),
			...fields,
		});
	const mixed = new StageTelemetry("base..head", [
		claim("a", { reused: true, durationMs: 7_000, usage: model("x/earlier", 1_000, 0, 0.1, reasoning("unset")) }),
		claim("b", { outcome: "ended", durationMs: 2_000 }),
		claim("c", { durationMs: 3_000 }),
	]);
	expect(mixed.runDetails().stages).toStrictEqual([
		{
			name: "verification 3 claims",
			models: ["anthropic/claude-sonnet-5-5"],
			durationMs: 5_000,
			tokens: 2_000,
			cacheRead: 0,
			cost: 0.2,
			outcome: "ended",
		},
	]);
	const reused = new StageTelemetry("base..head", [claim("a", { reused: true }), claim("b", { reused: true })]);
	expect(reused.runDetails().stages[0]).toStrictEqual({
		name: "verification 2 claims",
		models: ["anthropic/claude-sonnet-5-5"],
		outcome: "reused",
	});
});

it("marks a model stage whose usage was not all measured, and a check that needs none as complete", () => {
	const telemetry = new StageTelemetry("base..head", [
		stage({ name: "melian.lens", subject: "a@1@careful" }),
		stage({
			name: "melian.triage",
			subject: "triage",
			usage: model("m", 1, 0, 0, reasoning("unset")),
			usageIncomplete: 1,
		}),
		stage({ name: "melian.walkthrough", subject: "walkthrough", usage: model("m", 1, 0, 0, reasoning("unset")) }),
		stage({ name: "melian.verification.candidate", subject: "a" }),
		stage({ name: "melian.check", subject: "guardrails" }),
	]);
	expect(telemetry.runDetails().stages.map(({ usageIncomplete }) => usageIncomplete)).toEqual([
		true,
		true,
		undefined,
		true,
		undefined,
	]);
});

// A lens's check record with no conversation, as the telemetry reader builds it when the lens opened none.
const unopened = (outcome: string, fields: Partial<Stage> = {}) =>
	stage({
		name: "melian.lens",
		subject: "durability@@careful",
		outcome,
		timing: "unavailable",
		startedAt: undefined,
		endedAt: undefined,
		durationMs: undefined,
		...fields,
	});

it.each([
	["skipped, as triage skips it", "skipped", undefined, undefined],
	["refused by the plan before it opened a conversation, as for a missing credential", "failed", undefined, undefined],
	["skipped, but with a conversation that left no usage", "skipped", 7, true],
	["recorded as ran by an older build that left no conversation", "completed", undefined, true],
])("reads a lens %s as incomplete only when it may have sent a request", (_name, outcome, conversation, incomplete) => {
	const telemetry = new StageTelemetry("base..head", [
		unopened(outcome, conversation === undefined ? {} : { conversation }),
	]);
	expect(telemetry.runDetails().stages[0]?.usageIncomplete).toBe(incomplete);
});

it("keeps a failed triage incomplete, since triage has no conversation even when it sent a request", () => {
	// The same no-conversation, failed record a refused lens has, but for a stage that may have sent its request.
	const triage = unopened("failed", { name: "melian.triage", subject: "triage", usageIncomplete: 1 });
	expect(new StageTelemetry("base..head", [triage]).runDetails().stages[0]?.usageIncomplete).toBe(true);
});

it("prints a skipped lens beside a lens that ran with complete usage, and no incomplete total", () => {
	const telemetry = new StageTelemetry("base..head", [
		stage({
			name: "melian.lens",
			subject: "design@1@careful",
			conversation: 3,
			usage: model("openai/gpt-5.6-sol", 2_000, 500, 0.5, reasoning("high")),
		}),
		unopened("skipped"),
	]);
	const details = RunDetails.from(telemetry.runDetails());
	expect(details.summary()).not.toContain("incomplete");
	expect(details.rows().map(({ stage, tokens, outcome }) => ({ stage, tokens, outcome }))).toEqual([
		{ stage: "lens design", tokens: "2.0k", outcome: "ran" },
		{ stage: "lens durability", tokens: "—", outcome: "skipped" },
	]);
});
