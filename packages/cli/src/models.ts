import { readFile } from "node:fs/promises";
import {
	type Decider,
	type Lens,
	type LensTier,
	type LoadedConfig,
	type MelianConfig,
	ModelRoutingError,
	type NamedCredential,
	ReviewPlan,
	resolveModelForTier,
} from "@melian-agent/core";
import { FallbackDecider } from "@melian-agent/decisions";
import { createReviewModels, planInputs, type ReviewModels, RouteTextModel } from "@melian-agent/pipeline";
import { createFakeModels, type LensScript, scriptLenses } from "@melian-agent/pipeline/testing";
import { CliError } from "./repository.ts";

/**
 * The environment variable that switches the CLI to scripted mode: the path of a lens script, in a golden's
 * `script.json` shape. Every lens tier routes to a fake model that answers each lens from it, as `--model` would
 * route it, and storage moves under `melian/scripted/` so nothing a script produced can be published. It exists so
 * tests can run the CLI end to end without a provider.
 */
export const scriptVariable = "MELIAN_TEST_SCRIPT";

const tiers: readonly LensTier[] = ["light", "medium", "heavy"];

export interface ReviewSetup {
	readonly models: ReviewModels;
	readonly plan: ReviewPlan;
	/** Whether a failed model request is retried with backoff; scripted mode fails it at once. */
	readonly retry: boolean;
}

// Triage's LLM fallback, on the cheapest lens tier routed to a model with credentials. A tier whose route cannot be
// read is passed over, as one without credentials is, so a broken route no lens uses never stops a review. With none,
// every lens runs at its default level, and `skipped` says why.
export async function fallbackDecider(
	config: MelianConfig,
	models: ReviewModels,
): Promise<{ readonly decider: Decider; readonly model: string } | { readonly skipped: string }> {
	const passed: string[] = [];
	for (const tier of tiers) {
		if (config.models[tier]?.model === undefined) {
			passed.push(`${tier} is not routed`);
			continue;
		}
		let route: ReturnType<typeof resolveModelForTier>;
		try {
			route = resolveModelForTier(tier, config.models);
		} catch (error) {
			if (!(error instanceof ModelRoutingError)) throw error;
			passed.push(error.message);
			continue;
		}
		const text = await RouteTextModel.create(models, [route.model, ...route.fallbacks]);
		if (text !== undefined) return { decider: new FallbackDecider(text), model: text.name };
		passed.push(`no model of ${tier} has credentials`);
	}
	return { skipped: `no lens tier reaches a model for the LLM fallback: ${passed.join("; ")}` };
}

// The providers triage's LLM fallback may call: each routed lens tier's models, since the fallback takes the cheapest
// with credentials, so a command credential it needs runs before the review starts, with the others.
export function triageProviders(plan: ReviewPlan): string[] {
	return tiers.flatMap((tier) => {
		const { status, models } = plan.tier(tier);
		return status === "routed" ? models.map(({ model }) => model.slice(0, model.indexOf("/"))) : [];
	});
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

// Under the script variable every lens tier runs on the fake, routed as --model would route it.
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
	const { provider } = loaded.config.decisions;
	if (provider !== undefined) {
		throw new CliError(
			`melian.yaml sets decisions.provider to ${provider}, and Melian has no adapter for a decision provider until milestone 4; remove the key, and triage runs on the LLM fallback`,
		);
	}
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
	const { catalog, credentials } = await planInputs(models);
	const plan = ReviewPlan.resolve({
		config: loaded.config,
		routes: loaded.routes,
		...(model === undefined ? {} : { model }),
		catalog,
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
