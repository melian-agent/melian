import type { CatalogModel } from "@melian-agent/core";
import type { MelianCredentialStore } from "./credentials.ts";
import type { Models } from "./harness.ts";

/**
 * The models a review runs on: an opaque handle over pi-ai's model collection, so callers outside the pipeline never
 * hold a Pi type. `createReviewModels` builds one; so does the testing entry's `createFakeModels`.
 */
export interface ReviewModels {
	readonly kind: "melian.reviewModels";
}

const collections = new WeakMap<ReviewModels, Models>();
const stores = new WeakMap<ReviewModels, MelianCredentialStore>();

export function wrapModels(models: Models, store?: MelianCredentialStore): ReviewModels {
	const handle: ReviewModels = Object.freeze({ kind: "melian.reviewModels" });
	collections.set(handle, models);
	if (store !== undefined) stores.set(handle, store);
	return handle;
}

export function modelsOf(handle: ReviewModels): Models {
	const models = collections.get(handle);
	if (models === undefined) throw new TypeError("models must come from createReviewModels");
	return models;
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
 * Reads the named credential of each of `providers` that has one, running its command, so a command that fails stops
 * a review before it starts, with a `CredentialError` naming the credential and its file, rather than failing a lens.
 */
export async function unlockCredentials(models: ReviewModels, providers: readonly string[]): Promise<void> {
	const store = stores.get(models);
	if (store === undefined) return;
	for (const provider of new Set(providers)) {
		const credential = await store.credential(provider);
		if (credential !== undefined) await store.value(credential);
	}
}
