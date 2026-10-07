import type { CatalogModel, ModelReference, TextModel, ToolRequest } from "@melian-agent/core";
import type { MelianCredentialStore } from "./credentials.ts";
import type { Api, Model, Models, MutableModels } from "./harness.ts";

/**
 * The models a review runs on: an opaque handle over pi-ai's model collection, so callers outside the pipeline never
 * hold a Pi type. `createReviewModels` builds one; so does the testing entry's `createFakeModels`.
 */
export interface ReviewModels {
	readonly kind: "melian.reviewModels";
}

const collections = new WeakMap<ReviewModels, MutableModels>();
const stores = new WeakMap<ReviewModels, MelianCredentialStore>();

export function wrapModels(models: MutableModels, store?: MelianCredentialStore): ReviewModels {
	const handle: ReviewModels = Object.freeze({ kind: "melian.reviewModels" });
	collections.set(handle, models);
	if (store !== undefined) stores.set(handle, store);
	return handle;
}

export function modelsOf(handle: ReviewModels): MutableModels {
	const models = collections.get(handle);
	if (models === undefined) throw new TypeError("models must come from createReviewModels");
	return models;
}

/**
 * Whether `provider` holds credentials, as planning counts them: a named credential whose command has not run counts
 * as present. Asking runs no command, so a review that spends no tokens runs none; the command runs when the review
 * unlocks credentials, or on the first request that needs it.
 */
export async function hasCredentials(models: ReviewModels, provider: string): Promise<boolean> {
	const described = await stores.get(models)?.describe(provider);
	return (
		described !== undefined ||
		(await modelsOf(models)
			.checkAuth(provider)
			.catch(() => undefined)) !== undefined
	);
}

/** The IDs of the providers in `models` that hold credentials, sorted, for a host that reports readiness. */
export async function providersWithCredentials(models: ReviewModels): Promise<string[]> {
	return Object.keys((await planInputs(models)).credentials).sort();
}

/** What the review plan resolves against, read from a model collection. */
export interface PlanSources {
	/** Every chat model the collection knows, in its order. */
	readonly catalog: readonly CatalogModel[];
	/** Each provider with credentials, to where they come from: a named credential and its file, Pi's login, or the environment variable pi-ai names. */
	readonly credentials: Readonly<Record<string, string>>;
}

/**
 * The catalogue and the credentials present, as `ReviewPlan.resolve` takes them. Finding where a credential comes from
 * runs no command a secrets file names: a command source counts as present until a review first uses it.
 */
export async function planInputs(models: ReviewModels): Promise<PlanSources> {
	const collection = modelsOf(models);
	const store = stores.get(models);
	const catalog = collection.getModels().map(
		(model): CatalogModel => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			reasoning: model.reasoning,
			cost: { input: model.cost.input, output: model.cost.output },
		}),
	);
	const credentials: Record<string, string> = {};
	for (const provider of collection.getProviders()) {
		if (provider.auth.apiKey === undefined && provider.auth.oauth === undefined) continue;
		const described = await store?.describe(provider.id);
		const checked =
			described === undefined ? await collection.checkAuth(provider.id).catch(() => undefined) : undefined;
		const source = described ?? (checked === undefined ? undefined : (checked.source ?? `${provider.id}'s own`));
		if (source !== undefined) credentials[provider.id] = source;
	}
	return { catalog, credentials };
}

/**
 * Reads the named credential of each of `providers` that has one, running its command, so a command that fails or returns an unusable bearer stops
 * a review before it starts, with a `CredentialError` naming the credential and its file, rather than failing a lens.
 */
export async function unlockCredentials(models: ReviewModels, providers: readonly string[]): Promise<void> {
	const store = stores.get(models);
	if (store === undefined) return;
	for (const provider of new Set(providers)) {
		await store.unlock(provider);
	}
}

/**
 * Core's {@link TextModel} over a review's models: one model, asked one request that it must answer by calling the
 * request's tool. The decision adapters ask a model through it without importing Pi.
 */
export class RouteTextModel implements TextModel {
	readonly name: string;
	readonly #models: Models;
	readonly #model: Model<Api>;

	private constructor(models: Models, model: Model<Api>) {
		this.#models = models;
		this.#model = model;
		this.name = `${model.provider}/${model.id}`;
	}

	/** The first model of `route` that `models` knows and holds credentials for, or `undefined` when there is none. */
	static async create(models: ReviewModels, route: readonly ModelReference[]): Promise<RouteTextModel | undefined> {
		const collection = modelsOf(models);
		for (const reference of route) {
			const model = collection.getModel(reference.provider, reference.modelId);
			if (model === undefined) continue;
			if (await hasCredentials(models, reference.provider)) return new RouteTextModel(collection, model);
		}
		return undefined;
	}

	/** The arguments of the model's call to `request.tool`. Throws when the request fails or the model calls no tool. */
	async answer(request: ToolRequest, signal?: AbortSignal): Promise<unknown> {
		const reply = await this.#models.complete(
			this.#model,
			{
				systemPrompt: request.system,
				messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
				tools: [request.tool],
			},
			signal === undefined ? {} : { signal },
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			throw new Error(`${this.name} failed: ${reply.errorMessage ?? reply.stopReason}`);
		}
		const call = reply.content.find((part) => part.type === "toolCall" && part.name === request.tool.name);
		if (call?.type !== "toolCall") throw new Error(`${this.name} answered without calling ${request.tool.name}`);
		return call.arguments;
	}
}
