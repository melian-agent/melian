import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineExtension,
	defineTask,
	openHarness,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";

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
