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
import {
	type AssistantMessage,
	type AuthContext,
	type CredentialStore,
	defaultProviderAuthContext,
	isRetryableAssistantError,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	type Harness,
	type HarnessOptions,
	MemoryStorage,
	Harness as PiHarness,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export type { Context } from "@earendil-works/chord";
export {
	type Api,
	type AssistantMessage,
	type AuthContext,
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	defaultProviderAuthContext,
	type Message,
	type Model,
	type Models,
	type MutableModels,
	type ToolCall,
	Type,
} from "@earendil-works/pi-ai";
// The validator Pi Durable's tool task applies to a call's arguments before any hook.
export { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
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
	LiveDoc,
	type ModelRef,
	type Registry,
	ROOT_CONVERSATION_ID,
	type Storage,
	type SubmissionId,
	SystemEntry,
	section,
	type TaskId,
	type ToolExecutionApi,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
	type ToolTaskInput,
	type Tx,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
export type { ExecutionEnv } from "@earendil-works/pi-durable/env";

// pi-ai has no classifier for authentication failures, so match what its providers and credential resolution report:
// a missing key, a failed OAuth refresh, Melian's read-only store refusing one, or a provider's 401 or 403.
const authenticationFailure =
	/no api key|api key auth failed|oauth|credential|run pi to refresh|authenticat|unauthori[sz]ed|forbidden|\b40[13]\b|invalid[ _-]?(x-)?(api[ _-]?key|token)/i;

/**
 * Whether a model failure, by its message, should move a lens to its tier's next model: a transient provider failure,
 * which pi-ai's own retries have already given up on, or a failed authentication.
 */
export function isFailoverError(message: string): boolean {
	const failed = { role: "assistant", stopReason: "error", errorMessage: message } as AssistantMessage;
	return authenticationFailure.test(message) || isRetryableAssistantError(failed);
}

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
 * An execution environment on this machine, with `cwd` as its working directory: a `FileSystem` and a `Shell` over the
 * local disk and processes. Static tools run through it; a container environment implementing the same interface can
 * replace it.
 */
export function createNodeExecutionEnv(cwd: string): ExecutionEnv {
	return new NodeExecutionEnv({ cwd });
}

/**
 * Every pi-ai built-in provider, resolving stored credentials from `credentials` before the environment variables
 * `authContext` reads, which default to `process.env`.
 */
export function createProviderModels(
	credentials: CredentialStore,
	authContext: AuthContext = defaultProviderAuthContext(),
): MutableModels {
	return builtinModels({ credentials, authContext });
}

/** Storage that keeps everything in memory and persists nothing. */
export function createMemoryStorage(): Storage {
	return new MemoryStorage();
}
