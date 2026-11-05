import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Decider, UsageObserver } from "@melian-agent/core";
import { FallbackDecider } from "@melian-agent/decisions";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	openHarness,
	openSqliteStorage,
	RouteTextModel,
	StageTelemetry,
	type Storage,
	TelemetryReader,
	TokenUsage,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
} from "@melian-agent/pipeline/testing";
import { expect, it, vi } from "vitest";
import { DecisionDocument, decisionExtension, decisionTask } from "../src/decisions.ts";
import { ModelAttemptsDocument } from "../src/token-usage.ts";

const revision = "base..head";
const usage = {
	input: 11,
	output: 7,
	cacheRead: 13,
	cacheWrite: 5,
	cacheWrite1h: 2,
	reasoning: 3,
	totalTokens: 36,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
};

const unobserved = { requested: "unspecified", source: "derived, not observed" as const, sent: [] };

async function decide(
	storage: Storage,
	stop: "toolUse" | "error" | "aborted" | "prose" | "invalid" | "throw" = "toolUse",
	identity?: { provider: string; model: string },
) {
	const commits = vi.spyOn(storage, "commit");
	const fake = createFakeModels({ models: [{ id: "triage" }] });
	const model = await RouteTextModel.create(fake.review, [fake.ref("triage")]);
	const decider = new FallbackDecider(model!);
	const registry = createRegistry();
	registry.install(decisionExtension(decider));
	const calls = scriptConversations(fake, [
		{
			match: "You answer typed questions",
			replies: [
				(messages) => {
					const prompt = messages
						.filter((message) => message.role === "user")
						.map(textOf)
						.join("\n");
					expect([...prompt.matchAll(/^### (.+)$/gm)].map((match) => match[1])).toEqual(["lens"]);
					return {
						...fauxAssistantMessage(
							stop === "prose"
								? "No tool"
								: fauxToolCall(
										"answer",
										stop === "invalid"
											? {}
											: {
													answers: [
														{ question: "lens", probabilities: [{ option: "careful", probability: 1 }] },
													],
												},
									),
							{
								stopReason: stop === "prose" || stop === "invalid" || stop === "throw" ? "stop" : stop,
								errorMessage: "test failure",
							},
						),
						usage,
					};
				},
			],
		},
	]);
	const complete = fake.models.complete.bind(fake.models);
	vi.spyOn(fake.models, "complete").mockImplementation(async (...args) => {
		const root = await harness.root(context);
		const entry = (await harness.snapshot(DecisionDocument, root.id, context))!.decisions[revision]!.triage!;
		expect(await harness.snapshot(ModelAttemptsDocument, root.id, String(entry.task), context)).toEqual({
			started: 1,
			unmeasured: 0,
		});
		if (stop === "throw") throw new Error("no assistant response");
		return { ...(await complete(...args)), usage, ...identity };
	});
	const harness = await openHarness(storage, {
		models: fake.models,
		registry,
		settings: { retry: { enabled: false } },
	});
	const root = await harness.root(context);
	const request = {
		questionSet: { name: "triage", version: "1" },
		state: "change",
		questions: [{ id: "lens", text: "level?", options: ["careful"] }],
	};
	const id = await root.commit(async (tx) => {
		const id = await tx.createTask(
			decisionTask(decider),
			{
				root: root.id,
				revision,
				key: JSON.stringify({ decider: decider.name }),
				request,
			},
			{ ownership: { kind: "conversation" } },
		);
		(await tx.doc(DecisionDocument, root.id)).decisions[revision] = { triage: { task: id, key: "test" } };
		return id;
	}, context);
	await harness.waitForTask(id, context);
	return { commits, storage, harness, calls, id, model: model!.name };
}

it.each(["toolUse", "error", "aborted", "prose", "invalid"] as const)(
	"keeps triage usage when the model returns %s, including rejected answers",
	async (stop) => {
		const storage = createMemoryStorage();
		const { harness, model, calls } = await decide(storage, stop);
		try {
			const telemetry = await TelemetryReader.open(storage).read(revision);
			expect(telemetry.stages[0]!.usage).toEqual({
				models: { [model]: usage },
				total: usage,
				requests: [{ model, usage, reasoning: unobserved }],
			});
			expect(telemetry.toJSON()).toMatchObject({
				total: { models: { [model]: usage }, total: usage },
				usageUnavailable: [],
			});
			expect(calls["You answer typed questions"]).toHaveLength(1);
			expect(telemetry.slowest()).toContain("Slowest stages:");
			expect(telemetry.slowest()).toContain("36 tokens, $0.1");
			expect(telemetry.spend()).toBe(
				`36 tokens, $0.1; ${model} requested=unspecified catalogue=unavailable derived, not observed`,
			);
			expect(telemetry.render()).toContain("input=11 output=7 cache-read=13 cache-write=5 reasoning=3");
		} finally {
			await harness.close(context);
		}
	},
);

it("reopens a settled decision without another model call or usage write", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-token-telemetry-")));
	try {
		const database = join(dir, "state.sqlite");
		const initial = await decide(await openSqliteStorage(database));
		const expected = (await TelemetryReader.open(initial.storage).read(revision)).toJSON();
		await initial.harness.waitForTask(initial.id, context);
		await initial.harness.close(context);
		const storage = await openSqliteStorage(database);
		try {
			const write = vi.spyOn(storage, "commit");
			expect((await TelemetryReader.open(storage).read(revision)).toJSON()).toEqual(expected);
			expect((expected as unknown as { total: unknown }).total).toEqual({
				models: { [initial.model]: usage },
				total: usage,
				requests: [{ model: initial.model, usage, reasoning: unobserved }],
			});
			expect(write).not.toHaveBeenCalled();
			expect(initial.calls["You answer typed questions"]).toHaveLength(1);
		} finally {
			await storage.close(context);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([
	{ lost: 0, incomplete: undefined },
	{ lost: 1, incomplete: 1 },
])(
	"counts two response receipts in one decision with $lost lost requests after reopen",
	async ({ lost, incomplete }) => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-token-receipts-")));
		try {
			const request = {
				questionSet: { name: "triage", version: "1" },
				state: "change",
				questions: [{ id: "lens", text: "level?", options: ["careful"] }],
			};
			const decider: Decider = {
				name: "two-responses",
				calibrated: false,
				decide: vi.fn<Decider["decide"]>(async (asked, _signal, observe) => {
					expect(asked).toEqual(request);
					await observe!.started!();
					observe!("faux/triage", usage);
					await observe!.started!();
					observe!("faux/triage", usage);
					for (let index = 0; index < lost; index++) await observe!.started!();
					return { answers: [{ question: "lens", distribution: { careful: 1 } }] };
				}),
			};
			const registry = createRegistry();
			registry.install(decisionExtension(decider));
			const database = join(dir, "state.sqlite");
			const storage = await openSqliteStorage(database);
			const fake = createFakeModels();
			const harness = await openHarness(storage, {
				models: fake.models,
				registry,
				settings: { retry: { enabled: false } },
			});
			let settled: ReturnType<StageTelemetry["toJSON"]>;
			try {
				const root = await harness.root(context);
				const id = await root.commit(async (tx) => {
					const id = await tx.createTask(
						decisionTask(decider),
						{ root: root.id, revision, key: JSON.stringify({ decider: decider.name }), request },
						{ ownership: { kind: "conversation" } },
					);
					(await tx.doc(DecisionDocument, root.id)).decisions[revision] = { triage: { task: id, key: "test" } };
					return id;
				}, context);
				await harness.waitForTask(id, context);
				expect(decider.decide).toHaveBeenCalledOnce();
				expect(
					(await harness.snapshot(DecisionDocument, root.id, context))!.decisions[revision]!.triage,
				).toMatchObject({
					decision: { answers: [{ question: "lens", distribution: { careful: 1 }, chosen: "careful" }] },
				});
				expect(await harness.snapshot(ModelAttemptsDocument, root.id, String(id), context)).toEqual({
					started: 2 + lost,
					unmeasured: lost,
				});
				settled = (await TelemetryReader.open(storage).read(revision)).toJSON();
			} finally {
				await harness.close(context);
			}
			const reopened = await openSqliteStorage(database);
			try {
				const telemetry = await TelemetryReader.open(reopened).read(revision);
				expect(telemetry.toJSON()).toEqual(settled);
				const total = {
					input: 22,
					output: 14,
					cacheRead: 26,
					cacheWrite: 10,
					cacheWrite1h: 4,
					reasoning: 6,
					totalTokens: 72,
					cost: { input: 0.02, output: 0.04, cacheRead: 0.06, cacheWrite: 0.08, total: 0.2 },
				};
				expect(settled.stages).toHaveLength(1);
				expect(settled.stages[0]!.usage).toEqual({ models: { "faux/triage": total }, total });
				expect(settled.total).toEqual(settled.stages[0]!.usage);
				expect(settled.usageUnavailable).toEqual([]);
				expect(settled.stages[0]!.usageIncomplete).toBe(incomplete);
				expect(settled.usageIncomplete).toBe(incomplete);
				expect(telemetry.spend()).toBe(
					["72 tokens, $0.2", "72 tokens, $0.2 (usage incomplete: 1 request(s) not measured)"][lost],
				);
			} finally {
				await reopened.close(context);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("does not report zero usage when an older model stage has no usage record", () => {
	const telemetry = new StageTelemetry(revision, [
		{
			id: "task:1",
			name: "melian.triage",
			subject: "triage",
			task: 1,
			outcome: "completed",
			timing: "unavailable",
			reused: false,
			resumed: false,
		},
	]);
	expect(telemetry.toJSON()).toMatchObject({ usageUnavailable: ["task:1"] });
	expect(telemetry.toJSON()).not.toHaveProperty("total");
	expect(telemetry.slowest()).toBe("melian: Stage timings unavailable. Total: Token usage unavailable.\n");
});

it.each(["before", "after"])(
	"marks lost triage usage after a crash %s its terminal commit",
	async (mode) => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-token-crash-")));
		const children: ReturnType<typeof spawn>[] = [];
		const database = join(dir, "state.sqlite");
		const log = join(dir, "calls");
		const ready = join(dir, "ready");
		const output = join(dir, "output.json");
		const start = (phase: string) => {
			const child = spawn(
				process.execPath,
				[
					"--conditions=@melian-agent/source",
					fileURLToPath(new URL("./fixtures/token-telemetry-crash.ts", import.meta.url)),
					database,
					log,
					phase,
					ready,
					output,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			children.push(child);
			return child;
		};
		try {
			const first = start(mode);
			const deadline = Date.now() + 10_000;
			while (!existsSync(ready)) {
				if (Date.now() > deadline || first.exitCode !== null)
					throw new Error("crash fixture did not reach the terminal commit");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const closed = new Promise((resolve) => first.once("close", resolve));
			first.kill("SIGKILL");
			await closed;
			const second = start("resume");
			let diagnostics = "";
			second.stderr!.on("data", (chunk) => {
				diagnostics += String(chunk);
			});
			const code = await new Promise((resolve) => second.once("close", resolve));
			expect(code, diagnostics).toBe(0);
			const stored = JSON.parse(readFileSync(output, "utf8")) as ReturnType<StageTelemetry["toJSON"]>;
			expect(stored.stages[0]!.usage!.models["faux/triage"]!.totalTokens).toBeGreaterThan(0);
			expect(stored.total).toEqual(stored.stages[0]!.usage);
			const telemetry = new StageTelemetry(revision, stored.stages);
			if (mode === "before") {
				expect(stored.stages[0]!.usageIncomplete).toBe(1);
				expect(stored.usageIncomplete).toBe(1);
				expect(telemetry.spend()).toContain("usage incomplete: 1 request(s) not measured");
				expect(telemetry.slowest()).toContain("usage incomplete: 1 request(s) not measured");
				expect(telemetry.render().split("\n")[1]).toContain("usage incomplete: 1 request(s) not measured");
			} else {
				expect(stored.stages[0]!.usageIncomplete).toBeUndefined();
				expect(stored.usageIncomplete).toBeUndefined();
				expect(telemetry.spend()).not.toContain("incomplete");
			}
			expect(Object.keys(stored.total!.models)).toEqual(["faux/triage"]);
			expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(mode === "before" ? 2 : 1);
		} finally {
			for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	},
	30_000,
);

it("commits the decision and reported usage in the same storage transaction", async () => {
	const storage = createMemoryStorage();
	const { commits, harness, id } = await decide(storage);
	try {
		const usageCommit = commits.mock.calls.find(([writes]) =>
			writes.some((write) => write.type === "document.create" && write.record.kind === "melian.model-usage"),
		)![0];
		const decision = await storage.findDocument(
			{
				kind: "melian.decisions",
				scope: { kind: "conversation", conversationId: (await harness.root(context)).id },
			},
			"current",
			context,
		);
		expect(usageCommit).toContainEqual(expect.objectContaining({ type: "document.change", id: decision!.id }));
		expect(usageCommit).toContainEqual(
			expect.objectContaining({
				type: "task",
				value: expect.objectContaining({
					id,
					state: expect.objectContaining({ outcome: { status: "completed", result: "recorded" } }),
				}),
			}),
		);
	} finally {
		await harness.close(context);
	}
});

it("omits provider-undefined optional counters before putting usage in strict JSON", () => {
	const total = new TokenUsage({ model: { ...usage, reasoning: undefined, cacheWrite1h: undefined } });
	expect(total.toJSON().models.model).not.toHaveProperty("reasoning");
	expect(total.toJSON().models.model).not.toHaveProperty("cacheWrite1h");
	expect(total.toJSON().total).not.toHaveProperty("reasoning");
});

it("keeps optional zero counters, model keys and collector snapshots independent", () => {
	const recorded = { ...usage, reasoning: 0, cacheWrite1h: 0 };
	const total = new TokenUsage(JSON.parse(JSON.stringify({ ["__proto__"]: recorded, constructor: usage })));
	total.add("__proto__", { ...usage, reasoning: undefined, cacheWrite1h: undefined });
	const snapshot = total.toJSON();
	const key = "__proto__";
	expect(Object.keys(snapshot.models)).toEqual(["__proto__", "constructor"]);
	expect(snapshot.models[key]).toMatchObject({ input: 22, reasoning: 0, cacheWrite1h: 0, cost: { total: 0.2 } });
	snapshot.models[key]!.input = 999;
	recorded.input = 999;
	expect(total.toJSON().models[key]!.input).toBe(22);
	expect(total.toJSON().total).toMatchObject({
		input: 33,
		output: 21,
		cacheRead: 39,
		cacheWrite: 15,
		totalTokens: 108,
		reasoning: 3,
		cacheWrite1h: 2,
	});
});

it("shows a subtotal when one model stage has no usage and excludes non-model stages from missing coverage", () => {
	const base = {
		task: 1,
		subject: "test",
		outcome: "completed",
		timing: "unavailable" as const,
		reused: false,
		resumed: false,
	};
	const total = new StageTelemetry(revision, [
		{ ...base, id: "lens", name: "melian.lens", usage: new TokenUsage({ "model\u001b[2J": usage }).toJSON() },
		{ ...base, id: "old", name: "melian.triage" },
		{ ...base, id: "check", name: "melian.check" },
	]);
	expect(total.usageUnavailable).toEqual(["old"]);
	expect(total.spend()).toBe("36 tokens, $0.1 (usage unavailable for 1 stage)");
	const twoMissing = new StageTelemetry(revision, [
		...total.stages,
		{ ...base, id: "older", name: "melian.walkthrough" },
	]);
	expect(twoMissing.spend()).toBe("36 tokens, $0.1 (usage unavailable for 2 stages)");
	expect(total.render()).not.toContain("\u001b");
	expect(total.render()).toContain("model\\u001b[2J");
});

it("leaves a failed request without an assistant usage record unavailable", async () => {
	const storage = createMemoryStorage();
	const { harness } = await decide(storage, "throw");
	try {
		const telemetry = await TelemetryReader.open(storage).read(revision);
		expect(telemetry.stages[0]!.usage).toBeUndefined();
		expect(telemetry.total).toBeUndefined();
		expect(telemetry.usageUnavailable).toEqual([telemetry.stages[0]!.id]);
		expect(telemetry.stages[0]!.usageIncomplete).toBe(1);
		expect(telemetry.spend()).toBe("Token usage unavailable (usage incomplete: 1 request(s) not measured)");
	} finally {
		await harness.close(context);
	}
});

it("keeps Pi's totals and optional zeroes without deriving totals or printing absent counters", () => {
	const reported = { ...usage, totalTokens: 97, cost: { ...usage.cost, total: 99 }, reasoning: 0, cacheWrite1h: 0 };
	const summary = new TokenUsage({ model: reported }).toJSON();
	expect(summary.total.totalTokens).toBe(97);
	expect(summary.total.cost.total).toBe(99);
	const stage = {
		id: "lens",
		task: 1,
		name: "melian.lens",
		subject: "test",
		outcome: "completed",
		timing: "unavailable" as const,
		reused: false,
		resumed: false,
	};
	expect(new StageTelemetry(revision, [{ ...stage, usage: summary }]).render()).toContain(
		"reasoning=0 cache-write-1h=0",
	);
	const { reasoning: _, cacheWrite1h: __, ...absent } = reported;
	const rendered = new StageTelemetry(revision, [
		{ ...stage, usage: new TokenUsage({ model: absent }).toJSON() },
	]).render();
	expect(rendered).not.toContain("reasoning=");
	expect(rendered).not.toContain("cache-write-1h=");
	expect(rendered).toContain("97 tokens, $99");
});

it.each(["melian.triage", "melian.lens", "melian.verification.candidate", "melian.walkthrough"])(
	"marks missing usage for %s without inventing a total",
	(name) => {
		const telemetry = new StageTelemetry(revision, [
			{
				id: "old",
				task: 1,
				name,
				subject: "test",
				outcome: "completed",
				timing: "unavailable",
				reused: false,
				resumed: false,
			},
		]);
		expect(telemetry.usageUnavailable).toEqual(["old"]);
		expect(telemetry.total).toBeUndefined();
	},
);

it("uses the response's actual provider and model rather than the configured route label", async () => {
	const storage = createMemoryStorage();
	const { harness } = await decide(storage, "toolUse", { provider: "actual-provider", model: "actual-model" });
	try {
		expect((await TelemetryReader.open(storage).read(revision)).stages[0]!.usage).toEqual({
			models: { "actual-provider/actual-model": usage },
			total: usage,
			requests: [{ model: "actual-provider/actual-model", usage, reasoning: unobserved }],
		});
	} finally {
		await harness.close(context);
	}
});

it.each(["absent", "response-only"] as const)("lets a TextModel caller use an %s observer", async (observer) => {
	const fake = createFakeModels();
	scriptConversations(fake, [
		{
			match: "optional usage",
			replies: [fauxAssistantMessage(fauxToolCall("answer", { value: 1 }), { stopReason: "toolUse" })],
		},
	]);
	const model = (await RouteTextModel.create(fake.review, [fake.ref()]))!;
	await expect(
		model.answer(
			{
				system: "optional usage",
				prompt: "Return value 1",
				tool: {
					name: "answer",
					description: "Answer",
					parameters: { type: "object", properties: { value: { type: "number" } } },
				},
			},
			undefined,
			observer === "absent" ? undefined : vi.fn<UsageObserver>(),
		),
	).resolves.toEqual({ value: 1 });
});

it("carries every unmeasured request into the run total, even without any usage receipts", () => {
	const stage = {
		id: "task:1",
		name: "melian.triage",
		subject: "triage",
		task: 1,
		outcome: "completed",
		timing: "unavailable" as const,
		reused: false,
		resumed: false,
	};
	const complete = new StageTelemetry(revision, [
		{ ...stage, usageIncomplete: 0, usage: new TokenUsage({ model: usage }).toJSON() },
	]);
	expect(complete.toJSON().usageIncomplete).toBeUndefined();
	expect(complete.render()).not.toContain("incomplete");
	const empty = new StageTelemetry(revision, [{ ...stage, usageIncomplete: 1 }]);
	expect(empty.spend()).toBe("Token usage unavailable (usage incomplete: 1 request(s) not measured)");
	expect(empty.toJSON().usageIncomplete).toBe(1);
	const partial = new StageTelemetry(revision, [
		{ ...stage, usageIncomplete: 1, usage: new TokenUsage({ model: usage }).toJSON() },
		{ ...stage, id: "task:2", usageIncomplete: 2 },
	]);
	expect(partial.toJSON().usageIncomplete).toBe(3);
	expect(partial.spend()).toBe(
		"36 tokens, $0.1 (usage unavailable for 1 stage) (usage incomplete: 3 request(s) not measured)",
	);
	expect(partial.render().split("\n")[2]).toContain("usage incomplete: 2 request(s) not measured");
});

it("awaits a request receipt before dispatch and propagates a receipt failure without calling the provider", async () => {
	const fake = createFakeModels();
	const model = (await RouteTextModel.create(fake.review, [fake.ref()]))!;
	const complete = vi.spyOn(fake.models, "complete");
	let rejectStart!: (error: Error) => void;
	const pending = new Promise<void>((_, reject) => {
		rejectStart = reject;
	});
	const observe = Object.assign(vi.fn<UsageObserver>(), { started: vi.fn(() => pending) });
	const answer = model.answer(
		{
			system: "request receipt",
			prompt: "Answer only after receipt",
			tool: { name: "answer", description: "Answer", parameters: { type: "object" } },
		},
		undefined,
		observe,
	);
	expect(observe.started).toHaveBeenCalledOnce();
	expect(complete).not.toHaveBeenCalled();
	rejectStart(new Error("cannot persist request start"));
	await expect(answer).rejects.toThrow("cannot persist request start");
	expect(complete).not.toHaveBeenCalled();
	expect(observe).not.toHaveBeenCalled();
});
