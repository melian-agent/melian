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
	fauxToolCall,
	type Message,
	type Model,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Verification } from "@melian-agent/core";
import type { HarnessOptions, ModelRef } from "./harness.ts";
import { modelsOf, type ReviewModels, wrapModels } from "./models.ts";
import { verifierMarker } from "./verification-instructions.ts";

export { type FauxProviderHandle, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

/** A scripted model provider for tests, registered in its own model collection. */
export type FakeModels = {
	readonly models: HarnessOptions["models"];
	readonly provider: FauxProviderHandle;
	/** The same collection as `models`, as the handle `reviewChangeset` and `openReviewHarness` take. */
	readonly review: ReviewModels;
	/** The reference a conversation's agent uses to select `modelId`, or the first model. */
	ref(modelId?: string): ModelRef;
	/** Registers a provider of its own that holds a model `modelId` but no credentials, and returns that model's reference. */
	withoutCredentials(modelId: string): ModelRef;
};

/** Creates a scripted provider in its own collection, or alongside an existing review collection for a planted finder. */
export function createFakeModels(options?: RegisterFauxProviderOptions, review?: ReviewModels): FakeModels {
	const provider = fauxProvider(options);
	const models = review === undefined ? createModels() : modelsOf(review);
	models.setProvider(provider.provider);
	return {
		models,
		provider,
		review: review ?? wrapModels(models),
		withoutCredentials(modelId) {
			const locked = fauxProvider({ provider: "locked", models: [{ id: modelId }] });
			models.setProvider({
				...locked.provider,
				auth: { apiKey: { name: "Locked", resolve: async () => undefined } },
			});
			return { provider: "locked", modelId };
		},
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
	verdicts: VerifierScript = {},
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
		if (script === undefined && prompt.includes(verifierMarker)) {
			requests[verifierMarker] ??= [];
			requests[verifierMarker]!.push(structuredClone([...context.messages]));
			return scriptVerifier(context.messages, verdicts);
		}
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
	fake.provider.setResponses(Array.from({ length: total + scripts.length + 256 }, () => respond));
	return requests;
}

/**
 * One scripted lens turn: tool calls the model makes, or its final answer. The shape of a golden's `script.json`. A
 * call's `expectToolResult` is a substring its result must contain, so a tool that breaks fails the run that scripts it.
 */
export type LensScriptStep =
	| {
			readonly calls: readonly {
				readonly name: string;
				readonly arguments: Readonly<Record<string, unknown>>;
				readonly expectToolResult?: string;
			}[];
	  }
	| { readonly text: string };

/** Scripted judgements by finding ID, with evidence required when a supplied outcome refutes a claim. */
export type VerifierScript = Readonly<
	Record<
		string,
		| Verification["verdict"]
		| {
				verdict: Verification["verdict"];
				reason?: string;
				correction?: string;
				evidence?: readonly {
					file: string;
					line: number;
					endLine?: number;
					role: "cause" | "context";
					revision?: "head" | "base";
				}[];
		  }
	>
>;

export type LensScript = Readonly<Record<string, readonly LensScriptStep[] | VerifierScript>>;

// The text of each tool result answering the last assistant turn in `messages`, by tool call ID.
function lastResults(messages: readonly Message[]): Map<string, string> {
	const results = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "assistant") results.clear();
		if (message.role === "toolResult") results.set(message.toolCallId, text(message));
	}
	return results;
}

// Each reply first checks the previous step's calls against their expected results, which it finds in the request.
function lensReplies(lens: string, steps: readonly LensScriptStep[], mismatches: string[]): ScriptedReply[] {
	const ids: string[][] = [];
	return steps.map((step, index) => (messages: readonly Message[]) => {
		const previous = index === 0 ? undefined : steps[index - 1];
		if (previous !== undefined && "calls" in previous) {
			const results = lastResults(messages);
			previous.calls.forEach((call, position) => {
				const result = results.get(ids[index - 1]![position]!) ?? "";
				if (call.expectToolResult !== undefined && !result.includes(call.expectToolResult)) {
					mismatches.push(
						`${lens} step ${index}: ${call.name} returned ${JSON.stringify(result)}, expected it to contain ${JSON.stringify(call.expectToolResult)}`,
					);
				}
			});
		}
		if ("text" in step) return fauxAssistantMessage(step.text);
		const calls = step.calls.map((call) =>
			fauxToolCall(call.name, call.arguments as Parameters<typeof fauxToolCall>[1]),
		);
		ids[index] = calls.map((call) => call.id);
		return fauxAssistantMessage(calls, { stopReason: "toolUse" });
	});
}

/**
 * Scripts each lens in `script` by name, matching its conversation by the lens's instructions, as
 * {@link scriptConversations} does. Throws for a name no lens in `lenses` has. The longest instructions match first,
 * so a lens extending another is not answered from the other's script. Each scripted call whose result lacks its
 * `expectToolResult` is described in `mismatches`, when given.
 */
export function scriptLenses(
	fake: FakeModels,
	lenses: readonly { readonly name: string; readonly instructions: string }[],
	script: LensScript,
	mismatches: string[] = [],
): Record<string, Message[][]> {
	const scripts = Object.entries(script)
		.filter(([name]) => name !== "verifier")
		.map(([name, steps]) => {
			const lens = lenses.find((each) => each.name === name);
			if (lens === undefined) throw new Error(`the script names ${name}, which is not a lens here`);
			return {
				match: lens.instructions,
				replies: lensReplies(name, steps as readonly LensScriptStep[], mismatches),
			};
		})
		.sort((a, b) => b.match.length - a.match.length);
	return scriptConversations(fake, scripts, script.verifier as VerifierScript | undefined);
}

/** Answers verifier requests from their messages alone, safely across parallel conversations. */
export function scriptVerifier(messages: readonly Message[], verdicts: VerifierScript = {}): AssistantMessage {
	if (
		messages.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some((block) => block.type === "toolCall" && block.name === "report_verdict"),
		)
	)
		return fauxAssistantMessage("Every claim judged.");
	const prompt = systemPromptOf(messages);
	const calls = [...prompt.matchAll(/Claim (c[1-9][0-9]*) finding ([0-9a-f]+)/g)].map((match) => {
		const scripted = verdicts[match[2]!] ?? "confirmed";
		const outcome = typeof scripted === "string" ? { verdict: scripted } : scripted;
		const reason = outcome.reason ?? "The scripted verifier traced the claim.";
		return fauxToolCall("report_verdict", {
			claim: match[1]!,
			answers: { code: "yes", guard: outcome.verdict === "refuted" ? "yes" : "no", base: "no" },
			verdict: outcome.verdict,
			reason,
			...("correction" in outcome && outcome.correction !== undefined ? { correction: outcome.correction } : {}),
			...("evidence" in outcome && outcome.evidence !== undefined ? { evidence: [...outcome.evidence] } : {}),
		});
	});
	return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}
