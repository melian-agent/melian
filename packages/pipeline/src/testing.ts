/**
 * Test helpers for code built on the pipeline harness: a scripted model provider and pi-ai's builders for its replies.
 * Kept out of the package's main entry so runtime callers never see them.
 *
 * @module
 */
import {
	type FauxProviderHandle,
	fauxProvider,
	type Model,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { HarnessOptions, ModelRef } from "./harness.ts";

export { type FauxProviderHandle, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

/** A scripted model provider for tests, registered in its own model collection. */
export type FakeModels = {
	readonly models: HarnessOptions["models"];
	readonly provider: FauxProviderHandle;
	/** The reference a conversation's agent uses to select `modelId`, or the first model. */
	ref(modelId?: string): ModelRef;
};

/** Create a scripted model provider that answers from queued responses, so tests need no credentials. */
export function createFakeModels(options?: RegisterFauxProviderOptions): FakeModels {
	const provider = fauxProvider(options);
	const models = createModels();
	models.setProvider(provider.provider);
	return {
		models,
		provider,
		ref(modelId) {
			const model: Model<string> | undefined =
				modelId === undefined ? provider.getModel() : provider.getModel(modelId);
			if (model === undefined) throw new Error(`Fake model ${modelId} is not registered`);
			return { provider: model.provider, modelId: model.id };
		},
	};
}
