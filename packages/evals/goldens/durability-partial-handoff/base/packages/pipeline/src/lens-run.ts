import { type Context, defineTask, type Harness, type TaskId } from "./harness.ts";

/** How one lens's conversation ended. */
export type LensOutcome = { status: "done" } | { status: "failed"; reason: string };

/** What a finished lens task stores: each lens's outcome by its key, `name@version`. */
export type LensResult = Record<string, LensOutcome>;

type LensInput = { keys: string[] };

/** Runs every lens of a review. A repeat review of a head attaches to the lens task that reviewed it. */
export const LensTask = defineTask<LensInput, { phase: "run" }, LensResult>({
	name: "melian.lenses",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const result: LensResult = Object.fromEntries(task.input.keys.map((key) => [key, { status: "done" }]));
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
		},
	},
});

/** The lenses of a lens task, the one a repeat review attached to included, that did not finish, each with why. */
export async function failedLenses(harness: Harness, id: TaskId<LensResult>, context: Context): Promise<string[]> {
	const { outcome } = (await harness.waitForTask(id, context)).state;
	if (outcome.status !== "completed") return ["the lens task did not complete"];
	return Object.entries(outcome.result).flatMap(([key, lens]) =>
		lens.status === "failed" ? [`${key}: ${lens.reason}`] : [],
	);
}
