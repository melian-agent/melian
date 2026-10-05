import { readFile } from "node:fs/promises";
import { type Lens, type LoadedConfig, type NamedCredential, ReviewPlan } from "@melian-agent/core";
import { createReviewModels, planInputs, type ReviewModels } from "@melian-agent/pipeline";
import { createFakeModels, type LensScript, scriptLenses } from "@melian-agent/pipeline/testing";
import { CliError } from "./repository.ts";

/**
 * The environment variable that switches the CLI to scripted mode: the path of a lens script, in a golden's
 * `script.json` shape. Every lens tier routes to a fake model that answers each lens from it, as `--model` would
 * route it, and storage moves under `melian/scripted/` so nothing a script produced can be published. It exists so
 * tests can run the CLI end to end without a provider.
 */
export const scriptVariable = "MELIAN_TEST_SCRIPT";

export interface ReviewSetup {
	readonly models: ReviewModels;
	readonly plan: ReviewPlan;
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

/**
 * The models a review runs on and its plan, resolved from the routes `loaded` holds, the catalogue, and the credentials
 * present, the named `credentials` of the secrets files first. `model` routes every lens tier to one model, whatever
 * the configuration routes; under the script variable, every lens tier runs on the fake. `checks` are the checks the
 * review's tier names, which say which lenses it runs.
 */
export async function reviewModels(
	env: NodeJS.ProcessEnv,
	loaded: LoadedConfig,
	lenses: readonly Lens[],
	options: {
		readonly model?: string | undefined;
		readonly checks: readonly string[];
		readonly credentials: readonly NamedCredential[];
	},
): Promise<ReviewSetup> {
	const scriptPath = env[scriptVariable];
	const scripted = scriptPath !== undefined && scriptPath !== "";
	let models: ReviewModels;
	let model = options.model;
	if (scripted) {
		const fake = createFakeModels({ models: [{ id: "scripted" }] });
		scriptLenses(fake, lenses, await readScript(scriptPath));
		const ref = fake.ref("scripted");
		models = fake.review;
		model = `${ref.provider}/${ref.modelId}`;
	} else {
		models = createReviewModels({ credentials: options.credentials });
	}
	const { catalogue, credentials } = await planInputs(models);
	const plan = ReviewPlan.resolve({
		config: loaded.config,
		routes: loaded.routes,
		...(model === undefined ? {} : { model }),
		catalogue,
		credentials,
		lenses,
		checks: options.checks,
	});
	return { models, plan, retry: !scripted };
}

export function isScripted(env: NodeJS.ProcessEnv): boolean {
	return (env[scriptVariable] ?? "") !== "";
}

// For a harness that only reads or publishes, which never asks a model.
export function idleModels(env: NodeJS.ProcessEnv): ReviewModels {
	return isScripted(env) ? createFakeModels().review : createReviewModels();
}
