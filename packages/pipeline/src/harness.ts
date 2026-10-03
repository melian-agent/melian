/**
 * The import quarantine for Pi Durable, pi-ai, and Chord. It and `testing.ts` are the only modules in Melian that
 * import them. It re-exports Pi's API under Pi's names, so Pi's README stays the reference, and callers compile
 * against Pi's experimental contracts. An upstream rename moves one import here; a changed signature still reaches
 * every caller. A narrow Melian-owned facade grows in front of this module as the pipeline gains callers.
 *
 * @module
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AuthContext, type CredentialStore, defaultProviderAuthContext, type Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	type Harness,
	type HarnessOptions,
	MemoryStorage,
	Harness as PiHarness,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export type { Context } from "@earendil-works/chord";
export {
	type AssistantMessage,
	type AuthContext,
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	defaultProviderAuthContext,
	type Message,
	type Models,
	Type,
} from "@earendil-works/pi-ai";
export {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	configure,
	createRegistry,
	type DocumentReader,
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
	type Tx,
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

/**
 * Every pi-ai built-in provider, resolving stored credentials from `credentials` before the environment variables
 * `authContext` reads, which default to `process.env`.
 */
export function createProviderModels(
	credentials: CredentialStore,
	authContext: AuthContext = defaultProviderAuthContext(),
): Models {
	return builtinModels({ credentials, authContext });
}

/** Storage that keeps everything in memory and persists nothing. */
export function createMemoryStorage(): Storage {
	return new MemoryStorage();
}
