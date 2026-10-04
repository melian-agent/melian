import type { CheckRecord, MelianConfig, RepositorySource } from "@melian-agent/core";
import { type Context, type ConversationId, defineDoc, defineTask, type Harness } from "./harness.ts";
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
});

// Which task ran each tier's checks, on the root conversation, so a repeat call finds it after a restart.
export const ChecksDocument = defineDoc<{ runs: Record<string, number> }>({
	kind: "melian.checks",
	version: 1,
	scope: "conversation",
	initial: () => ({ runs: {} }),
});

/**
 * Runs a tier's checks on one revision under the input's configuration, and returns a record for each check. Asking
 * twice runs once: a repeat call, from this process or a new one, waits for the task the first call started.
 */
export async function runChecks(harness: Harness, input: ChecksInput, context: Context): Promise<CheckRecord[]> {
	const root = await harness.root(context);
	const key = `${input.head} ${input.tier}`;
	const id = await root.commit(async (tx) => {
		const runs = await tx.doc(ChecksDocument, root.id);
		const existing = runs.runs[key];
		if (existing !== undefined) return existing;
		const created = await tx.createTask(ChecksTask, input, { ownership: { kind: "conversation" } });
		runs.runs[key] = created;
		return created;
	}, context);
	const { outcome } = (await harness.waitForTask(id, context)).state;
	if (outcome.status !== "completed") throw new Error(`the ${input.tier} checks ended ${outcome.status}`);
	return outcome.result;
}
