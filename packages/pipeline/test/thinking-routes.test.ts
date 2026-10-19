import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, type Decider, defaultConfig, Lens, type MelianConfig } from "@melian-agent/core";
import { FallbackDecider } from "@melian-agent/decisions";
import { expect, it } from "vitest";
import { decisionExtension } from "../src/decisions.ts";
import { revisionKey } from "../src/findings.ts";
import { type ConversationId, backgroundContext as context, createMemoryStorage, openHarness } from "../src/harness.ts";
import { RouteTextModel } from "../src/models.ts";
import { createReviewRegistry, openReviewHarness, reviewChangeset } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { RoundsDocument } from "../src/rounds.ts";
import { summarizeReview } from "../src/summarize.ts";
import { TelemetryReader } from "../src/telemetry.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptVerifier,
	systemPromptOf,
} from "../src/testing.ts";
import { TokenUsage } from "../src/token-usage.ts";
import { crashFinding, crashRepository } from "./fixtures/review-scenario.ts";

const fixture = new URL("./fixtures/thinking-main/", import.meta.url);

it.each([false, true])("sends every path's tier thinking to the provider (configured=%s)", async (configured) => {
	const repo = crashRepository();
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-thinking-")));
	const fake = createFakeModels({
		models: ["finder", "unavailable", "judge-unavailable", "judge", "summary", "triage"].map((id) => ({ id })),
	});
	let compactions = 0;
	const received: { model: string; body: object }[] = [];
	fake.provider.setResponses(
		Array.from({ length: 40 }, () => async (request, options, _state, model) => {
			const body = options?.reasoning === undefined ? {} : { reasoning: { effort: options.reasoning } };
			received.push({ model: model.id, body });
			await options?.onPayload?.(body, model);
			const prompt = systemPromptOf(request.messages);
			if (options?.cacheRetention === "none") {
				compactions++;
				return fauxAssistantMessage("Compacted review.");
			}
			if (model.id === "triage") {
				expect(prompt).toContain("You answer typed questions");
				return fauxAssistantMessage(
					fauxToolCall("answer", {
						answers: [{ question: "correctness", probabilities: [{ option: "careful", probability: 1 }] }],
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (model.id.endsWith("unavailable"))
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit exceeded" });
			if (model.id === "finder") {
				expect(prompt).toContain("correctness reviewer");
				return request.messages.some((message) => message.role === "toolResult")
					? fauxAssistantMessage("Done.")
					: fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" });
			}
			if (model.id === "judge") return scriptVerifier(request.messages);
			expect(model.id).toBe("summary");
			expect(prompt).toContain("You write Melian's walkthrough");
			return fauxAssistantMessage(
				fauxToolCall("record_walkthrough", {
					summary: "Changes manager lookup.",
					files: [{ path: "src/user.ts", summary: "Removes the optional chain." }],
				}),
				{ stopReason: "toolUse" },
			);
		}),
	);
	const thinking = configured ? ("medium" as const) : undefined;
	const text = (await RouteTextModel.create(fake.review, [fake.ref("triage")], thinking))!;
	const decider = new FallbackDecider(text);
	const storage = createMemoryStorage();
	const opened = await openReviewHarness(storage, fake.review, { decider, retry: false });
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const config: MelianConfig = {
			...defaultConfig,
			tiers: { full: ["lens.correctness"] },
			models: {
				heavy: {
					model: "faux/unavailable",
					fallbacks: ["faux/finder"],
					...(configured ? { thinking: "high" as const } : {}),
				},
				verifier: {
					model: "faux/judge-unavailable",
					fallbacks: ["faux/judge"],
					...(configured ? { thinking: "low" as const } : {}),
				},
				light: { model: "faux/summary", ...(configured ? { thinking: "minimal" as const } : {}) },
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
		const beforeCompaction = [...received];
		const telemetry = await TelemetryReader.open(storage).read(revisionKey(changeset.revision));
		const conversation = telemetry.stages.find((stage) => stage.name === "melian.lens")!.conversation!;
		const child = (await opened.harness.conversation(conversation as ConversationId, context))!;
		await (
			await child.submit(
				{ type: "input", content: `Additional context ${"x".repeat(100_000)}`, requestId: "compaction-test" },
				context,
			)
		).wait(context);
		await opened.harness.waitForTask(await child.compact(undefined, context), context);
		expect(compactions).toBe(1);
		expect(received.at(-1)).toEqual({ model: "finder", body: configured ? { reasoning: { effort: "high" } } : {} });
		expect(new Set(beforeCompaction.map(({ model }) => model))).toEqual(
			new Set(["triage", "unavailable", "finder", "judge-unavailable", "judge", "summary"]),
		);
		if (!configured)
			expect(beforeCompaction).toEqual(JSON.parse(readFileSync(new URL("bodies.json", fixture), "utf8")));
		else {
			const levels: Record<string, string> = {
				triage: "medium",
				unavailable: "high",
				finder: "high",
				"judge-unavailable": "low",
				judge: "low",
				summary: "minimal",
			};
			expect(beforeCompaction).toEqual(
				beforeCompaction.map(({ model }) => ({ model, body: { reasoning: { effort: levels[model] } } })),
			);
			for (const stage of telemetry.stages)
				for (const request of stage.usage?.requests ?? [])
					expect(request.reasoning.requested).toBe(levels[request.model.split("/")[1]!]);
		}
		const count = received.length;
		await reviewChangeset(options);
		expect(received).toHaveLength(count);
	} finally {
		await opened.close();
		rmSync(repo, { recursive: true, force: true });
		rmSync(directory, { recursive: true, force: true });
	}
});

it("changes the lens attachment when only thinking changes", async () => {
	const repo = crashRepository();
	const fake = createFakeModels();
	const levels: unknown[] = [];
	fake.provider.setResponses(
		Array.from({ length: 4 }, () => (_request, options) => {
			levels.push(options?.reasoning);
			return fauxAssistantMessage("Done.");
		}),
	);
	const opened = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false });
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const common = {
			harness: opened,
			changeset,
			lenses: await Lens.builtins(),
			standards: [],
			models: fake.review,
			checks: [],
		};
		const run = (thinking: "high" | "low" | "off" | undefined) =>
			reviewChangeset({
				...common,
				config: {
					...defaultConfig,
					tiers: { full: ["lens.correctness"] },
					models: { heavy: { model: "faux/faux-1", ...(thinking === undefined ? {} : { thinking }) } },
				},
			});
		const root = await opened.harness.root(context);
		const task = async () =>
			(await opened.harness.snapshot(ReviewIndex, root.id, context))!.reviews[revisionKey(changeset.revision)]!.task;
		await run(undefined);
		const unset = await task();
		await run("high");
		const high = await task();
		expect(high).not.toBe(unset);
		await run("high");
		expect(await task()).toBe(high);
		await run("low");
		expect(await task()).not.toBe(high);
		await run("off");
		expect(await task()).not.toBe(high);
		expect(levels).toEqual([undefined, "high", "low", undefined]);
	} finally {
		await opened.close();
		rmSync(repo, { recursive: true, force: true });
	}
});

it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
	"sets direct triage thinking=%s and gives it a distinct identity",
	async (thinking) => {
		const fake = createFakeModels();
		const bodies: unknown[] = [];
		fake.provider.setResponses([
			(_request, options) => {
				const body = options?.reasoning === undefined ? {} : { reasoning: { effort: options.reasoning } };
				bodies.push(body);
				return fauxAssistantMessage(fauxToolCall("answer", { ok: true }), { stopReason: "toolUse" });
			},
		]);
		const model = (await RouteTextModel.create(fake.review, [fake.ref()], thinking))!;
		const unset = (await RouteTextModel.create(fake.review, [fake.ref()]))!;
		expect(model.name).not.toBe(unset.name);
		const observe = new TokenUsage();
		await model.answer(
			{
				system: "Triage",
				prompt: "Choose",
				tool: { name: "answer", description: "Answer", parameters: { type: "object" } },
			},
			undefined,
			(name, usage, reasoning) => observe.add(name, usage, reasoning),
		);
		expect(bodies).toEqual([thinking === "off" ? {} : { reasoning: { effort: thinking } }]);
		expect(observe.toJSON().requests![0]!.reasoning.requested).toBe(thinking);
	},
);

it("changes verifier identity without rerunning its cached finder", async () => {
	const repo = crashRepository();
	const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
	const received: { model: string; thinking: unknown }[] = [];
	fake.provider.setResponses(
		Array.from({ length: 12 }, () => (request, options, _state, model) => {
			received.push({ model: model.id, thinking: options?.reasoning });
			if (model.id === "judge") return scriptVerifier(request.messages);
			expect(model.id).toBe("finder");
			return request.messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage("Done.")
				: fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" });
		}),
	);
	const opened = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false });
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const common = {
			harness: opened,
			changeset,
			lenses: await Lens.builtins(),
			standards: [],
			models: fake.review,
			checks: [],
		};
		const run = (thinking: "high" | "low") =>
			reviewChangeset({
				...common,
				config: {
					...defaultConfig,
					tiers: { full: ["lens.correctness"] },
					models: { heavy: { model: "faux/finder" }, verifier: { model: "faux/judge", thinking } },
				},
			});
		const root = await opened.harness.root(context);
		const task = async () =>
			(await opened.harness.snapshot(ReviewIndex, root.id, context))!.reviews[revisionKey(changeset.revision)]!
				.verification!.task;
		await run("high");
		const high = await task();
		const firstRound = structuredClone((await opened.harness.snapshot(RoundsDocument, root.id, context))!);
		expect(firstRound.sequence).toBe(1);
		await run("high");
		expect(await task()).toBe(high);
		expect(await opened.harness.snapshot(RoundsDocument, root.id, context)).toEqual(firstRound);
		await run("low");
		expect(await task()).not.toBe(high);
		const nextRound = (await opened.harness.snapshot(RoundsDocument, root.id, context))!;
		expect(nextRound.sequence).toBe(2);
		expect(nextRound.current[revisionKey(changeset.revision)]).toBe("r2");
		expect(nextRound.items.r1).toEqual(firstRound.items.r1);
		expect(received.filter(({ model }) => model === "finder")).toHaveLength(2);
		expect(received.filter(({ model }) => model === "judge").map(({ thinking }) => thinking)).toEqual([
			"high",
			"high",
			"low",
			"low",
		]);
	} finally {
		await opened.close();
		rmSync(repo, { recursive: true, force: true });
	}
});

it("does not attach a triage decision made at another thinking level", async () => {
	const repo = crashRepository();
	const fake = createFakeModels();
	const triage: unknown[] = [];
	fake.provider.setResponses(
		Array.from({ length: 5 }, () => (request, options) => {
			if (!systemPromptOf(request.messages).includes("You answer typed questions"))
				return fauxAssistantMessage("Done.");
			triage.push(options?.reasoning);
			return fauxAssistantMessage(
				fauxToolCall("answer", {
					answers: [{ question: "correctness", probabilities: [{ option: "careful", probability: 1 }] }],
				}),
				{ stopReason: "toolUse" },
			);
		}),
	);
	const registry = createReviewRegistry();
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		settings: { retry: { enabled: false } },
	});
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const root = await harness.root(context);
		const roundTasks: number[][] = [];
		for (const thinking of ["high", "high", "low", "low"] as const) {
			const decider = new FallbackDecider((await RouteTextModel.create(fake.review, [fake.ref()], thinking))!);
			registry.install(decisionExtension(decider));
			await reviewChangeset({
				harness,
				changeset,
				decider,
				lenses: await Lens.builtins(),
				standards: [],
				models: fake.review,
				checks: [],
				config: {
					...defaultConfig,
					tiers: { full: ["lens.correctness"] },
					models: { heavy: { model: "faux/faux-1" } },
				},
			});
			const state = (await harness.snapshot(RoundsDocument, root.id, context))!;
			expect(state.sequence).toBe(thinking === "high" ? 1 : 2);
			expect(state.current[revisionKey(changeset.revision)]).toBe(thinking === "high" ? "r1" : "r2");
			roundTasks.push([...state.items[state.current[revisionKey(changeset.revision)]!]!.tasks]);
		}
		expect(roundTasks[0]).toHaveLength(1);
		expect(roundTasks[1]).toEqual(roundTasks[0]);
		expect(roundTasks[2]).toHaveLength(1);
		expect(roundTasks[2]).not.toEqual(roundTasks[0]);
		expect(roundTasks[3]).toEqual(roundTasks[2]);
		expect(triage).toEqual(["high", "low"]);
	} finally {
		await harness.close(context);
		rmSync(repo, { recursive: true, force: true });
	}
});

it.each(["fallback", "accept"])(
	"runs a verifier %s at verifier thinking rather than finder thinking",
	async (route) => {
		const repo = crashRepository();
		const fake = createFakeModels({ models: [{ id: "faux-1" }, { id: "judge" }] });
		const models: string[] = [];
		const levels: unknown[] = [];
		fake.provider.setResponses(
			Array.from({ length: 6 }, () => (request, options, _state, model) => {
				models.push(model.id);
				levels.push(options?.reasoning);
				if (systemPromptOf(request.messages).includes("Melian adversarial verifier"))
					return scriptVerifier(request.messages);
				return request.messages.some((message) => message.role === "toolResult")
					? fauxAssistantMessage("Done.")
					: fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" });
			}),
		);
		const opened = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false });
		try {
			await reviewChangeset({
				harness: opened,
				changeset: await Changeset.resolve(repo, "main...feature"),
				lenses: await Lens.builtins(),
				standards: [],
				models: fake.review,
				checks: [],
				config: {
					...defaultConfig,
					tiers: { full: ["lens.correctness"] },
					models: {
						heavy: { model: "faux/faux-1", thinking: "high" },
						verifier: { thinking: "low", ...(route === "accept" ? { accept: ["faux/judge"] } : {}) },
					},
				},
			});
			expect(levels).toEqual(["high", "high", "low", "low"]);
			expect(models).toEqual([
				"faux-1",
				"faux-1",
				...(route === "accept" ? ["judge", "judge"] : ["faux-1", "faux-1"]),
			]);
		} finally {
			await opened.close();
			rmSync(repo, { recursive: true, force: true });
		}
	},
);

it("includes the escalation tier's thinking in lens attachment", async () => {
	const repo = crashRepository();
	const fake = createFakeModels({ models: [{ id: "quick" }, { id: "careful" }] });
	const received: unknown[] = [];
	fake.provider.setResponses(
		Array.from({ length: 10 }, () => (request, options, _state, model) => {
			received.push(options?.reasoning);
			if (systemPromptOf(request.messages).includes("Melian adversarial verifier"))
				return scriptVerifier(request.messages);
			return model.id === "quick" && !request.messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" })
				: fauxAssistantMessage("Done.");
		}),
	);
	const decider: Decider = {
		name: "quick",
		calibrated: true,
		decide: async () => ({ answers: [{ question: "correctness", distribution: { quick: 1 } }] }),
	};
	const opened = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false, decider });
	try {
		const template = (await Lens.builtins()).find((lens) => lens.name === "correctness")!;
		const lens = Lens.from({
			...template.toJSON(),
			levels: {
				quick: { ...template.levels.careful, tier: "medium", verify: false },
				careful: { ...template.levels.careful, verify: false },
			},
		});
		const changeset = await Changeset.resolve(repo, "main...feature");
		const run = (thinking: "high" | "low") =>
			reviewChangeset({
				harness: opened,
				changeset,
				decider,
				lenses: [lens],
				standards: [],
				models: fake.review,
				checks: [],
				config: {
					...defaultConfig,
					tiers: { full: ["lens.correctness"] },
					models: {
						verifier: { model: "faux/careful", thinking: "medium" },
						medium: { model: "faux/quick", thinking: "minimal" },
						heavy: { model: "faux/careful", thinking },
					},
				},
			});
		const root = await opened.harness.root(context);
		await run("high");
		const high = (await opened.harness.snapshot(ReviewIndex, root.id, context))!.reviews[
			revisionKey(changeset.revision)
		]!.task;
		await run("low");
		expect(
			(await opened.harness.snapshot(ReviewIndex, root.id, context))!.reviews[revisionKey(changeset.revision)]!.task,
		).not.toBe(high);
		expect(received).toEqual([
			"minimal",
			"minimal",
			"high",
			"medium",
			"medium",
			"minimal",
			"minimal",
			"low",
			"medium",
			"medium",
		]);
	} finally {
		await opened.close();
		rmSync(repo, { recursive: true, force: true });
	}
});

it("keeps an empty legacy verifier route invalid when thinking is unset", async () => {
	const repo = crashRepository();
	const fake = createFakeModels();
	fake.provider.setResponses([
		fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done."),
	]);
	const opened = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false });
	try {
		await expect(
			reviewChangeset({
				harness: opened,
				changeset: await Changeset.resolve(repo, "main...feature"),
				lenses: await Lens.builtins(),
				standards: [],
				models: fake.review,
				checks: [],
				config: {
					...defaultConfig,
					tiers: { full: ["lens.correctness"] },
					models: { heavy: { model: "faux/faux-1" }, verifier: {} },
				},
			}),
		).rejects.toMatchObject({ code: "noModelForTier" });
		expect(fake.provider.state.callCount).toBe(2);
	} finally {
		await opened.close();
		rmSync(repo, { recursive: true, force: true });
	}
});
