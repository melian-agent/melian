import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineExtension,
	defineTask,
	openHarness,
	TelemetryReader,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { ReviewIndex } from "../src/review-index.ts";
import { TaskTiming } from "../src/task-timing.ts";

it("Pi retains the fault time rather than the time a reader observes the task", async () => {
	const storage = createMemoryStorage();
	const fake = createFakeModels();
	let now = 100;
	const task = defineTask<null, { phase: "fail" }, null>({
		name: "test.fault-time",
		version: 1,
		initial: () => ({ phase: "fail" }),
		phases: {
			fail: async () => {
				now = 150;
				throw new Error("faulted outside a Melian commit");
			},
		},
		abort: async (_task, runtime, abortContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test.fault-time", tasks: [task] }));
	const harness = await openHarness(storage, {
		models: fake.models,
		registry,
		now: () => now,
	});
	try {
		const id = await (await harness.root(context)).commit(
			(tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }),
			context,
		);
		const settled = await harness.waitForTask(id, context);
		expect(settled.state.outcome.status).toBe("faulted");
		now = 10_000;
		expect(await storage.task(id, context)).toMatchObject({ startedAt: 100, endedAt: 150 });
	} finally {
		await harness.close(context);
	}
});

it("keeps the memoised start when an already-started stage is aborted", async () => {
	const storage = createMemoryStorage();
	const fake = createFakeModels();
	let now = 100;
	let started: () => void = () => {};
	const admitted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const task = defineTask<null, { phase: "run" }, null>({
		name: "test.abort-timing",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, taskContext) => {
				await TaskTiming.start(runtime, undefined, taskContext);
				const aborted = new Promise<void>((resolve) =>
					runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				started();
				await aborted;
			},
		},
		abort: async (_task, runtime, abortContext) => {
			const timing = await TaskTiming.read(runtime, abortContext);
			await runtime.commit(async (tx) => {
				await timing.end(tx);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, abortContext);
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test.abort-timing", tasks: [task] }));
	const harness = await openHarness(storage, { models: fake.models, registry, now: () => now });
	try {
		const root = await harness.root(context);
		const id = await root.commit(async (tx) => {
			const id = await tx.createTask(task, null, { ownership: { kind: "conversation" } });
			(await tx.doc(ReviewIndex, root.id)).reviews["base..head"] = {
				lenses: [],
				adjudication: { task: id, input: "{}" },
			};
			return id;
		}, context);
		const settled = harness.waitForTask(id, context);
		await admitted;
		now = 500;
		await harness.abortTask(id, context);
		expect((await settled).state.outcome.status).toBe("aborted");
		expect((await storage.task(id, context))!.memos).toBeUndefined();
		expect((await TelemetryReader.open(storage).read("base..head")).stages).toEqual([
			expect.objectContaining({
				outcome: "aborted",
				startedAt: 100,
				endedAt: 500,
				durationMs: 400,
				timing: "available",
			}),
		]);
	} finally {
		await harness.close(context);
	}
});
