import type { ReasoningSettings, RequestReasoning } from "@melian-agent/core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	backgroundContext,
	copyJson,
	type Harness,
	type Model,
	type Models,
	type ModelsSimpleStreamOptions,
	ProviderDoc,
	type ProviderRequestOptions,
	type Storage,
} from "./harness.ts";
import { type ModelRequestUsage, ModelUsageDocument } from "./token-usage.ts";

const requestDataFields = new Set([
	"messages",
	"input",
	"contents",
	"content",
	"prompt",
	"system",
	"systemInstruction",
	"instructions",
	"tools",
	"toolConfig",
	"schema",
	"json_schema",
	"responseSchema",
	"responseJsonSchema",
	"parameters",
	"metadata",
	"headers",
]);

function hasUnrecognisedReasoning(value: unknown, capturedPaths: ReadonlySet<string>, path: string[] = []): boolean {
	if (value === null || typeof value !== "object") return false;
	return Object.entries(value).some(([key, child]) => {
		const childPath = [...path, key];
		if (child === undefined || requestDataFields.has(key) || capturedPaths.has(JSON.stringify(childPath)))
			return false;
		return (
			/reasoning|thinking|effort|^prompt_?mode$|^chat_template_(?:args|kwargs)$/i.test(key) ||
			hasUnrecognisedReasoning(child, capturedPaths, childPath)
		);
	});
}

export class ReasoningCapture {
	private readonly model: Model<Api>;
	private readonly requested: string;
	private readonly sent: RequestReasoning["sent"] = [];
	private unrecognised = false;

	constructor(model: Model<Api>, requested: string) {
		this.model = model;
		this.requested = requested;
	}

	options(previous?: ProviderRequestOptions["onPayload"]): Pick<ProviderRequestOptions, "onPayload"> {
		return {
			onPayload: async (payload, model) => {
				const replacement = await previous?.(payload, model);
				const observed = replacement === undefined ? payload : replacement;
				const paths = [
					["reasoning"],
					["thinking"],
					["output_config", "effort"],
					["reasoning_effort"],
					["enable_thinking"],
					["chat_template_kwargs"],
					["chat_template_args"],
					["thinking_token_budget"],
					["thinking_budget"],
					["thinking_budget_tokens"],
					["reasoningEffort"],
					["promptMode"],
					["prompt_mode"],
					["config", "thinkingConfig"],
					["generationConfig", "thinkingConfig"],
					["additionalModelRequestFields", "thinking"],
					["additionalModelRequestFields", "output_config", "effort"],
					["additionalModelRequestFields", "reasoning"],
					["additionalModelRequestFields", "reasoning_effort"],
					["options", "reasoning"],
				];
				const settings = copyJson(
					Object.fromEntries(
						paths.map((path) => [
							path.join("."),
							path.reduce<unknown>((value, key) => (Object(value) as Record<string, unknown>)[key], observed),
						]),
					),
					{ omitUndefinedProperties: true },
				) as ReasoningSettings;
				const capturedPaths = new Set(paths.map((path) => JSON.stringify(path)));
				const unrecognised = hasUnrecognisedReasoning(observed, capturedPaths);
				this.unrecognised ||= unrecognised;
				this.sent.push(Object.keys(settings).length === 0 && !unrecognised ? "provider default" : settings);
				return replacement;
			},
		};
	}

	finish(message: AssistantMessage): RequestReasoning {
		// A provider that omits onPayload exposes no sent body; retain only its catalogue mapping.
		const mapped = this.model.thinkingLevelMap?.[this.requested as keyof NonNullable<Model<Api>["thinkingLevelMap"]>];
		return {
			requested: this.requested,
			source: this.unrecognised ? "unrecognised" : this.sent.length === 0 ? "derived, not observed" : "observed",
			sent: structuredClone(this.sent),
			...(this.sent.length === 0 && mapped !== undefined ? { catalogMapped: mapped } : {}),
			...(message.providerThinkingLevel === undefined ? {} : { providerReported: message.providerThinkingLevel }),
		};
	}
}

export class ConversationUsageRecorder {
	private readonly storage: Storage;
	private harness!: Harness;

	constructor(storage: Storage) {
		this.storage = storage;
	}

	attach(harness: Harness): void {
		this.harness = harness;
	}

	models(models: Models): Models {
		return new Proxy(models, {
			get: (target, key) => {
				if (key === "streamSimple")
					return (
						model: Model<Api>,
						input: Parameters<Models["streamSimple"]>[1],
						options?: ModelsSimpleStreamOptions,
					) => {
						const capture = new ReasoningCapture(model, options?.reasoning ?? "off");
						// Pi's JSON-only stream settings exclude onPayload; its host-supplied Models port can pass it through.
						const events = target.streamSimple(model, input, {
							...options,
							...capture.options(options?.onPayload),
						});
						let result: Promise<AssistantMessage> | undefined;
						return new Proxy(events, {
							get: (stream, property) => {
								if (property === "result")
									return () => (result ??= this.record(stream, capture, options?.sessionId));
								const value = Reflect.get(stream, property, stream);
								return typeof value === "function" ? value.bind(stream) : value;
							},
						});
					};
				if (key === "completeSimple")
					return async (
						model: Model<Api>,
						input: Parameters<Models["completeSimple"]>[1],
						options?: ModelsSimpleStreamOptions,
					) => {
						const capture = new ReasoningCapture(model, options?.reasoning ?? "off");
						const reply = await target.completeSimple(model, input, {
							...options,
							...capture.options(options?.onPayload),
						});
						await this.include(reply, capture, options?.sessionId);
						return reply;
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	private async record(
		events: AssistantMessageEventStream,
		capture: ReasoningCapture,
		sessionId: string | undefined,
	): Promise<AssistantMessage> {
		const reply = await events.result();
		await this.include(reply, capture, sessionId);
		return reply;
	}

	private async include(
		reply: AssistantMessage,
		capture: ReasoningCapture,
		sessionId: string | undefined,
	): Promise<void> {
		if (sessionId === undefined) throw new Error("Model request has no provider session");
		let page = await this.storage.scanConversations({}, 200, undefined, backgroundContext);
		for (;;) {
			for (const conversation of page.items) {
				const provider = await this.harness.snapshot(ProviderDoc, conversation.id, backgroundContext);
				if (provider?.sessionId !== sessionId) continue;
				await this.harness.commit(async (tx) => {
					const existing = await tx.doc(
						ModelUsageDocument,
						conversation.id,
						`conversation:${conversation.id}`,
						null,
					);
					existing.requests ??= [];
					existing.requests.push(
						copyJson(
							{
								model: `${reply.provider}/${reply.model}`,
								usage: reply.usage,
								reasoning: capture.finish(reply),
							},
							{ omitUndefinedProperties: true },
						) as ModelRequestUsage,
					);
				}, backgroundContext);
				return;
			}
			if (page.next === undefined) throw new Error("No conversation owns the model request's provider session");
			page = await this.storage.scanConversations({}, 200, page.next, backgroundContext);
		}
	}
}
