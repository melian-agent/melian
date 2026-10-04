import type { CheckRecord, MelianConfig, RepositorySource } from "@melian-agent/core";
import { type Context, type ConversationId, defineTask, type Harness } from "./harness.ts";
import { runCheck } from "./run-check.ts";

/** One run of a tier's checks: the revision, the configuration that names the checks, and where it was read from. */
export type ChecksInput = {
	root: ConversationId;
	base: string;
	head: string;
	tier: string;
	checks: string[];
	config: MelianConfig;
	source: RepositorySource;
};

export const ChecksTask = defineTask<ChecksInput, { phase: "run" }, CheckRecord[]>({
	name: "melian.checks",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const records: CheckRecord[] = [];
			for (const check of task.input.checks) records.push(await runCheck(check, task.input, context));
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: records } }), context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/** Runs a tier's checks on one revision under the input's configuration, and returns a record for each check. */
export async function runChecks(harness: Harness, input: ChecksInput, context: Context): Promise<CheckRecord[]> {
	const root = await harness.root(context);
	const id = await root.commit(
		(tx) => tx.createTask(ChecksTask, input, { ownership: { kind: "conversation" } }),
		context,
	);
	const { outcome } = (await harness.waitForTask(id, context)).state;
	if (outcome.status !== "completed") throw new Error(`the ${input.tier} checks ended ${outcome.status}`);
	return outcome.result;
}
