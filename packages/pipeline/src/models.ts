import type { Models } from "./harness.ts";

/**
 * The models a review runs on: an opaque handle over pi-ai's model collection, so callers outside the pipeline never
 * hold a Pi type. `createReviewModels` builds one; so does the testing entry's `createFakeModels`.
 */
export interface ReviewModels {
	readonly kind: "melian.reviewModels";
}

const collections = new WeakMap<ReviewModels, Models>();

export function wrapModels(models: Models): ReviewModels {
	const handle: ReviewModels = Object.freeze({ kind: "melian.reviewModels" });
	collections.set(handle, models);
	return handle;
}

export function modelsOf(handle: ReviewModels): Models {
	const models = collections.get(handle);
	if (models === undefined) throw new TypeError("models must come from createReviewModels");
	return models;
}

/** The IDs of the providers in `models` that hold credentials, sorted, for a host that reports readiness. */
export async function providersWithCredentials(models: ReviewModels): Promise<string[]> {
	const collection = modelsOf(models);
	const configured: string[] = [];
	for (const provider of collection.getProviders()) {
		if ((await collection.checkAuth(provider.id).catch(() => undefined)) !== undefined) configured.push(provider.id);
	}
	return configured.sort();
}
