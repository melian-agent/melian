import { defaultConfig, type MelianConfig } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { reviewModels } from "../src/models.ts";

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
