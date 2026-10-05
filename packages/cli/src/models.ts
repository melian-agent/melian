import { readFile } from "node:fs/promises";
import {
	type Decider,
	type Lens,
	type LensTier,
	type MelianConfig,
	type ModelRoute,
	resolveModelForTier,
} from "@melian-agent/core";
import { FallbackDecider } from "@melian-agent/decisions";
import { createReviewModels, type ReviewModels, RouteTextModel } from "@melian-agent/pipeline";
import { createFakeModels, type LensScript, scriptLenses } from "@melian-agent/pipeline/testing";
import { CliError } from "./repository.ts";

/**
 * The environment variable that switches the CLI to scripted mode: the path of a lens script, in a golden's
 * `script.json` shape. Every tier routes to a fake model that answers each lens from it, and storage moves under
 * `melian/scripted/` so nothing a script produced can be published. It exists so tests can run the CLI end to end
 * without a provider.
 */
export const scriptVariable = "MELIAN_TEST_SCRIPT";

const tiers: readonly LensTier[] = ["light", "medium", "heavy"];

// Routes every tier to `model` alone, replacing any route and fallbacks the configuration set.
function routeTiers(config: MelianConfig, model: string): MelianConfig {
	const route: ModelRoute = { model };
	return { ...config, models: { ...config.models, ...Object.fromEntries(tiers.map((tier) => [tier, route])) } };
}

export interface ReviewSetup {
	readonly models: ReviewModels;
	readonly config: MelianConfig;
	/** Whether a failed model request is retried with backoff; scripted mode fails it at once. */
	readonly retry: boolean;
	/** The decider triage asks, or none, and every lens runs at its default level. */
	readonly decider?: Decider;
}

// Triage's LLM fallback, on the cheapest lens tier routed to a model with credentials: the plan's cheapest text route,
// until the review plan resolves one. None when no tier has such a model, and every lens runs at its default level.
async function fallbackDecider(config: MelianConfig, models: ReviewModels): Promise<Decider | undefined> {
	for (const tier of tiers) {
		if (config.models[tier] === undefined) continue;
		const { model, fallbacks } = resolveModelForTier(tier, config.models);
		const text = await RouteTextModel.open(models, [model, ...fallbacks]);
		if (text !== undefined) return new FallbackDecider(text);
	}
	return undefined;
}

async function readScript(path: string): Promise<LensScript> {
	const text = await readFile(path, "utf8").catch(() => {
		throw new CliError(`${scriptVariable} names ${path}, which cannot be read`);
	});
	const script: unknown = JSON.parse(text);
	if (typeof script !== "object" || script === null || Array.isArray(script)) {
		throw new CliError(`${path} is not a lens script: expected an object of lens names to turns`);
	}
	return script as LensScript;
}

// `model` routes every tier, whatever the configuration routes; under the script variable, every tier runs on the fake,
// and no decider triages, so every lens runs at its default level as the scripts expect.
export async function reviewModels(
	env: NodeJS.ProcessEnv,
	config: MelianConfig,
	lenses: readonly Lens[],
	model: string | undefined,
): Promise<ReviewSetup> {
	const { provider } = config.decisions;
	if (provider !== undefined) {
		throw new CliError(
			`melian.yaml sets decisions.provider to ${provider}, and Melian has no adapter for a decision provider until milestone 4; remove the key, and triage runs on the LLM fallback`,
		);
	}
	const scriptPath = env[scriptVariable];
	if (scriptPath === undefined || scriptPath === "") {
		const models = createReviewModels();
		const routed = model === undefined ? config : routeTiers(config, model);
		const decider = await fallbackDecider(routed, models);
		return { models, retry: true, config: routed, ...(decider === undefined ? {} : { decider }) };
	}
	const fake = createFakeModels({ models: [{ id: "scripted" }] });
	scriptLenses(fake, lenses, await readScript(scriptPath));
	const ref = fake.ref("scripted");
	return {
		models: fake.review,
		config: routeTiers(config, `${ref.provider}/${ref.modelId}`),
		retry: false,
	};
}

export function isScripted(env: NodeJS.ProcessEnv): boolean {
	return (env[scriptVariable] ?? "") !== "";
}

// For a harness that only reads or publishes, which never asks a model.
export function idleModels(env: NodeJS.ProcessEnv): ReviewModels {
	return isScripted(env) ? createFakeModels().review : createReviewModels();
}
