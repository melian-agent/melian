import { readFile } from "node:fs/promises";
import type { Lens, LensTier, MelianConfig, ModelRoute } from "@melian-agent/core";
import { createReviewModels, type ReviewModels } from "@melian-agent/pipeline";
import { createFakeModels, type LensScript, scriptLenses } from "@melian-agent/pipeline/testing";
import { CliError } from "./repository.ts";

/**
 * The environment variable that switches the CLI to scripted mode: the path of a lens script, in a golden's
 * `script.json` shape. Every tier routes to a fake model that answers each lens from it, and storage moves under
 * `melian/scripted/` so nothing a script produced can be published. It exists for tests of the built binary.
 */
export const scriptVariable = "MELIAN_TEST_SCRIPT";

const tiers: readonly LensTier[] = ["light", "medium", "heavy"];

// Routes every tier to `model`; `override` replaces routes the configuration set, otherwise only fills the gaps.
function routeTiers(config: MelianConfig, model: string, override: boolean): MelianConfig {
	const route: ModelRoute = { model };
	const routed = Object.fromEntries(tiers.map((tier) => [tier, override ? route : (config.models[tier] ?? route)]));
	return { ...config, models: { ...config.models, ...routed } };
}

export interface ReviewSetup {
	readonly models: ReviewModels;
	readonly config: MelianConfig;
	/** Whether a failed model request is retried with backoff; scripted mode fails it at once. */
	readonly retry: boolean;
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

// `model` routes every tier the configuration leaves unrouted; under the script variable, every tier runs on the fake.
export async function reviewModels(
	env: NodeJS.ProcessEnv,
	config: MelianConfig,
	lenses: readonly Lens[],
	model: string | undefined,
): Promise<ReviewSetup> {
	const scriptPath = env[scriptVariable];
	if (scriptPath === undefined || scriptPath === "") {
		return {
			models: createReviewModels(),
			retry: true,
			config: model === undefined ? config : routeTiers(config, model, false),
		};
	}
	const fake = createFakeModels({ models: [{ id: "scripted" }] });
	scriptLenses(fake, lenses, await readScript(scriptPath));
	const ref = fake.ref("scripted");
	return {
		models: fake.review,
		config: routeTiers(config, `${ref.provider}/${ref.modelId}`, true),
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
