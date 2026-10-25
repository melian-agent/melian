import { describe, expect, it } from "vitest";
import { costText, durationText, RunDetails, type RunStage, tokenText } from "../src/index.ts";

describe("run units", () => {
	it("writes tokens as a count, then k, then M, at each bound", () => {
		expect(tokenText(0)).toBe("0");
		expect(tokenText(999)).toBe("999");
		expect(tokenText(1000)).toBe("1.0k");
		expect(tokenText(9_949)).toBe("9.9k");
		expect(tokenText(9_950)).toBe("10k");
		expect(tokenText(199_600)).toBe("200k");
		expect(tokenText(999_499)).toBe("999k");
		expect(tokenText(999_500)).toBe("1.00M");
		expect(tokenText(1_540_000)).toBe("1.54M");
		expect(tokenText(6_800_000)).toBe("6.80M");
	});

	it("writes cost in cents, and a cost below half a cent as less than one", () => {
		expect(costText(0)).toBe("$0.00");
		expect(costText(0.004_999)).toBe("<$0.01");
		expect(costText(0.005)).toBe("$0.01");
		expect(costText(3.5)).toBe("$3.50");
	});

	it("writes time in seconds below five minutes and in minutes from five", () => {
		expect(durationText(0)).toBe("0.0 s");
		expect(durationText(9_949)).toBe("9.9 s");
		expect(durationText(9_950)).toBe("10 s");
		expect(durationText(142_000)).toBe("142 s");
		expect(durationText(299_499)).toBe("299 s");
		expect(durationText(299_500)).toBe("5.0 min");
		expect(durationText(450_000)).toBe("7.5 min");
	});
});

const lens = (fields: Partial<RunStage>): RunStage => ({
	name: "lens correctness",
	level: "careful",
	models: ["openai/gpt-6.1-sol low"],
	durationMs: 61_000,
	tokens: 1_540_000,
	cacheRead: 1_400_000,
	cost: 1.25,
	outcome: "ran",
	...fields,
});

describe("RunDetails", () => {
	it("sums this review's own spend, leaving reused stages out, and names each model once", () => {
		const details = RunDetails.from({
			durationMs: 142_000,
			stages: [
				{ name: "check static.tsc", models: [], durationMs: 4_000, outcome: "ran" },
				{
					name: "triage",
					models: ["openai/gpt-5.6-terra low"],
					tokens: 20_000,
					cacheRead: 0,
					cost: 0.05,
					outcome: "ran",
				},
				lens({}),
				lens({ name: "lens contracts", tokens: 900_000, cacheRead: 0, cost: 2, outcome: "reused" }),
				lens({
					name: "lens tests",
					models: ["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol low"],
					tokens: 440_000,
					cacheRead: 0,
					cost: 2.2,
				}),
			],
		});

		expect(details.summary()).toBe(
			"142 s · 2.00M tokens (70% cached) · $3.50 · openai/gpt-5.6-terra low, openai/gpt-6.1-sol low, anthropic/claude-sonnet-5-5",
		);
	});

	it("leaves out a time it has none for, and a cache share of no tokens", () => {
		expect(RunDetails.from({ stages: [{ name: "check guardrails", models: [], outcome: "ran" }] }).summary()).toBe(
			"0 tokens · $0.00",
		);
	});

	it("gives each stage a row, with a reused stage costing nothing and a budget only when it matters", () => {
		const rows = RunDetails.from({
			stages: [
				lens({ tools: 24, limits: { tools: 30, tokens: 200_000 } }),
				lens({ name: "lens contracts", tools: 23, limits: { tools: 30, tokens: 700_000 } }),
				lens({ name: "lens design", tokens: 160_000, cacheRead: 0, limits: { tokens: 200_000 } }),
				lens({ name: "lens durability", tokens: 159_999, cacheRead: 0, limits: { tokens: 200_000 } }),
				lens({ name: "lens tests", outcome: "ended", ended: "tools", tools: 30, limits: { tools: 30 } }),
				lens({ name: "lens security", outcome: "reused" }),
				{ name: "check static.biome", models: [], outcome: "skipped" },
			],
		}).rows();

		expect(rows).toEqual([
			{
				stage: "lens correctness",
				level: "careful",
				model: "openai/gpt-6.1-sol low",
				time: "61 s",
				tokens: "1.54M",
				cost: "$1.25",
				outcome: "ran",
				budget: "tools 24 / 30",
			},
			{
				stage: "lens contracts",
				level: "careful",
				model: "openai/gpt-6.1-sol low",
				time: "61 s",
				tokens: "1.54M",
				cost: "$1.25",
				outcome: "ran",
				budget: "",
			},
			{
				stage: "lens design",
				level: "careful",
				model: "openai/gpt-6.1-sol low",
				time: "61 s",
				tokens: "160k",
				cost: "$1.25",
				outcome: "ran",
				budget: "tokens 160k / 200k",
			},
			{
				stage: "lens durability",
				level: "careful",
				model: "openai/gpt-6.1-sol low",
				time: "61 s",
				tokens: "160k",
				cost: "$1.25",
				outcome: "ran",
				budget: "",
			},
			{
				stage: "lens tests",
				level: "careful",
				model: "openai/gpt-6.1-sol low",
				time: "61 s",
				tokens: "1.54M",
				cost: "$1.25",
				outcome: "ended",
				budget: "tools budget ended it: 30 / 30",
			},
			{
				stage: "lens security",
				level: "careful",
				model: "openai/gpt-6.1-sol low",
				time: "—",
				tokens: "—",
				cost: "$0.00",
				outcome: "reused",
				budget: "",
			},
			{
				stage: "check static.biome",
				level: "",
				model: "",
				time: "—",
				tokens: "—",
				cost: "—",
				outcome: "skipped",
				budget: "",
			},
		]);
	});

	it("names the budget that ended a lens without its limit when the lens stored none", () => {
		const [row] = RunDetails.from({ stages: [lens({ outcome: "ended", ended: "tokens" })] }).rows();
		expect(row!.budget).toBe("tokens budget ended it");
	});

	it("says whether any stage has a token budget", () => {
		expect(
			RunDetails.from({
				stages: [lens({ limits: { tools: 3 } }), lens({ limits: { tokens: 3 } })],
			}).hasTokenBudget(),
		).toBe(true);
		expect(RunDetails.from({ stages: [lens({ limits: { tools: 3 } }), lens({})] }).hasTokenBudget()).toBe(false);
	});

	it("names both budgets when both are near, and every model of a stage", () => {
		const [row] = RunDetails.from({
			stages: [
				lens({
					models: ["a/one low", "b/two"],
					tokens: 170_000,
					cacheRead: 0,
					tools: 25,
					limits: { tools: 30, tokens: 200_000 },
				}),
			],
		}).rows();
		expect(row).toMatchObject({ model: "a/one low, b/two", budget: "tools 25 / 30; tokens 170k / 200k" });
	});

	it("counts a token budget without cache reads, as the budget does", () => {
		const [row] = RunDetails.from({
			stages: [lens({ tokens: 1_540_000, cacheRead: 1_380_000, limits: { tokens: 200_000 } })],
		}).rows();
		expect(row!.budget).toBe("tokens 160k / 200k");
	});

	it("round-trips its stored shape", () => {
		const stored = { durationMs: 1, stages: [lens({ tools: 2, limits: { tools: 3 }, ended: "tokens" as const })] };
		expect(RunDetails.from(stored).toJSON()).toEqual(stored);
	});

	it("says a total is incomplete when a stage's usage was not all measured", () => {
		const details = RunDetails.from({
			stages: [
				lens({ tokens: 1_000, cacheRead: 0, cost: 1 }),
				lens({ name: "lens tests", tokens: 1_000, cacheRead: 500, cost: 1, usageIncomplete: true }),
			],
		});
		expect(details.summary()).toBe("2.0k tokens (25% cached, incomplete) · $2.00 · openai/gpt-6.1-sol low");
		expect(details.rows().map(({ tokens }) => tokens)).toEqual(["1.0k", "1.0k, incomplete"]);
		const none = RunDetails.from({
			stages: [lens({ tokens: undefined, cacheRead: undefined, cost: undefined, usageIncomplete: true })],
		});
		expect(none.summary()).toBe("0 tokens (incomplete) · $0.00 · openai/gpt-6.1-sol low");
		expect(none.rows()[0]!.tokens).toBe("incomplete");
		const reused = RunDetails.from({ stages: [lens({ outcome: "reused", usageIncomplete: true })] });
		expect(reused.summary()).toBe("0 tokens · $0.00");
	});
});
