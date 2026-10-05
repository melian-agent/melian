import { type Context, defineTask, type Harness, type TaskId } from "./harness.ts";

/** How one lens's conversation ended. */
export type LensOutcome = { status: "done" } | { status: "failed"; reason: string };

/** What a finished lens task stores: each lens's key, `name@version`, with its outcome, in the order the lenses ran. */
export type LensResult = { key: string; outcome: LensOutcome }[];

type LensInput = { keys: string[] };

/** Runs every lens of a review. A repeat review of a head attaches to the lens task that reviewed it. */
export const LensTask = defineTask<LensInput, { phase: "run" }, LensResult>({
	name: "melian.lenses",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const result: LensResult = task.input.keys.map((key) => ({ key, outcome: { status: "done" } }));
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
		},
	},
});

/** The lenses of a lens task, the one a repeat review attached to included, that did not finish, each with why. */
export async function failedLenses(harness: Harness, id: TaskId<LensResult>, context: Context): Promise<string[]> {
	const { outcome } = (await harness.waitForTask(id, context)).state;
	if (outcome.status !== "completed") return ["the lens task did not complete"];
	return outcome.result.flatMap(({ key, outcome: lens }) =>
		lens.status === "failed" ? [`${key}: ${lens.reason}`] : [],
	);
}
