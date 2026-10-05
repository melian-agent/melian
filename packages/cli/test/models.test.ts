import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Decider, defaultConfig, type LoadedConfig, type MelianConfig, userFiles } from "@melian-agent/core";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionProviderRefusal, fallbackDecider, reviewModels, Triage, triageProviders } from "../src/models.ts";

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

describe("decisionProviderRefusal", () => {
	it("prints the provider's control characters as visible text", () => {
		const config = { ...defaultConfig, decisions: { provider: "evil\u001b[31m\nforged" } };

		const refusal = decisionProviderRefusal(config);

		expect(refusal).toContain("decisions.provider to evil\\u001b[31m\\u000aforged,");
		expect(refusal).not.toMatch(/[\u001b\n]/);
	});
});

describe("triageProviders", () => {
	it("names the providers of every routed lens tier, which the fallback may ask", async () => {
		const routedTiers = loadedOf({
			light: { model: "openai/gpt-5.5" },
			heavy: { model: "anthropic/claude-opus-5-5" },
		});
		const { plan } = await reviewModels({}, routedTiers, [], {
			...setup,
			credentials: [
				{ name: "o", provider: "openai", type: "api_key", value: { kind: "literal", key: "sk-o" }, file: "f" },
				{
					name: "a",
					provider: "anthropic",
					type: "api_key",
					value: { kind: "literal", key: "sk-a" },
					file: "f",
				},
			],
		});
		expect(triageProviders(plan)).toEqual(["openai", "anthropic"]);
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
		// A model the collection does not know is passed over, as one it knows without credentials is.
		expect(await choose({ light: { model: "nowhere/light" }, heavy: route("heavy") })).toMatchObject({
			model: model("heavy"),
		});
		const locked = fake.withoutCredentials("locked-light");
		expect(
			await choose({ light: { model: `${locked.provider}/${locked.modelId}` }, heavy: route("heavy") }),
		).toMatchObject({
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

describe("Triage", () => {
	const decider: Decider = { name: "fake", calibrated: false, decide: async () => ({ answers: [] }) };
	let dir: string | undefined;
	afterEach(() => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	async function opened(options: { scripted: boolean; decide: typeof fallbackDecider }) {
		dir = mkdtempSync(join(tmpdir(), "melian-triage-"));
		const marker = join(dir, "unlocked");
		const loaded = loadedOf({ light: { model: "openai/gpt-5.5" } });
		const { models, plan } = await reviewModels({}, loaded, [], {
			...setup,
			credentials: [
				{
					name: "vault",
					provider: "openai",
					type: "api_key",
					value: { kind: "command", command: `touch ${marker}; echo sk-key` },
					file: "f",
				},
			],
		});
		const triage = await Triage.create({ ...options, config: loaded.config, plan, models });
		return { triage, marker, plan };
	}

	it("hands the decider to the harness and the review, and unlocks the providers triage may ask", async () => {
		const configs: MelianConfig[] = [];
		const { triage, marker, plan } = await opened({
			scripted: false,
			decide: async (config) => {
				configs.push(config);
				return { decider, model: "fake" };
			},
		});

		expect(triage.harnessOptions()).toEqual({ decider });
		expect(triage.reviewOptions()).toEqual({ decider });
		expect(existsSync(marker)).toBe(true);
		expect(configs[0]!.models).toEqual(plan.routes());
	});

	it("says why triage did not run to the review, and gives the harness no decider", async () => {
		const { triage } = await opened({ scripted: false, decide: async () => ({ skipped: "no model" }) });

		expect(triage.harnessOptions()).toEqual({});
		expect(triage.reviewOptions()).toEqual({ triageSkipped: "no model" });
	});

	it("triages nothing and unlocks only the lenses' providers under a script", async () => {
		const { triage, marker } = await opened({
			scripted: true,
			decide: async () => {
				throw new Error("a script stands in for every model");
			},
		});

		expect(triage.reviewOptions()).toEqual({});
		expect(existsSync(marker)).toBe(false);
	});
});
