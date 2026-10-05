import { defaultConfig, type MelianConfig } from "@melian-agent/core";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { describe, expect, it } from "vitest";
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

describe("the triage model", () => {
	const fake = createFakeModels({ models: [{ id: "light" }, { id: "medium" }, { id: "heavy" }] });
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	const choose = (models: MelianConfig["models"]) => fallbackDecider({ ...defaultConfig, models }, fake.review);

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
