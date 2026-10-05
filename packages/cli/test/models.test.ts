import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type LoadedConfig, type MelianConfig, userFiles } from "@melian-agent/core";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackDecider, reviewModels } from "../src/models.ts";

const models: MelianConfig["models"] = {
	light: { model: "anthropic/claude-sonnet-5-5" },
	heavy: { model: "anthropic/claude-opus-5-5", fallbacks: ["openai/gpt"] },
	verifier: { model: "openai/gpt-5.5" },
};
const routed: LoadedConfig = {
	config: { ...defaultConfig, models },
	sources: ["melian.yaml"],
	routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
};
const setup = { checks: ["lens.correctness"], credentials: [] };

describe("--model", () => {
	it("routes every lens tier to the model named, over the routes melian.yaml sets and their fallbacks", async () => {
		const { plan } = await reviewModels({}, routed, [], { ...setup, model: "amazon-bedrock/claude-opus" });
		expect(plan.routes()).toMatchObject({
			light: { model: "amazon-bedrock/claude-opus", fallbacks: [] },
			medium: { model: "amazon-bedrock/claude-opus", fallbacks: [] },
			heavy: { model: "amazon-bedrock/claude-opus", fallbacks: [] },
		});
		expect(plan.tier("heavy").by).toBe("--model");
		expect(plan.tier("verifier").by).not.toBe("--model");
	});

	// Which credentials this machine holds decides where heavy lands, so the test asks only what the flag decides.
	it("leaves the routes to the plan when absent", async () => {
		const { plan } = await reviewModels({}, routed, [], setup);
		expect(plan.tier("heavy").wanted).toBe("anthropic/claude-opus-5-5");
		expect(plan.tier("heavy").by).not.toBe("--model");
	});
});

describe("userFiles", () => {
	it("keeps the user's own files in XDG_CONFIG_HOME/melian, or ~/.config/melian", () => {
		expect(userFiles({ XDG_CONFIG_HOME: "/xdg" })).toEqual({
			config: "/xdg/melian/config.yaml",
			secrets: "/xdg/melian/secrets.yaml",
		});
		expect(userFiles({}).config).toBe(join(homedir(), ".config", "melian", "config.yaml"));
	});
});

// A configuration as the loader returns it, every route committed.
function loadedOf(models: MelianConfig["models"]): LoadedConfig {
	return {
		config: { ...defaultConfig, models },
		sources: ["melian.yaml"],
		routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
	};
}

describe("reviewModels triage", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("triages on the plan's routes, which --model rewrites", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent-melian-test");
		vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

		const { models: collection, plan } = await reviewModels({}, loadedOf({}), [], {
			...setup,
			model: "anthropic/claude-sonnet-4-5",
		});
		const triage = await fallbackDecider({ ...defaultConfig, models: plan.routes() }, collection);

		expect(triage).toMatchObject({ model: "anthropic/claude-sonnet-4-5" });
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
