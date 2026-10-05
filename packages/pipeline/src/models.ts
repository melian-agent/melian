import type { ModelReference, TextModel, ToolRequest } from "@melian-agent/core";
import type { Api, Model, Models } from "./harness.ts";

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
	static async open(models: ReviewModels, route: readonly ModelReference[]): Promise<RouteTextModel | undefined> {
		const collection = modelsOf(models);
		for (const reference of route) {
			const model = collection.getModel(reference.provider, reference.modelId);
			if (model === undefined) continue;
			if ((await collection.checkAuth(reference.provider).catch(() => undefined)) !== undefined) {
				return new RouteTextModel(collection, model);
			}
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
