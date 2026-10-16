import { readFileSync } from "node:fs";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	type Harness,
	type JsonObject,
	openHarness,
	TelemetryReader,
	UsageDoc,
} from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { ChecksDocument } from "../src/checks.ts";
import { LensDocument } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { SummaryIndex } from "../src/summarize.ts";
import { TaskTiming } from "../src/task-timing.ts";

let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.restoreAllMocks();
});

it.each([200, 201])("reads every stage and settled input across %i-record pages", async (count) => {
	const fake = createFakeModels();
	const storage = createMemoryStorage();
	const registry = createRegistry();
	const revision = "base..head";
	const task = defineTask<null, { phase: "run" | "end" }, null>({
		name: "test.transcripts",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, taskContext) => {
				await runtime.commit(async (tx) => {
					for (let childIndex = 0; childIndex < count; childIndex++) {
						const child = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
						if (childIndex === count - 1) continue;
						if (childIndex === count - 4) {
							await tx.createSubmission({
								type: "input",
								status: "unanswered",
								reason: "aborted",
								conversationId: child.id,
								requestId: "never-placed",
							});
							continue;
						}
						if (childIndex === count - 2 || childIndex === count - 3) {
							const input = await tx.appendEntry(child.id, {
								kind: "pi.user",
								model: [{ role: "user", content: "input", timestamp: 0 }],
							});
							await tx.createSubmission({
								type: "input",
								status: "unanswered",
								reason: "model_error",
								detail: childIndex === count - 2 ? "error\u001b[2J" : { code: "failure" },
								conversationId: child.id,
								requestId: "failure",
								entry: input.id,
							});
							if (childIndex === count - 2)
								await tx.appendEntry(child.id, {
									kind: "pi.system",
									model: [{ role: "system", content: "", timestamp: 1 }],
								});
							continue;
						}
						if (childIndex === 1) (await tx.doc(LensDocument, child.id)).spend = { calls: [], ended: "tools" };
						if (childIndex === 2) (await tx.doc(LensDocument, child.id)).spend = { calls: [], capped: 1 };
						for (let attempt = 0; attempt < (childIndex === 0 ? count : 1); attempt++) {
							const input = await tx.appendEntry(child.id, {
								kind: "pi.user",
								model: [{ role: "user", content: "input", timestamp: attempt }],
							});
							const answer = await tx.appendEntry(child.id, {
								kind: "pi.assistant",
								model: [fauxAssistantMessage("done", { timestamp: attempt + 1 })],
							});
							await tx.createSubmission({
								type: "input",
								status: "done",
								conversationId: child.id,
								requestId: String(attempt),
								entry: input.id,
								answer: answer.id,
							});
						}
						const passive = await tx.appendEntry(child.id, {
							kind: "test.note",
							data: { note: "after the answer" },
						});
						await tx.createSubmission({
							type: "write",
							status: "done",
							conversationId: child.id,
							requestId: "passive",
							entry: passive.id,
						});
					}
					return { status: "running", checkpoint: { phase: "end" } };
				}, taskContext);
			},
			end: async (_task, runtime, taskContext) => {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
					taskContext,
				);
			},
		},
		abort: async (_task, runtime, taskContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
		},
	});
	const publishing = defineTask<{ target: { revision: string } }, { phase: "run" }, null>({
		name: "melian.publish",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, taskContext) => {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
					taskContext,
				);
			},
		},
		abort: async (_task, runtime, taskContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
		},
	});
	registry.install(defineExtension({ name: "test.pages", tasks: [task, publishing] }));
	harness = await openHarness(storage, { models: fake.models, registry });
	const root = await harness.root(context);
	const ids = await root.commit(async (tx) => {
		const transcript = await tx.createTask(task, null, { ownership: { kind: "conversation" } });
		(await tx.doc(SummaryIndex, root.id)).tasks[revision] = transcript;
		const ids = [transcript];
		for (let index = 0; index < count; index++)
			ids.push(
				await tx.createTask(
					publishing,
					{ target: { revision: index === count - 1 ? revision : "other..head" } },
					{ ownership: { kind: "conversation" } },
				),
			);
		return ids;
	}, context);
	const settled = await Promise.all(ids.map((id) => harness!.waitForTask(id, context)));
	for (const record of settled)
		expect(record.state.outcome, JSON.stringify(record.state.outcome)).toMatchObject({ status: "completed" });
	const commit = vi.spyOn(storage, "commit");
	const telemetry = await TelemetryReader.open(storage).read(revision);
	expect(telemetry.stages).toHaveLength(count + 1);
	expect(new Set(telemetry.stages.map(({ id }) => id)).size).toBe(count + 1);
	const walkthroughs = telemetry.stages.filter(({ name }) => name === "melian.walkthrough");
	expect(walkthroughs).toHaveLength(count);
	expect(walkthroughs[0]).toMatchObject({ startedAt: 0, endedAt: count, durationMs: count, outcome: "completed" });
	expect(walkthroughs[0]!.usage).toEqual({ models: [], tokens: 0, cost: 0 });
	expect(walkthroughs[1]!.outcome).toBe("ended");
	expect(walkthroughs[2]!.outcome).toBe("ended");
	expect(walkthroughs[count - 1]).toMatchObject({
		timing: "unavailable",
		note: expect.stringContaining("not started"),
	});
	expect(walkthroughs[count - 2]).toMatchObject({ outcome: "failed", error: "error\u001b[2J" });
	expect(walkthroughs[count - 2]!.endedAt).toBe(1);
	expect(walkthroughs[count - 3]).toMatchObject({
		outcome: "failed",
		endedAt: 0,
		durationMs: 0,
		clockRegressed: false,
	});
	expect(walkthroughs[count - 3]!.error).toBeUndefined();
	expect(walkthroughs[count - 4]).toMatchObject({ outcome: "failed", timing: "unavailable" });
	expect(telemetry.render()).toContain("No start recorded by the older build, or stage not started.");
	expect(telemetry.render()).toContain("error\\u001b[2J");
	const find = storage.findDocument.bind(storage);
	vi.spyOn(storage, "findDocument").mockImplementation((address, at, readContext) => {
		if (address.kind === UsageDoc.definition.kind) return Promise.resolve(undefined);
		return find(address, at, readContext);
	});
	expect((await TelemetryReader.open(storage).read(revision)).stages[0]!.usage).toBeUndefined();
	expect(telemetry.stages.filter(({ name }) => name === "melian.publication")).toHaveLength(1);
	expect(commit).not.toHaveBeenCalled();
	expect(fake.provider.state.callCount).toBe(0);
});

it("reads an empty store without writing or making up a stage", async () => {
	const storage = createMemoryStorage();
	const commit = vi.spyOn(storage, "commit");
	const telemetry = await TelemetryReader.open(storage).read("base..head");
	expect(telemetry.toJSON()).toEqual({ revision: "base..head", stages: [] });
	expect(telemetry.slowest()).toBe("melian: Stage timings unavailable.\n");
	expect(commit).not.toHaveBeenCalled();
	await storage.close(context);
});

it("migrates a recorded old checks document in memory and refuses a future index", async () => {
	const fake = createFakeModels();
	const storage = createMemoryStorage();
	harness = await openHarness(storage, { models: fake.models, registry: createRegistry() });
	const root = await harness.root(context);
	const recorded = JSON.parse(
		readFileSync(new URL("./fixtures/stored-checks-v3/review.json", import.meta.url), "utf8"),
	) as { checks: JsonObject };
	const old = defineDoc<JsonObject>({
		kind: ChecksDocument.definition.kind,
		version: 3,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({}),
	});
	await root.commit(async (tx) => {
		Object.assign(await tx.doc(old, root.id), recorded.checks);
	}, context);
	const commit = vi.spyOn(storage, "commit");
	expect((await TelemetryReader.open(storage).read("missing..head")).stages).toEqual([]);
	expect(commit).not.toHaveBeenCalled();
	const future = defineDoc<JsonObject>({
		kind: ReviewIndex.definition.kind,
		version: 4,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({}),
	});
	await root.commit(async (tx) => {
		Object.assign(await tx.doc(future, root.id), { reviews: {} });
	}, context);
	commit.mockClear();
	await expect(TelemetryReader.open(storage).read("base..head")).rejects.toMatchObject({
		code: "unreadable",
		message: expect.stringContaining("newer"),
	});
	expect(commit).not.toHaveBeenCalled();
});

it("reads an active memo and distinguishes the call-time boundary", async () => {
	const fake = createFakeModels();
	const storage = createMemoryStorage();
	const registry = createRegistry();
	let now = 100;
	let started: () => void = () => {};
	const admitted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let release: () => void = () => {};
	const finish = new Promise<void>((resolve) => {
		release = resolve;
	});
	const task = defineTask<null, { phase: "run" }, null>({
		name: "test.active",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, taskContext) => {
				const timing = await TaskTiming.start(runtime, undefined, taskContext);
				started();
				await finish;
				await runtime.commit(async (tx) => {
					await timing.end(tx);
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, taskContext);
			},
		},
		abort: async (_task, runtime, taskContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
		},
	});
	registry.install(defineExtension({ name: "test.active", tasks: [task] }));
	harness = await openHarness(storage, { models: fake.models, registry, now: () => now });
	const root = await harness.root(context);
	const id = await root.commit(async (tx) => {
		const id = await tx.createTask(task, null, { ownership: { kind: "conversation" } });
		(await tx.doc(ReviewIndex, root.id)).reviews["base..head"] = {
			lenses: [],
			adjudication: { task: id, input: "{}" },
		};
		return id;
	}, context);
	const waiting = harness.waitForTask(id, context);
	try {
		await admitted;
		const active = await TelemetryReader.open(storage).read("base..head", 100);
		expect(active.stages[0]).toMatchObject({ outcome: "running", startedAt: 100, reused: false, resumed: false });
		expect(active.stages[0]!.endedAt).toBeUndefined();
		expect(active.slowest()).toBe("melian: Stage timings unavailable.\n");
		const resumed = await TelemetryReader.open(storage).read("base..head", 101);
		expect(resumed.stages[0]!.resumed).toBe(true);
	} finally {
		now = 200;
		release();
		await waiting;
	}
	const atEnd = await TelemetryReader.open(storage).read("base..head", 200);
	expect(atEnd.stages[0]).toMatchObject({ reused: false, resumed: true });
	expect(atEnd.slowest()).toContain("(resumed)");
	expect(atEnd.render()).toContain("resumed");
	expect((await TelemetryReader.open(storage).read("base..head", 201)).stages[0]).toMatchObject({
		reused: true,
		resumed: false,
	});
});

it.each([true, false])("ends a faulted model stage at Pi's task time (input=%s)", async (input) => {
	const fake = createFakeModels();
	const storage = createMemoryStorage();
	const registry = createRegistry();
	let now = 100;
	const task = defineTask<null, { phase: "spawn" | "fail" }, null>({
		name: "test.model-fault",
		version: 1,
		initial: () => ({ phase: "spawn" }),
		phases: {
			spawn: async (_task, runtime, taskContext) => {
				await runtime.commit(async (tx) => {
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
					if (input) {
						const entry = await tx.appendEntry(child.id, {
							kind: "pi.user",
							model: [{ role: "user", content: "input", timestamp: runtime.now() }],
						});
						await tx.createSubmission({
							type: "input",
							status: "placed",
							conversationId: child.id,
							requestId: "input",
							entry: entry.id,
						});
					}
					return { status: "running", checkpoint: { phase: "fail" } };
				}, taskContext);
			},
			fail: async () => {
				now = 150;
				throw new Error("model task fault");
			},
		},
		abort: async (_task, runtime, taskContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
		},
	});
	registry.install(defineExtension({ name: "test.model-fault", tasks: [task] }));
	harness = await openHarness(storage, { models: fake.models, registry, now: () => now });
	const root = await harness.root(context);
	const id = await root.commit(async (tx) => {
		const id = await tx.createTask(task, null, { ownership: { kind: "conversation" } });
		(await tx.doc(SummaryIndex, root.id)).tasks["base..head"] = id;
		return id;
	}, context);
	expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("faulted");
	now = 10000;
	const row = (await TelemetryReader.open(storage).read("base..head")).stages[0]!;
	expect(row).toMatchObject({ outcome: "faulted", endedAt: 150, error: "model task fault" });
	if (input) expect(row).toMatchObject({ startedAt: 100, durationMs: 50 });
	else {
		expect(row.startedAt).toBeUndefined();
		expect(row.durationMs).toBeUndefined();
	}
});
