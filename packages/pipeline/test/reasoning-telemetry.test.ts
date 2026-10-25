import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, type ReasoningSettings, Revision } from "@melian-agent/core";
import { FallbackDecider } from "@melian-agent/decisions";
import {
	type ConversationId,
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	createReviewRegistry,
	defineDocFamily,
	openHarness,
	openReviewHarness,
	openSqliteStorage,
	RouteTextModel,
	reviewChangeset,
	StageTelemetry,
	summarizeReview,
	TelemetryReader,
	TokenUsage,
	UsageDoc,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptVerifier,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { expect, it, vi } from "vitest";
import { ProviderDoc } from "../src/harness.ts";
import { ConversationUsageRecorder, ReasoningCapture } from "../src/reasoning.ts";
import { type ModelRequestUsage, ModelUsageDocument, type UsageSummary } from "../src/token-usage.ts";
import { crashFinding, crashRepository } from "./fixtures/review-scenario.ts";

function recordReplies(fake: FakeModels) {
	const received: { model: string; body: unknown; usage: ModelRequestUsage["usage"] }[] = [];
	for (const method of ["stream", "streamSimple"] as const) {
		const stream = fake.models[method].bind(fake.models);
		vi.spyOn(fake.models, method).mockImplementation((...args: Parameters<FakeModels["models"]["streamSimple"]>) => {
			const [model, input, options] = args;
			let body: unknown;
			const events = stream(model, input, {
				...options,
				onPayload: async (payload, requestedModel) => {
					const replacement = await options?.onPayload?.(payload, requestedModel);
					body = replacement ?? payload;
					return replacement;
				},
			});
			const result = events.result.bind(events);
			vi.spyOn(events, "result").mockImplementation(async () => {
				const reply = await result();
				const usage = { ...reply.usage, totalTokens: 101 + received.length };
				received.push({ model: `${reply.provider}/${reply.model}`, body, usage: structuredClone(usage) });
				return { ...reply, usage };
			});
			return events;
		});
	}
	return received;
}

it.each([
	{ body: { reasoning: { effort: "none" } }, expected: { reasoning: { effort: "none" } } },
	{
		body: { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
		expected: { thinking: { type: "adaptive" }, "output_config.effort": "high" },
	},
	{ body: {}, expected: "provider default" },
])("records the body a generation provider received: $body", async ({ body, expected }) => {
	const fake = createFakeModels();
	const received = recordReplies(fake);
	fake.provider.setResponses([
		async (_request, options, _state, model) => {
			expect(options?.reasoning).toBeUndefined();
			const payload = { messages: [{ content: "must not be stored" }], ...body };
			await options?.onPayload?.(payload, model);
			return { ...fauxAssistantMessage("Done."), providerThinkingLevel: "provider-reported" };
		},
	]);
	const storage = createMemoryStorage();
	const recorder = new ConversationUsageRecorder(storage);
	const harness = await openHarness(storage, {
		models: recorder.models(fake.models),
		registry: createRegistry(),
		settings: { retry: { enabled: false } },
	});
	recorder.attach(harness);
	try {
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		await (await root.submit({ type: "input", content: "Review the change" }, context)).wait(context);
		const stored = await harness.snapshot(ModelUsageDocument, root.id, `conversation:${root.id}`, context);
		expect(received.map((reply) => reply.body)).toEqual([{ messages: [{ content: "must not be stored" }], ...body }]);
		expect(stored).toMatchObject({
			requests: [
				{
					model: `${fake.ref().provider}/${fake.ref().modelId}`,
					reasoning: {
						requested: "off",
						source: "observed",
						sent: [expected],
						providerReported: "provider-reported",
					},
				},
			],
		});
		expect(stored?.requests?.map((request) => request.usage)).toEqual(received.map((reply) => reply.usage));
		expect(JSON.stringify(stored)).not.toContain("must not be stored");
	} finally {
		await harness.close(context);
	}
});

it.each(["off", "high"] as const)("captures compaction beside generation requests at %s", async (thinkingLevel) => {
	const fake = createFakeModels();
	const received = recordReplies(fake);
	fake.provider.setResponses(
		Array.from({ length: 3 }, () => async (_request, options, _state, model) => {
			expect(options?.reasoning).toBe(thinkingLevel === "off" ? undefined : thinkingLevel);
			const body = { reasoning: { effort: options?.cacheRetention === "none" ? "low" : "none" } };
			await options?.onPayload?.(body, model);
			return fauxAssistantMessage("A summary or answer.");
		}),
	);
	const storage = createMemoryStorage();
	const recorder = new ConversationUsageRecorder(storage);
	const harness = await openHarness(storage, {
		models: recorder.models(fake.models),
		registry: createRegistry(),
		settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
	});
	recorder.attach(harness);
	try {
		const root = await harness.root(context, { agent: { model: fake.ref(), thinkingLevel } });
		await (await root.submit({ type: "input", content: "First input" }, context)).wait(context);
		await (await root.submit({ type: "input", content: "Second input" }, context)).wait(context);
		await harness.waitForTask(await root.compact(undefined, context), context);
		const stored = await harness.snapshot(ModelUsageDocument, root.id, `conversation:${root.id}`, context);
		expect(received.map((reply) => reply.body)).toEqual([
			{ reasoning: { effort: "none" } },
			{ reasoning: { effort: "none" } },
			{ reasoning: { effort: "low" } },
		]);
		expect(stored).toMatchObject({
			requests: received.map(({ body }) => ({
				reasoning: { requested: thinkingLevel, source: "observed", sent: [body] },
			})),
		});
		expect(stored?.requests?.map((request) => request.usage)).toEqual(received.map((reply) => reply.usage));
	} finally {
		await harness.close(context);
	}
});

it("passes triage's observed body through its usage observer before rejecting prose", async () => {
	const fake = createFakeModels();
	const received: unknown[] = [];
	fake.provider.setResponses([
		async (_request, options, _state, model) => {
			const body = { thinking: { type: "adaptive" }, output_config: { effort: "high" } };
			received.push(body);
			await options?.onPayload?.(body, model);
			return { ...fauxAssistantMessage("No answer tool"), providerThinkingLevel: "high" };
		},
	]);
	const model = (await RouteTextModel.create(fake.review, [fake.ref()]))!;
	const observer = vi.fn();
	await expect(
		model.answer(
			{
				system: "Triage",
				prompt: "Choose a level",
				tool: { name: "answer", description: "Answer", parameters: { type: "object" } },
			},
			undefined,
			observer,
		),
	).rejects.toThrow("without calling answer");
	expect(received).toEqual([{ thinking: { type: "adaptive" }, output_config: { effort: "high" } }]);
	expect(observer).toHaveBeenCalledWith(model.name, expect.anything(), {
		requested: "unspecified",
		source: "observed",
		sent: [{ thinking: { type: "adaptive" }, "output_config.effort": "high" }],
		providerReported: "high",
	});
});

it.each(["model-usage-v1-main.json", "model-usage-v2-pass3.json"])(
	"preserves %s and a new capture across two reopens",
	async (fixture) => {
		const recorded = JSON.parse(readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8")) as {
			recordedBy: string;
			version: number;
			value: { usage?: UsageSummary; requests?: ModelRequestUsage[] };
		};
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-reasoning-reopen-")));
		try {
			const file = join(directory, "state.sqlite");
			const fake = createFakeModels();
			const first = await openHarness(await openSqliteStorage(file), {
				models: fake.models,
				registry: createRegistry(),
			});
			const previous = defineDocFamily<{ usage?: UsageSummary; requests?: ModelRequestUsage[] }, null>({
				kind: ModelUsageDocument.definition.kind,
				family: true,
				scope: "conversation",
				history: "latest",
				fork: "current",
				version: recorded.version,
				initial: () => recorded.value,
			});
			const root = await first.root(context);
			await first.commit(async (tx) => {
				await tx.doc(previous, root.id, "123", null);
			}, context);
			await first.close(context);
			const capture = new ReasoningCapture(fake.provider.getModel(), "high");
			await capture.options().onPayload!({ vendor: { reasoning: "private" } }, fake.provider.getModel());
			const receipt = {
				model: "faux/faux-1",
				usage: fauxAssistantMessage("Done").usage,
				reasoning: capture.finish(fauxAssistantMessage("Done")),
			};
			const expected = { ...recorded.value, requests: [...(recorded.value.requests ?? []), receipt] };
			const storage = await openSqliteStorage(file);
			const reopened = await openHarness(storage, { models: fake.models, registry: createRegistry() });

			try {
				expect(ModelUsageDocument.definition.version).toBe(3);
				expect(await reopened.snapshot(ModelUsageDocument, root.id, "123", context)).toEqual(recorded.value);
				await reopened.commit(async (tx) => {
					const doc = await tx.doc(ModelUsageDocument, root.id, "123", null);
					doc.requests = expected.requests;
				}, context);
			} finally {
				await reopened.close(context);
			}
			const again = await openHarness(await openSqliteStorage(file), {
				models: fake.models,
				registry: createRegistry(),
			});
			try {
				expect(await again.snapshot(ModelUsageDocument, root.id, "123", context)).toEqual(expected);
			} finally {
				await again.close(context);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

it.each(["melian.lens", "melian.verification.candidate", "melian.walkthrough", "melian.triage", "failover"])(
	"records each actual %s request beside its own usage",
	async (kind) => {
		const repo = crashRepository();
		const fake = createFakeModels({
			models: [{ id: "finder" }, { id: "judge" }, { id: "summary" }, { id: "triage" }, { id: "unavailable" }],
		});
		const received = recordReplies(fake);
		fake.provider.setResponses(
			Array.from({ length: 12 }, () => async (request, options, _state, model) => {
				const body = { reasoning: { effort: `${model.id}-effort` } };
				await options?.onPayload?.(body, model);
				const prompt = systemPromptOf(request.messages);
				let reply: ReturnType<typeof fauxAssistantMessage>;
				if (model.id === "triage") {
					expect(prompt).toContain("You answer typed questions");
					reply = fauxAssistantMessage(
						fauxToolCall("answer", {
							answers: [{ question: "correctness", probabilities: [{ option: "careful", probability: 1 }] }],
						}),
						{ stopReason: "toolUse" },
					);
				} else if (model.id === "unavailable") {
					expect(prompt).toContain("correctness reviewer");
					reply = fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit exceeded" });
				} else if (model.id === "finder") {
					expect(prompt).toContain("correctness reviewer");
					reply = request.messages.some((message) => message.role === "toolResult")
						? fauxAssistantMessage("Done.")
						: fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" });
				} else if (model.id === "judge") {
					reply = scriptVerifier(request.messages);
				} else {
					expect(model.id).toBe("summary");
					expect(prompt).toContain("You write Melian's walkthrough");
					reply = fauxAssistantMessage(
						fauxToolCall("record_walkthrough", {
							summary: "Changes manager lookup.",
							files: [{ path: "src/user.ts", summary: "Removes the optional chain." }],
						}),
						{ stopReason: "toolUse" },
					);
				}
				return { ...reply, providerThinkingLevel: `reported-${model.id}` };
			}),
		);
		const textModel = (await RouteTextModel.create(fake.review, [fake.ref("triage")]))!;
		const decider = new FallbackDecider(textModel);
		const storage = createMemoryStorage();
		const opened = await openReviewHarness(storage, fake.review, { decider, retry: false });
		try {
			const changeset = await Changeset.resolve(repo, "main...feature");
			const config = {
				...defaultConfig,
				tiers: { full: ["lens.correctness"] },
				models: {
					heavy: { model: "faux/unavailable", fallbacks: ["faux/finder"] },
					medium: { model: "faux/finder" },
					verifier: { model: "faux/judge" },
					light: { model: "faux/summary" },
				},
			};
			const options = {
				harness: opened,
				changeset,
				config,
				lenses: await Lens.builtins(),
				standards: [],
				models: fake.review,
				checks: [],
				decider,
				policy: { kind: "revision" as const, commit: changeset.revision.base },
				origin: {
					kind: "pull-request" as const,
					repository: { owner: "melian-agent", name: "example" },
					pullRequest: 7,
					base: changeset.revision.base,
					head: changeset.revision.head,
				},
			};
			await reviewChangeset(options);
			await summarizeReview({ ...options, harness: opened.harness });
			const telemetry = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
			const row = telemetry.stages.find((stage) => stage.name === (kind === "failover" ? "melian.lens" : kind))!;
			expect(row).toBeDefined();
			expect(row.usage?.requests?.length).toBeGreaterThan(0);
			const requests = row.usage!.requests!;
			const expected = received.filter((item) =>
				kind === "failover" || kind === "melian.lens"
					? ["faux/unavailable", "faux/finder"].includes(item.model)
					: item.model ===
						{
							"melian.verification.candidate": "faux/judge",
							"melian.walkthrough": "faux/summary",
							"melian.triage": "faux/triage",
						}[kind],
			);
			expect(
				requests.map((item) => ({ model: item.model, body: item.reasoning.sent[0], usage: item.usage })),
			).toEqual(expected);
			for (const request of requests) {
				expect(request.reasoning).toMatchObject({
					requested: kind === "melian.triage" ? "unspecified" : "off",
					source: "observed",
					providerReported: `reported-${request.model.split("/")[1]}`,
				});
			}
			if (kind === "failover")
				expect(requests.map((item) => item.model)).toEqual(["faux/unavailable", "faux/finder", "faux/finder"]);
			expect(telemetry.spend()).toContain(
				"faux/finder requested=off effort=finder-effort observed provider-reported=reported-finder",
			);
			expect(telemetry.render()).toContain("faux/judge requested=off effort=judge-effort");
			expect(telemetry.render()).toContain('sent=[{"reasoning":{"effort":"judge-effort"}}]');
			expect(telemetry.slowest()).toContain("effort=summary-effort");
			expect(JSON.parse(JSON.stringify(telemetry)).total.requests).toHaveLength(received.length);
			const count = received.length;
			await reviewChangeset(options);
			expect(received).toHaveLength(count);
			expect((await TelemetryReader.open(storage).read(Revision.key(changeset.revision))).total).toEqual(
				telemetry.total,
			);
		} finally {
			await opened.close();
			rmSync(repo, { recursive: true, force: true });
		}
	},
);

it("sums detached request receipts without changing provider totals", () => {
	const fake = createFakeModels();
	const captured = { requested: "off", source: "observed" as const, sent: [{ reasoning: { effort: "none" } }] };
	const usage = structuredClone(fauxAssistantMessage("Done").usage);
	const total = new TokenUsage();
	total.add("faux/model", usage, captured);
	const snapshot = total.toJSON();
	captured.sent[0]!.reasoning.effort = "changed";
	usage.cost.total = 99;
	const sum = new TokenUsage();
	sum.include(snapshot);
	sum.include(snapshot);
	expect(sum.toJSON().requests).toHaveLength(2);
	expect(sum.toJSON().requests![0]!.reasoning.sent).toEqual([{ reasoning: { effort: "none" } }]);
	expect(sum.toJSON().total.cost.total).toBe(0);
	snapshot.requests![0]!.reasoning.requested = "changed";
	expect(sum.toJSON().requests![0]!.reasoning.requested).toBe("off");
	expect(fake.provider.state.callCount).toBe(0);
});

it("escapes model and provider level controls in summary and spend output", () => {
	const usage = structuredClone(fauxAssistantMessage("Done").usage);
	const total = new TokenUsage();
	total.add("faux/\u001b[31m", usage, {
		requested: "off",
		source: "observed",
		sent: ["provider default"],
		providerReported: "high\nforged",
	});
	const telemetry = new StageTelemetry("base..head", [
		{
			id: "model",
			task: 1,
			name: "melian.lens",
			subject: "lens",
			outcome: "completed",
			timing: "unavailable",
			reused: false,
			resumed: false,
			usage: total.toJSON(),
		},
	]);
	expect(telemetry.slowest()).toContain("provider default observed provider-reported=high\\u000aforged");
	expect(telemetry.spend()).not.toContain("\u001b");
	expect(telemetry.spend()).not.toContain("\n");
	expect(telemetry.render()).toContain("provider default");
});

it.each(["none", "", null, undefined])("labels an unobserved catalogue mapping %s as derived", (mapped) => {
	const fake = createFakeModels();
	const model = { ...fake.provider.getModel(), thinkingLevelMap: { off: mapped } };
	const capture = new ReasoningCapture(model, "off");
	const recorded = capture.finish(fauxAssistantMessage("Done"));
	expect(recorded).toEqual({
		requested: "off",
		source: "derived, not observed",
		sent: [],
		...(mapped === undefined ? {} : { catalogMapped: mapped }),
	});
	const usage = new TokenUsage();
	usage.add("faux/model", fauxAssistantMessage("Done").usage, recorded);
	const telemetry = new StageTelemetry("base..head", [
		{
			id: "test",
			task: 1,
			name: "melian.lens",
			subject: "test",
			timing: "unavailable",
			outcome: "completed",
			reused: false,
			resumed: false,
			usage: usage.toJSON(),
		},
	]);
	expect(telemetry.spend()).toContain(
		`catalogue=${mapped === null ? "provider default" : (mapped ?? "unavailable")} derived, not observed`,
	);
});

it("keeps each observed payload snapshot, even when the provider mutates the body", async () => {
	const fake = createFakeModels();
	const capture = new ReasoningCapture(fake.provider.getModel(), "high");
	const body = { reasoning: { effort: "low" } };
	expect(await capture.options().onPayload!(body, fake.provider.getModel())).toBeUndefined();
	body.reasoning.effort = "high";
	await capture.options().onPayload!(body, fake.provider.getModel());
	const record = capture.finish(fauxAssistantMessage("Done"));
	expect(record.sent).toEqual([{ reasoning: { effort: "low" } }, { reasoning: { effort: "high" } }]);
	expect(record.requested).toBe("high");
	expect(record).not.toHaveProperty("providerReported");
});

it.each([200, 201])("finds the provider session across %s conversations", async (count) => {
	const fake = createFakeModels();
	fake.provider.setResponses([
		async (_request, options, _state, model) => {
			expect(options?.reasoning).toBe("high");
			await options?.onPayload?.({ reasoning: { effort: "low" } }, model);
			return fauxAssistantMessage("Done");
		},
	]);
	const storage = createMemoryStorage();
	const recorder = new ConversationUsageRecorder(storage);
	const harness = await openHarness(storage, { models: recorder.models(fake.models), registry: createRegistry() });
	recorder.attach(harness);
	try {
		for (let i = 1; i < count; i++) await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		expect((await storage.scanConversations({}, 500, undefined, context)).items).toHaveLength(count - 1);
		const target = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: fake.ref(), thinkingLevel: "high" } },
			context,
		);
		await (await target.submit({ type: "input", content: "Ask" }, context)).wait(context);
		const record = await harness.snapshot(ModelUsageDocument, target.id, `conversation:${target.id}`, context);
		expect(record?.requests).toHaveLength(1);
		expect(record?.requests?.[0]?.reasoning).toEqual({
			requested: "high",
			source: "observed",
			sent: [{ reasoning: { effort: "low" } }],
		});
	} finally {
		await harness.close(context);
	}
});

it.each([
	{
		body: { chat_template_kwargs: { enable_thinking: false } },
		sent: { chat_template_kwargs: { enable_thinking: false } },
	},
	{ body: { chat_template_args: { thinking_budget: 5 } }, sent: { chat_template_args: { thinking_budget: 5 } } },
	{ body: { thinking_token_budget: 0 }, sent: { thinking_token_budget: 0 } },
	{ body: { thinking_budget: 1 }, sent: { thinking_budget: 1 } },
	{ body: { thinking_budget_tokens: 2 }, sent: { thinking_budget_tokens: 2 } },
	{ body: { reasoningEffort: "high" }, sent: { reasoningEffort: "high" } },
	{ body: { promptMode: "reasoning" }, sent: { promptMode: "reasoning" } },
	{ body: { prompt_mode: "reasoning" }, sent: { prompt_mode: "reasoning" } },
	{
		body: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
		sent: { "generationConfig.thinkingConfig": { thinkingBudget: 0 } },
	},
	{
		body: { additionalModelRequestFields: { reasoning: { effort: "medium" } } },
		sent: { "additionalModelRequestFields.reasoning": { effort: "medium" } },
	},
	{
		body: { additionalModelRequestFields: { reasoning_effort: "medium" } },
		sent: { "additionalModelRequestFields.reasoning_effort": "medium" },
	},
	{ body: { reasoning_effort: "medium" }, sent: { reasoning_effort: "medium" } },
	{ body: { enable_thinking: false }, sent: { enable_thinking: false } },
	{
		body: { config: { thinkingConfig: { thinkingLevel: "HIGH" }, systemInstruction: "private" } },
		sent: { "config.thinkingConfig": { thinkingLevel: "HIGH" } },
	},
	{
		body: {
			additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 1024 }, unrelated: "private" },
		},
		sent: { "additionalModelRequestFields.thinking": { type: "enabled", budget_tokens: 1024 } },
	},
	{ body: { options: { reasoning: "high", sessionId: "private" } }, sent: { "options.reasoning": "high" } },
	{
		body: { output_config: { effort: "low", format: { schema: "private" } } },
		sent: { "output_config.effort": "low" },
	},
])("observes reasoning paths without retaining unrelated request fields: $sent", async ({ body, sent }) => {
	const fake = createFakeModels();
	const capture = new ReasoningCapture(fake.provider.getModel(), "off");
	await capture.options().onPayload!(body, fake.provider.getModel());
	const recorded = capture.finish(fauxAssistantMessage("Done"));
	expect(recorded.sent).toEqual([sent]);
	expect(JSON.stringify(recorded)).not.toContain("private");
});

it.each(["replace", "mutate"])("observes a prior onPayload callback's %s before returning its result", async (mode) => {
	const fake = createFakeModels();
	const capture = new ReasoningCapture({ ...fake.provider.getModel(), thinkingLevelMap: { off: "none" } }, "off");
	const original = { reasoning: { effort: "none" } };
	const replacement = { reasoning: { effort: "high" } };
	const prior = vi.fn(async (body: unknown, model: unknown) => {
		expect(body).toBe(original);
		expect(model).toBe(fake.provider.getModel());
		if (mode === "replace") return replacement;
		original.reasoning.effort = "high";
		return undefined;
	});
	expect(await capture.options(prior).onPayload!(original, fake.provider.getModel())).toBe(
		mode === "replace" ? replacement : undefined,
	);
	expect(capture.finish(fauxAssistantMessage("Done"))).toEqual({
		requested: "off",
		source: "observed",
		sent: [replacement],
	});
});

it("forwards a caller onPayload replacement through streamSimple", async () => {
	const fake = createFakeModels();
	const original = { reasoning: { effort: "none" } };
	const replacement = { reasoning: { effort: "high" } };
	const received: unknown[] = [];
	fake.provider.setResponses([
		async (_request, options, _state, model) => {
			const replaced = await options!.onPayload!(original, model);
			received.push(replaced ?? original);
			return fauxAssistantMessage("Done");
		},
	]);
	const onPayload = vi.fn(async (body: unknown) => {
		expect(body).toBe(original);
		return replacement;
	});
	const storage = createMemoryStorage();
	const recorder = new ConversationUsageRecorder(storage);
	const models = recorder.models(fake.models);
	const harness = await openHarness(storage, { models, registry: createRegistry() });
	recorder.attach(harness);
	try {
		const root = await harness.root(context);
		const sessionId = (await harness.snapshot(ProviderDoc, root.id, context))!.sessionId;
		await models
			.streamSimple(
				fake.provider.getModel(),
				{ messages: [{ role: "user", content: "Ask", timestamp: 1 }] },
				{ sessionId, onPayload },
			)
			.result();
		expect(received).toEqual([replacement]);
		expect(onPayload).toHaveBeenCalledTimes(1);
		const stored = await harness.snapshot(ModelUsageDocument, root.id, `conversation:${root.id}`, context);
		expect(stored?.requests?.map((request) => request.reasoning)).toEqual([
			{ requested: "off", source: "observed", sent: [replacement] },
		]);
	} finally {
		await harness.close(context);
	}
});

it("forwards a caller onPayload replacement through completeSimple", async () => {
	const fake = createFakeModels();
	const original = { reasoning: { effort: "none" } };
	const replacement = { reasoning: { effort: "high" } };
	const received: unknown[] = [];
	fake.provider.setResponses([
		async (_request, options, _state, model) => {
			const replaced = await options!.onPayload!(original, model);
			received.push(replaced ?? original);
			return fauxAssistantMessage("Done");
		},
	]);
	const onPayload = vi.fn(async (body: unknown) => {
		expect(body).toBe(original);
		return replacement;
	});
	const storage = createMemoryStorage();
	const recorder = new ConversationUsageRecorder(storage);
	const models = recorder.models(fake.models);
	const harness = await openHarness(storage, { models, registry: createRegistry() });
	recorder.attach(harness);
	try {
		const root = await harness.root(context);
		const sessionId = (await harness.snapshot(ProviderDoc, root.id, context))!.sessionId;
		await models.completeSimple(
			fake.provider.getModel(),
			{ messages: [{ role: "user", content: "Ask", timestamp: 1 }] },
			{ sessionId, onPayload },
		);
		expect(received).toEqual([replacement]);
		expect(onPayload).toHaveBeenCalledTimes(1);
		const stored = await harness.snapshot(ModelUsageDocument, root.id, `conversation:${root.id}`, context);
		expect(stored?.requests?.map((request) => request.reasoning)).toEqual([
			{ requested: "off", source: "observed", sent: [replacement] },
		]);
	} finally {
		await harness.close(context);
	}
});

it.each([undefined, "not-a-conversation"])(
	"refuses to assign a receipt without a matching provider session: %s",
	async (sessionId) => {
		const fake = createFakeModels();
		fake.provider.setResponses([fauxAssistantMessage("Done")]);
		const storage = createMemoryStorage();
		const recorder = new ConversationUsageRecorder(storage);
		const models = recorder.models(fake.models);
		const harness = await openHarness(storage, { models, registry: createRegistry() });
		recorder.attach(harness);
		try {
			await harness.root(context);
			const scan = storage.scanConversations.bind(storage);
			vi.spyOn(storage, "scanConversations")
				.mockRejectedValue(new Error("read past terminal page"))
				.mockImplementationOnce((...args) => scan(...args));
			await expect(
				models.completeSimple(
					fake.provider.getModel(),
					{ messages: [{ role: "user", content: "Ask", timestamp: 1 }] },
					sessionId === undefined ? undefined : { sessionId },
				),
			).rejects.toThrow(sessionId === undefined ? "Model request has no provider session" : "No conversation owns");
		} finally {
			await harness.close(context);
		}
	},
);

it("records one receipt when the same stream result is read twice", async () => {
	const fake = createFakeModels();
	fake.provider.setResponses([fauxAssistantMessage("Done")]);
	Object.assign(fake.models, { marker: "retained" });
	const storage = createMemoryStorage();
	const recorder = new ConversationUsageRecorder(storage);
	const models = recorder.models(fake.models);
	const harness = await openHarness(storage, { models, registry: createRegistry() });
	recorder.attach(harness);
	try {
		const root = await harness.root(context);
		const sessionId = (await harness.snapshot(ProviderDoc, root.id, context))!.sessionId;
		const events = models.streamSimple(
			fake.provider.getModel(),
			{ messages: [{ role: "user", content: "Ask", timestamp: 1 }] },
			{ sessionId },
		);
		const first = await events.result();
		expect(await events.result()).toBe(first);
		expect(Reflect.get(events, "done")).toBe(true);
		expect(Reflect.get(models, "marker")).toBe("retained");
		const record = await harness.snapshot(ModelUsageDocument, root.id, `conversation:${root.id}`, context);
		expect(record?.requests).toHaveLength(1);
	} finally {
		await harness.close(context);
	}
});

const reasoningRenderCases: { sent: ReasoningSettings; label: string }[] = [
	{ sent: { reasoning: { effort: 0 } }, label: "effort=0" },
	{ sent: { "output_config.effort": "high" }, label: "effort=high" },
	{ sent: { reasoning_effort: "medium" }, label: "effort=medium" },
	{ sent: { reasoningEffort: "low" }, label: "effort=low" },
	{
		sent: { thinking: { type: "enabled", budget_tokens: 1024 } },
		label: 'sent={"thinking":{"type":"enabled","budget_tokens":1024}}',
	},
	{
		sent: { "config.thinkingConfig": { thinkingBudget: 0 } },
		label: 'sent={"config.thinkingConfig":{"thinkingBudget":0}}',
	},
];
it.each(reasoningRenderCases)("renders the observed setting $label", ({ sent, label }) => {
	const usage = new TokenUsage();
	usage.add("fake/model", fauxAssistantMessage("Done").usage, { requested: "off", source: "observed", sent: [sent] });
	const telemetry = new StageTelemetry("revision", [
		{
			id: "request",
			task: 1,
			name: "melian.lens",
			subject: "test",
			outcome: "completed",
			timing: "unavailable",
			reused: false,
			resumed: false,
			usage: usage.toJSON(),
		},
	]);
	expect(telemetry.models()).toBe(`fake/model requested=off ${label} observed`);
});

it("omits undefined counters from a request's stored usage", () => {
	const usage = new TokenUsage();
	usage.add(
		"fake/model",
		{ ...fauxAssistantMessage("Done").usage, reasoning: undefined, cacheWrite1h: undefined },
		{ requested: "off", source: "observed", sent: ["provider default"] },
	);
	const record = usage.toJSON();
	expect(record.requests![0]!.usage).not.toHaveProperty("reasoning");
	expect(record.requests![0]!.usage).not.toHaveProperty("cacheWrite1h");
});

it("leaves model summaries empty when no request settings were recorded", () => {
	expect(new StageTelemetry("revision", []).models()).toBe("");
	const telemetry = new StageTelemetry("revision", [
		{
			id: "old",
			task: 1,
			name: "melian.lens",
			subject: "old",
			outcome: "completed",
			timing: "unavailable",
			reused: false,
			resumed: false,
			usage: new TokenUsage().toJSON(),
		},
	]);
	expect(telemetry.models()).toBe("");
	expect(telemetry.spend()).toBe("0 tokens, $0");
});

it("accepts absent stream options before refusing a missing provider session", async () => {
	const fake = createFakeModels();
	fake.provider.setResponses([fauxAssistantMessage("Done")]);
	const storage = createMemoryStorage();
	const recorder = new ConversationUsageRecorder(storage);
	const models = recorder.models(fake.models);
	const harness = await openHarness(storage, { models, registry: createRegistry() });
	recorder.attach(harness);
	try {
		const events = models.streamSimple(fake.provider.getModel(), {
			messages: [{ role: "user", content: "Ask", timestamp: 1 }],
		});
		await expect(events.result()).rejects.toThrow("Model request has no provider session");
	} finally {
		await harness.close(context);
	}
});

it("skips a conversation without provider state when assigning a response receipt", async () => {
	const fake = createFakeModels();
	fake.provider.setResponses([fauxAssistantMessage("Done")]);
	const storage = createMemoryStorage();
	const recorder = new ConversationUsageRecorder(storage);
	const models = recorder.models(fake.models);
	const harness = await openHarness(storage, { models, registry: createRegistry() });
	recorder.attach(harness);
	try {
		const root = await harness.root(context);
		const child = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const provider = (await harness.snapshot(ProviderDoc, child.id, context))!;
		const read = vi.spyOn(harness, "snapshot").mockResolvedValueOnce(undefined);
		await models.completeSimple(
			fake.provider.getModel(),
			{ messages: [{ role: "user", content: "Ask", timestamp: 1 }] },
			{ sessionId: provider.sessionId },
		);
		expect(read.mock.calls[0]).toEqual([ProviderDoc, root.id, context]);
		expect(read.mock.calls[1]).toEqual([ProviderDoc, child.id, context]);
		expect(
			(await harness.snapshot(ModelUsageDocument, child.id, `conversation:${child.id}`, context))?.requests,
		).toHaveLength(1);
	} finally {
		await harness.close(context);
	}
});

it("reads older conversation usage without manufacturing reasoning", async () => {
	const repo = crashRepository();
	const fake = createFakeModels();
	fake.provider.setResponses([
		(request) => {
			expect(systemPromptOf(request.messages)).toContain("correctness reviewer");
			return fauxAssistantMessage("Done");
		},
	]);
	const storage = createMemoryStorage();
	const harness = await openHarness(storage, {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const ref = fake.ref();
		await reviewChangeset({
			harness,
			changeset,
			models: fake.review,
			lenses: await Lens.builtins(),
			checks: [],
			standards: [],
			config: {
				...defaultConfig,
				tiers: { full: ["lens.correctness"] },
				models: { heavy: { model: `${ref.provider}/${ref.modelId}` } },
			},
		});
		const telemetry = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		const lens = telemetry.stages.find((stage) => stage.name === "melian.lens")!;
		const conversation = lens.conversation! as ConversationId;
		expect(
			await harness.snapshot(ModelUsageDocument, conversation, `conversation:${conversation}`, context),
		).toBeUndefined();
		expect(lens.usage?.models).toEqual((await harness.snapshot(UsageDoc, conversation, context))!.models);
		expect(lens.usage?.total.totalTokens).toBeGreaterThan(0);
		expect(lens.usage).not.toHaveProperty("requests");
		expect(telemetry.render()).not.toContain("requested=");
	} finally {
		await harness.close(context);
		rmSync(repo, { recursive: true, force: true });
	}
});
it("omits explicitly undefined capture fields before storing strict JSON", () => {
	const usage = new TokenUsage();
	usage.add("fake/model", fauxAssistantMessage("Done").usage, {
		requested: "off",
		source: "observed",
		sent: ["provider default"],
		catalogMapped: undefined,
		providerReported: undefined,
	});
	const record = usage.toJSON().requests![0]!.reasoning;
	expect(record).not.toHaveProperty("catalogMapped");
	expect(record).not.toHaveProperty("providerReported");
});
