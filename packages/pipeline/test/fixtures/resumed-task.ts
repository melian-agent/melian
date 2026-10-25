import { defineTask } from "../../src/index.ts";
import { TaskTiming } from "../../src/task-timing.ts";

// A deterministic task that memoises its start, runs `between`, then records its end; a kill inside `between` leaves
// it to resume in the next process with its first start.
export function resumedTask(between: () => Promise<void>) {
	return defineTask<null, { phase: "run" }, null>({
		name: "test.resumed",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, taskContext) => {
				const timing = await TaskTiming.start(runtime, undefined, taskContext);
				await between();
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
}
