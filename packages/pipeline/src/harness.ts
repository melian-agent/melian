/**
 * The one module in Melian that imports Pi Durable and Chord. Pi Durable's API is experimental, so upstream churn lands
 * here and nowhere else. Pi's concepts keep Pi's names, so Pi's README stays the reference; helpers Melian adds have
 * Melian names.
 *
 * @module
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type FauxProviderHandle,
	fauxProvider,
	type Model,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type Harness,
	type HarnessOptions,
	MemoryStorage,
	type ModelRef,
	Harness as PiHarness,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export type { Context } from "@earendil-works/chord";
export {
	type AssistantMessage,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
export {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryRecord,
	type Harness,
	type HarnessOptions,
	hook,
	type ModelRef,
	type Registry,
	type Storage,
	type SubmissionId,
	SystemEntry,
	section,
	type TaskId,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";

/** A context that is never cancelled, for work with no caller to cancel it. */
export const backgroundContext: Context = BACKGROUND_CONTEXT;

/** Open a harness over `storage`. Pending work stays pending until `resume()`, a submission, or a wait. */
export function openHarness<Tool extends ToolRegistration>(
	storage: Storage,
	options: HarnessOptions<Tool>,
	context: Context = backgroundContext,
): Promise<Harness> {
	return PiHarness.open(storage, options, context);
}

/** Durable storage in one SQLite file, created when absent. One process may own it at a time. */
export function openSqliteStorage(path: string): Promise<Storage> {
	return openNodeSqliteStorage(path);
}

/** Storage that keeps everything in memory and persists nothing. */
export function createMemoryStorage(): Storage {
	return new MemoryStorage();
}

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
