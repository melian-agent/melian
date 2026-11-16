import type { MelianConfig, ModelRoute, ModelTier } from "./config.ts";
import { ModelRoutingError } from "./errors.ts";

/** A model by provider and model ID, the shape pi-ai and Pi Durable select a model by. */
export interface ModelReference {
	readonly provider: string;
	readonly modelId: string;
}

/** A model of a route, with the level its entry names in place of the route's own, where it names one. */
export interface RoutedModel extends ModelReference {
	readonly thinking?: ModelRoute["thinking"];
}

/** One fallback of a {@link ModelRoute} as a file writes it: a model, or a model and its own level. */
export type FallbackEntry = NonNullable<ModelRoute["fallbacks"]>[number];

/** The model a tier routes to, and the models to try, in order, when it is unavailable. */
export interface ResolvedModelRoute {
	readonly tier: ModelTier;
	readonly model: ModelReference;
	readonly fallbacks: readonly RoutedModel[];
}

/** The fallback entry for `model` at `thinking` in place of its route's level, or at the route's when it is absent. */
export function fallbackEntry(model: string, thinking: ModelRoute["thinking"]): FallbackEntry {
	return thinking === undefined ? model : { model, thinking };
}

/**
 * The route that runs `models` in order at `thinking`, each model that names its own level at that one. A first model
 * with a level of its own, a fallback promoted past models no credential reaches, becomes the route's level, and each
 * later model that names none keeps `thinking` by naming it.
 */
export function routeInOrder(
	models: readonly { readonly model: string; readonly thinking?: ModelRoute["thinking"] }[],
	thinking: ModelRoute["thinking"],
): ModelRoute {
	const [first, ...rest] = models;
	const level = first?.thinking ?? thinking;
	const fallbacks = rest.map((each) =>
		fallbackEntry(each.model, each.thinking ?? (level === thinking ? undefined : thinking)),
	);
	return {
		...(level === undefined ? {} : { thinking: level }),
		...(first === undefined ? {} : { model: first.model, fallbacks }),
	};
}

/** The model a fallback entry names. */
export function fallbackModel(entry: FallbackEntry): string {
	return typeof entry === "string" ? entry : entry.model;
}

/** The level a fallback entry names in place of its route's, or `undefined` when it runs at the route's. */
export function fallbackThinking(entry: FallbackEntry): ModelRoute["thinking"] {
	return typeof entry === "string" ? undefined : entry.thinking;
}

/**
 * Parses `provider/model-id` into a {@link ModelReference}. The provider ends at the first slash, so a model ID may hold
 * slashes of its own, as OpenRouter's `openrouter/anthropic/claude-sonnet-4-5` does. `tier` names the route, a model tier
 * or a lens route's key, and `at` the key the message names. Throws {@link ModelRoutingError} `invalidModel` for text with
 * no provider or no model ID.
 */
export function parseModelReference(text: string, tier: string, at = `models.${tier}`): ModelReference {
	const slash = text.indexOf("/");
	const provider = text.slice(0, slash).trim();
	const modelId = text.slice(slash + 1).trim();
	if (slash === -1 || provider === "" || modelId === "") {
		throw new ModelRoutingError("invalidModel", `${at}: "${text}" is not provider/model-id`, {
			tier,
			model: text,
		});
	}
	return { provider, modelId };
}

/**
 * Routes a tier to its configured model and fallbacks, or, for a route that names no model, to the models its `accept`
 * lists, in order. Throws {@link ModelRoutingError} `noModelForTier` naming the tier when no `melian.yaml` routes it,
 * and `invalidModel` when a configured model is not `provider/model-id`.
 */
export function resolveModelForTier(tier: ModelTier, models: MelianConfig["models"]): ResolvedModelRoute {
	return { tier, ...resolveModelRoute(models[tier], tier, `models.${tier}`, `the ${tier} tier`) };
}

/**
 * Routes `route`, a tier's or a lens's, as {@link resolveModelForTier} routes a tier: `tier` names it for an error,
 * `at` is its key, and `noun` what a missing route is called.
 */
export function resolveModelRoute(
	route: ModelRoute | undefined,
	tier: string,
	at: string,
	noun: string,
): Omit<ResolvedModelRoute, "tier"> {
	const names: readonly FallbackEntry[] =
		route?.model === undefined ? (route?.accept ?? []) : [route.model, ...(route.fallbacks ?? [])];
	const [first, ...rest] = names;
	if (first === undefined) {
		throw new ModelRoutingError(
			"noModelForTier",
			`no model is configured for ${noun}; set ${at}.model in melian.yaml`,
			{
				tier,
			},
		);
	}
	return {
		model: parseModelReference(fallbackModel(first), tier, at),
		fallbacks: rest.map((fallback) => {
			const thinking = fallbackThinking(fallback);
			return {
				...parseModelReference(fallbackModel(fallback), tier, at),
				...(thinking === undefined ? {} : { thinking }),
			};
		}),
	};
}
