import type {
	CatalogModel,
	ModelReference,
	ModelRefusal,
	ModelRoute,
	TextAnswer,
	TextModel,
	ToolRequest,
	UsageObserver,
} from "@melian-agent/core";
import type { MelianCredentialStore } from "./credentials.ts";
import {
	type Api,
	isContextOverflow,
	isFailoverError,
	type Model,
	type Models,
	type MutableModels,
} from "./harness.ts";
import { ReasoningCapture } from "./reasoning.ts";

/** Whether a model failure's recorded text is pi-ai's reading of a request too long for the model's context window. */
export function contextOverflowed(text: string): boolean {
	const none = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return isContextOverflow({
		role: "assistant",
		content: [],
		api: "unknown",
		provider: "unknown",
		model: "unknown",
		usage: { ...none, totalTokens: 0, cost: { ...none, total: 0 } },
		stopReason: "error",
		errorMessage: text,
		timestamp: 0,
	});
}

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
 * unlocks credentials, or on the first request that needs it. Only an absent credential reads as false: a Pi store that
 * cannot be read raises its `PiCredentialsError`, naming the file, as it did before this check.
 */
export async function hasCredentials(models: ReviewModels, provider: string): Promise<boolean> {
	const described = await stores.get(models)?.describe(provider);
	return described !== undefined || (await modelsOf(models).checkAuth(provider)) !== undefined;
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
 * Core's {@link TextModel} over a review's models: a route's models that hold credentials, asked one request that the
 * model must answer by calling the request's tool. A model that fails as a lens's would move it, by
 * {@link isFailoverError}, passes the request to the next; the decision adapters ask a model through it without
 * importing Pi.
 */
export class RouteTextModel implements TextModel {
	readonly name: string;
	readonly #models: Models;
	readonly #route: readonly Model<Api>[];
	readonly #thinking: ModelRoute["thinking"];

	private constructor(models: Models, route: readonly Model<Api>[], thinking: ModelRoute["thinking"]) {
		this.#models = models;
		this.#route = route;
		this.#thinking = thinking;
		this.name = this.#nameOf(route[0]!);
	}

	/** The models of `route` that `models` knows and holds credentials for, in order, or `undefined` when there is none. */
	static async create(
		models: ReviewModels,
		route: readonly ModelReference[],
		thinking?: ModelRoute["thinking"],
	): Promise<RouteTextModel | undefined> {
		const collection = modelsOf(models);
		const usable: Model<Api>[] = [];
		for (const reference of route) {
			const model = collection.getModel(reference.provider, reference.modelId);
			if (model === undefined) continue;
			// A store that cannot be read passes the provider over, so a later tier with its own credential still serves.
			if (await hasCredentials(models, reference.provider).catch(() => false)) usable.push(model);
		}
		return usable.length === 0 ? undefined : new RouteTextModel(collection, usable, thinking);
	}

	/**
	 * The model's call to `request.tool`, from the first model of the route that answers. Throws when a model fails in a
	 * way that moves no request, when every model refuses, or when the model that answers calls no tool.
	 */
	async answer(request: ToolRequest, signal?: AbortSignal, usage?: UsageObserver): Promise<TextAnswer> {
		const refused: ModelRefusal[] = [];
		for (const [at, model] of this.#route.entries()) {
			const name = this.#nameOf(model);
			const reply = await this.#ask(model, request, signal, usage);
			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				const reason = reply.errorMessage ?? reply.stopReason;
				const failed = `${name} failed: ${reason}`;
				const moves = reply.stopReason === "error" && !signal?.aborted && isFailoverError(reason);
				if (!moves) throw new Error(failed);
				refused.push({ model: name, reason });
				if (at === this.#route.length - 1)
					throw new Error(
						refused.length === 1
							? failed
							: `every model of the route refused: ${refused.map((each) => `${each.model} failed: ${each.reason}`).join("; ")}`,
					);
				continue;
			}
			const call = reply.content.find((part) => part.type === "toolCall" && part.name === request.tool.name);
			if (call?.type !== "toolCall") throw new Error(`${name} answered without calling ${request.tool.name}`);
			return { arguments: call.arguments, model: name, ...(refused.length === 0 ? {} : { refused }) };
		}
		throw new Error(`${this.name} has no model to ask`);
	}

	#nameOf(model: Model<Api>): string {
		return `${model.provider}/${model.id}${this.#thinking === undefined ? "" : ` thinking=${this.#thinking}`}`;
	}

	async #ask(model: Model<Api>, request: ToolRequest, signal: AbortSignal | undefined, usage?: UsageObserver) {
		if (usage?.started !== undefined) await usage.started();
		const capture = new ReasoningCapture(model, this.#thinking ?? "unspecified");
		const input = {
			systemPrompt: request.system,
			messages: [{ role: "user" as const, content: request.prompt, timestamp: Date.now() }],
			tools: [request.tool],
		};
		const options = { ...capture.options(), ...(signal === undefined ? {} : { signal }) };
		const reply =
			this.#thinking === undefined
				? await this.#models.complete(model, input, options)
				: await this.#models.completeSimple(model, input, {
						...options,
						...(this.#thinking === "off" ? {} : { reasoning: this.#thinking }),
					});
		usage?.(`${reply.provider}/${reply.model}`, reply.usage, capture.finish(reply));
		return reply;
	}
}
