import { defaultConfig, type MelianConfig } from "@melian-agent/core";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackDecider, reviewModels } from "../src/models.ts";

const routed: MelianConfig = {
	...defaultConfig,
	models: {
		light: { model: "anthropic/claude-sonnet-5-5" },
		heavy: { model: "anthropic/claude-opus-5-5", fallbacks: ["openai/gpt"] },
	},
};

describe("--model", () => {
	it("routes every tier to the model named, over the routes melian.yaml sets and their fallbacks", async () => {
		const { config } = await reviewModels({}, routed, [], "amazon-bedrock/claude-opus");
		expect(config.models).toEqual({
			light: { model: "amazon-bedrock/claude-opus" },
			medium: { model: "amazon-bedrock/claude-opus" },
			heavy: { model: "amazon-bedrock/claude-opus" },
		});
	});

	it("leaves the routes alone when absent", async () => {
		expect((await reviewModels({}, routed, [], undefined)).config.models).toEqual(routed.models);
	});
});

describe("reviewModels without a script", () => {
	it("says why no decider triages, for the review to note on each lens's record", async () => {
		const unknown = { ...defaultConfig, models: { heavy: { model: "nowhere/opus" } } };
		const setup = await reviewModels({}, unknown, [], undefined);
		expect(setup.decider).toBeUndefined();
		expect(setup.triageSkipped).toBe(
			"no lens tier reaches a model for the LLM fallback: light is not routed; medium is not routed; no model of heavy has credentials",
		);
	});
});

describe("reviewModels triage under --model", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("picks the triage model from the tiers --model rewrote, not from the configuration's own", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent-melian-test");
		vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
		const unrouted = { ...defaultConfig, models: {} };

		const without = await reviewModels({}, unrouted, [], undefined);
		const routedByFlag = await reviewModels({}, unrouted, [], "anthropic/claude-sonnet-4-5");

		expect(without.decider).toBeUndefined();
		expect(routedByFlag.triageSkipped).toBeUndefined();
		expect(routedByFlag.decider).toBeDefined();
	});
});

describe("the triage model", () => {
	const fake = createFakeModels({ models: [{ id: "light" }, { id: "medium" }, { id: "heavy" }] });
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	const choose = (models: MelianConfig["models"]) => fallbackDecider({ ...defaultConfig, models }, fake.review);

	it("triages on the cheapest routed tier with credentials, passing over unrouted and uncredentialed ones", async () => {
		const model = (id: string) => `${fake.ref(id).provider}/${id}`;
		const all = { light: route("light"), medium: route("medium"), heavy: route("heavy") };
		expect(await choose(all)).toMatchObject({ model: model("light") });
		expect(await choose({ medium: route("medium"), heavy: route("heavy") })).toMatchObject({
			model: model("medium"),
		});
		// A model the collection does not know, as one without credentials, is passed over.
		expect(await choose({ light: { model: "nowhere/light" }, heavy: route("heavy") })).toMatchObject({
			model: model("heavy"),
		});
	});

	it("passes over a tier whose route cannot be read, rather than stop the review", async () => {
		const chosen = await choose({ light: { model: "claude-haiku" }, medium: route("medium") });
		expect(chosen).toMatchObject({ model: `${fake.ref("medium").provider}/medium` });
	});

	it("says why no decider runs when no tier reaches a model", async () => {
		const chosen = await choose({ light: { model: "claude-haiku" }, medium: { model: "nowhere/medium" } });
		expect(chosen).toEqual({
			skipped:
				'no lens tier reaches a model for the LLM fallback: models.light: "claude-haiku" is not provider/model-id; no model of medium has credentials; heavy is not routed',
		});
	});
});
