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
	CompactionEntry,
	type ContextView,
	type ConversationId,
	type EntryId,
	type Harness,
	type HarnessOptions,
	MemoryStorage,
	Harness as PiHarness,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { installedVersion } from "./installed-version.ts";

export type { Context } from "@earendil-works/chord";
export { copyJson } from "@earendil-works/chord";
// pi-ai's reading of a failure as a request too long for the model's context window.
export {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthContext,
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	defaultProviderAuthContext,
	isContextOverflow,
	type Message,
	type Model,
	type Models,
	type ModelsSimpleStreamOptions,
	type MutableModels,
	type ProviderRequestOptions,
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
	type DocumentRecord,
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	type EntryRecord,
	type Harness,
	type HarnessOptions,
	hook,
	type JsonObject,
	LiveDoc,
	type ModelRef,
	ProviderDoc,
	type Registry,
	ROOT_CONVERSATION_ID,
	type Storage,
	type SubmissionId,
	SystemEntry,
	section,
	type TaskId,
	type TaskRecord,
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

// pi-ai exports no classifier for provider limits, only `isRetryableAssistantError`, which refuses them because
// retrying the same provider cannot help. Another provider is unaffected, so a lens moves on. The strings mirror
// NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN in pi-ai's dist/utils/retry.js, with two differences: a bare "billing"
// would also match a malformed request that names a billing field, so it is narrowed to limit wording; and the
// "usage limit" and "usage_limit_reached" forms are added, which pi's Codex adapter emits (api/openai-codex-responses.js).
const providerLimit =
	/GoUsageLimitError|FreeUsageLimitError|usage[ _]limit|available balance|insufficient_quota|out of budget|quota exceeded|billing[ _](hard[ _])?(limit|quota)|billing[ _]not[ _]active|check your billing|subscription_sharing_usage_limit_exceeded/i;

// A provider's content filter stopping the reply, by the whole message each of pi-ai's adapters builds for one, so a
// message that only mentions a filter does not match. Codex's text after its prefix is the provider's own. Anthropic's
// `refusal` with an explanation, and a Bedrock guardrail the account set, are left out, as
// docs/decisions/2026-11-20-content-filter-refusal-fails-over.md says.
const contentRefusal =
	/^(?:Codex error: This content was flagged for possible |(?:Provider stopped with: (?:sensitive|content_filtered|SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII)|Provider finish_reason: content_filter|Response incomplete: content_filter|The model refused to complete the request)$)/;

/** Whether a model failure, by its message, is a provider's content filter refusing what the model was sent. */
export function isContentRefusal(message: string): boolean {
	return contentRefusal.test(message);
}

/** Whether a model failure, by its message, is a provider's usage limit, quota or billing limit. */
export function isProviderLimit(message: string): boolean {
	return providerLimit.test(message);
}

/**
 * Whether a model failure, by its message, should move a lens to its tier's next model: a transient provider failure,
 * which pi-ai's own retries have already given up on, a provider's usage limit, a failed authentication, or a
 * provider's content filter refusing the request.
 */
export function isFailoverError(message: string): boolean {
	const failed = { role: "assistant", stopReason: "error", errorMessage: message } as AssistantMessage;
	return (
		authenticationFailure.test(message) ||
		isProviderLimit(message) ||
		isContentRefusal(message) ||
		isRetryableAssistantError(failed)
	);
}

/**
 * Whether a conversation holds work a model did: a reply Pi Durable keeps in the context the next model is shown. A
 * compaction leaves only a summary there, so this walks back through each compaction to the context it summarised. A
 * reset links to nothing before it, so work before one counts as none.
 */
export async function holdsWork(
	reader: {
		context(id: ConversationId, context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
	},
	id: ConversationId,
	context: Context,
): Promise<boolean> {
	const seen = new Set<EntryId>();
	for (let at: EntryId | undefined; ; ) {
		const view = await reader.context(id, context, { at });
		if (view.messages.some((message) => message.role === "assistant")) return true;
		const { head } = view;
		if (!CompactionEntry.is(head) || seen.has(head.id)) return false;
		seen.add(head.id);
		at = head.head;
	}
}

/**
 * The installed releases of the Pi packages whose code shapes what a model is shown. Pi Durable renders the system
 * prompt's sections and writes the turns the harness adds, such as a cut tool result's note; pi-ai turns the
 * conversation into each provider's request. Chord carries no text a model reads.
 */
export const piVersions: { readonly durable: string; readonly ai: string } = {
	durable: installedVersion("@earendil-works/pi-durable", import.meta.url),
	ai: installedVersion("@earendil-works/pi-ai", import.meta.url),
};

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

/** Durable storage as Pi's JSONL files in one directory, created when absent. One process may own it at a time. */
export function openJsonlStorage(directory: string, context: Context = backgroundContext): Promise<Storage> {
	return openNodeJsonlStorage(directory, context);
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
