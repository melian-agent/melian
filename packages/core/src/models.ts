import type { LensTier, MelianConfig } from "./config.ts";
import { ModelRoutingError } from "./errors.ts";

/** A model by provider and model ID, the shape pi-ai and Pi Durable select a model by. */
export interface ModelReference {
	readonly provider: string;
	readonly modelId: string;
}

/** The model a tier routes to, and the models to try, in order, when it is unavailable. */
export interface ResolvedModelRoute {
	readonly tier: LensTier | "decision";
	readonly model: ModelReference;
	readonly fallbacks: readonly ModelReference[];
}

/**
 * Parses `provider/model-id` into a {@link ModelReference}. The provider ends at the first slash, so a model ID may hold
 * slashes of its own, as OpenRouter's `openrouter/anthropic/claude-sonnet-4-5` does. Throws {@link ModelRoutingError}
 * `invalidModel` for text with no provider or no model ID.
 */
export function parseModelReference(text: string, tier: LensTier | "decision"): ModelReference {
	const slash = text.indexOf("/");
	const provider = text.slice(0, slash).trim();
	const modelId = text.slice(slash + 1).trim();
	if (slash === -1 || provider === "" || modelId === "") {
		throw new ModelRoutingError("invalidModel", `models.${tier}: "${text}" is not provider/model-id`, {
			tier,
			model: text,
		});
	}
	return { provider, modelId };
}

/**
 * Routes a tier to its configured model and fallbacks. Throws {@link ModelRoutingError} `noModelForTier` naming the tier
 * when no `melian.yaml` configures it, and `invalidModel` when a configured model is not `provider/model-id`.
 */
export function resolveModelForTier(tier: LensTier | "decision", models: MelianConfig["models"]): ResolvedModelRoute {
	const route = models[tier];
	if (route === undefined) {
		throw new ModelRoutingError(
			"noModelForTier",
			`no model is configured for the ${tier} tier; set models.${tier}.model in melian.yaml`,
			{ tier },
		);
	}
	return {
		tier,
		model: parseModelReference(route.model, tier),
		fallbacks: (route.fallbacks ?? []).map((fallback) => parseModelReference(fallback, tier)),
	};
}
