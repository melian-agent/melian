/**
 * Test helpers for code built on the pipeline harness: a scripted model provider and pi-ai's builders for its replies.
 * Kept out of the package's main entry so runtime callers never see them.
 *
 * @module
 */
import {
	type AssistantMessage,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	type Message,
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

/**
 * One scripted reply: a message, or a function of the messages the model was sent and the model's ID, which may return
 * a promise, such as one that never settles to hold a request open.
 */
export type ScriptedReply =
	| AssistantMessage
	| ((messages: readonly Message[], modelId: string) => AssistantMessage | Promise<AssistantMessage>);

/** The replies for every conversation whose system prompt contains `match`, in order. */
export type ConversationScript = { readonly match: string; readonly replies: readonly ScriptedReply[] };

function text(message: Message): string {
	if (message.role === "system") {
		const content =
			typeof message.content === "string" ? message.content : message.content.map((each) => each.text).join("");
		return [content, ...Object.values(message.sections ?? {})].join("\n");
	}
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** The system prompt of a request: every system message's text and sections. */
export function systemPromptOf(messages: readonly Message[]): string {
	return messages
		.filter((message) => message.role === "system")
		.map(text)
		.join("\n");
}

/** The text a request carried, any role, for asserting on what a model was shown. */
export function textOf(message: Message): string {
	return text(message);
}

/**
 * Answers each request from the first script whose `match` appears in its system prompt, so parallel conversations,
 * such as lenses, each follow their own script whatever order the harness calls the model in. Returns every request
 * each script answered, by `match`. A request no script matches, or one past a script's end, gets an error reply,
 * which fails that conversation's run.
 */
export function scriptConversations(
	fake: FakeModels,
	scripts: readonly ConversationScript[],
): Record<string, Message[][]> {
	const requests: Record<string, Message[][]> = Object.fromEntries(scripts.map((script) => [script.match, []]));
	const respond = (
		context: { readonly messages: readonly Message[] },
		_options: unknown,
		_state: unknown,
		model: Model<string>,
	): AssistantMessage | Promise<AssistantMessage> => {
		const prompt = systemPromptOf(context.messages);
		const script = scripts.find((each) => prompt.includes(each.match));
		if (script === undefined) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "no script" });
		const seen = requests[script.match]!;
		seen.push(structuredClone([...context.messages]));
		const reply = script.replies[seen.length - 1];
		if (reply === undefined) {
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: `script "${script.match}" ran out` });
		}
		return typeof reply === "function" ? reply(context.messages, model.id) : reply;
	};
	const total = scripts.reduce((sum, script) => sum + script.replies.length, 0);
	fake.provider.setResponses(Array.from({ length: total + scripts.length + 8 }, () => respond));
	return requests;
}
