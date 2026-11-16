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

/** A model of a route, naming the level it runs at where that differs from the route's. */
export type AtLevel<T> = Omit<T, "thinking"> & { readonly thinking?: ModelRoute["thinking"] };

/**
 * The route that runs `models`, a route's models at `thinking` that a credential reaches, in order: the level it runs
 * at, and each model naming its own where it differs. A model that names no level runs at `thinking`, so a route whose
 * model names one must name its own, as configuration requires; one that does not is refused, never inherited. Every
 * place that drops a model from a route takes the route that runs from here.
 */
export function routeInOrder<T extends { readonly thinking?: ModelRoute["thinking"] }>(
	models: readonly T[],
	thinking: ModelRoute["thinking"],
): { readonly thinking?: ModelRoute["thinking"]; readonly route: AtLevel<T>[] } {
	if (thinking === undefined && models.some((each) => each.thinking !== undefined))
		throw new Error("a model names a thinking level on a route that names none; the route must name its own");
	const level = models[0]?.thinking ?? thinking;
	const at = ({ thinking: _own, ...model }: T, own: ModelRoute["thinking"]): AtLevel<T> =>
		own === undefined ? model : { ...model, thinking: own };
	return {
		...(level === undefined ? {} : { thinking: level }),
		route: models.map((each, index) =>
			at(each, index === 0 ? undefined : (each.thinking ?? (level === thinking ? undefined : thinking))),
		),
	};
}

/** `run`, a route {@link routeInOrder} gives, as a file writes it. */
export function writtenRoute(run: {
	readonly thinking?: ModelRoute["thinking"];
	readonly route: readonly { readonly model: string; readonly thinking?: ModelRoute["thinking"] }[];
}): ModelRoute {
	const [first, ...rest] = run.route;
	return {
		...(run.thinking === undefined ? {} : { thinking: run.thinking }),
		...(first === undefined
			? {}
			: { model: first.model, fallbacks: rest.map((each) => fallbackEntry(each.model, each.thinking)) }),
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
