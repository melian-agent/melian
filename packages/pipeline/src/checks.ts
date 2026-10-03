import {
	type Changeset,
	CheckError,
	type CheckErrorCode,
	type CheckReport,
	checksOfTier,
	type DeterministicCheck,
	deterministicChecks,
	evaluateGuardrails,
	type MelianConfig,
	type RepositorySource,
	type StaticTool,
	staticFindings,
	type ToolLog,
} from "@melian-agent/core";
import { upsertFinding } from "./findings.ts";
import {
	type Context,
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTask,
	type ExecutionEnv,
	type Harness,
	type TaskId,
} from "./harness.ts";
import { runStaticTool } from "./static.ts";

// Type aliases, not interfaces: a document's value must satisfy Pi's JsonObject, which an interface never does.

/**
 * What became of one check on one revision: it ran, with how many findings it wrote and anything it could not look at;
 * it was skipped, and why; or it failed, with the error's code and message. A failed check wrote no findings, so
 * adjudication reports the revision as not reviewed by it rather than as clean.
 */
export type CheckRecord =
	| { check: string; status: "ran"; findings: number; notes: string[] }
	| { check: string; status: "skipped"; reason: string }
	| { check: string; status: "failed"; error: { code: string; message: string } };

type Runs = {
	// Each revision's check records, keyed by head commit, then by check.
	revisions: Record<string, Record<string, CheckRecord>>;
	// The task running each revision's tier, keyed `<head> <tier>`, so asking again finds it rather than starting another.
	tasks: Record<string, number>;
};

export const ChecksDocument = defineDoc<Runs>({
	kind: "melian.checks",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ revisions: {}, tasks: {} }),
});

interface CheckInput {
	readonly check: DeterministicCheck;
	readonly changeset: Changeset;
	readonly config: MelianConfig;
	readonly source: RepositorySource;
}

type Outcome =
	| { readonly status: "ran"; readonly report: CheckReport }
	| { readonly status: "skipped"; readonly reason: string };

const toolOf: Readonly<Record<Exclude<DeterministicCheck, "guardrails">, StaticTool>> = {
	"static.biome": "biome",
	"static.tsc": "tsc",
};

async function runStatic(input: CheckInput, env: ExecutionEnv | undefined, context: Context): Promise<Outcome> {
	const tool = toolOf[input.check as keyof typeof toolOf];
	const settings = input.config.static[tool];
	if (!settings.enabled) return { status: "skipped", reason: `static.${tool}.enabled is false` };
	if (env === undefined) {
		throw new CheckError(
			"noEnvironment",
			input.check,
			"the harness has no execution environment to run static tools in",
		);
	}
	const { repoRoot, revision } = input.changeset;
	const run = (commit: string) => runStaticTool({ env, repoRoot, commit, tool, settings }, context);
	const head = await run(revision.head);
	if (head.status === "skipped") return head;
	const base = await run(revision.base);
	// A base without the tool's project, such as before a repository adopted TypeScript, reports nothing to subtract.
	const empty: ToolLog = { ...head.log, runs: [{ ...head.log.runs[0], results: [] }] };
	const report = await staticFindings({
		repoRoot,
		revision,
		source: input.source,
		tool,
		settings,
		base: base.status === "ran" ? base.log : empty,
		head: head.log,
	});
	const notes = [...report.notes, ...head.notes, ...(base.status === "ran" ? base.notes : [])];
	return { status: "ran", report: { findings: report.findings, notes } };
}

async function runCheck(
	input: CheckInput,
	env: () => Promise<ExecutionEnv | undefined>,
	context: Context,
): Promise<Outcome> {
	if (input.check === "guardrails") {
		const { repoRoot, revision } = input.changeset;
		return { status: "ran", report: await evaluateGuardrails({ repoRoot, revision, source: input.source }) };
	}
	return runStatic(input, await env(), context);
}

function failure(check: string, error: unknown): CheckRecord {
	const code =
		typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unexpected";
	const message = error instanceof Error ? error.message : String(error);
	return { check, status: "failed", error: { code, message } };
}

// One check on one revision. Rerunning it after a crash runs the tools again on the same commits and upserts the same
// findings, so the task is safe to replay.
const CheckTask = defineTask<CheckInput, { phase: "run" }, CheckRecord>({
	name: "melian.check",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const { check, changeset } = task.input;
			let outcome: Outcome | undefined;
			let record: CheckRecord;
			try {
				outcome = await runCheck(task.input, () => runtime.env(context), context);
				record =
					outcome.status === "skipped"
						? { check, status: "skipped", reason: outcome.reason }
						: {
								check,
								status: "ran",
								findings: outcome.report.findings.length,
								notes: [...outcome.report.notes],
							};
			} catch (error) {
				record = failure(check, error);
			}
			const head = changeset.revision.head;
			await runtime.commit(async (tx) => {
				if (outcome?.status === "ran") {
					for (const finding of outcome.report.findings) {
						await upsertFinding(tx, runtime.conversationId, finding, head);
					}
				}
				const { revisions } = await tx.doc(ChecksDocument, runtime.conversationId);
				revisions[head] = { ...revisions[head], [check]: record };
				return { status: "terminal", outcome: { status: "completed", result: record } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

interface ChecksInput {
	readonly changeset: Changeset;
	readonly config: MelianConfig;
	readonly source: RepositorySource;
	readonly tier: string;
}

type ChecksState = { phase: "start" } | { phase: "collect"; checks: string[]; tasks: Record<string, number> };

function skippedReason(check: string): string | undefined {
	if (check.startsWith("lens.")) return "lenses run in the lens step, not as a check task";
	if (check.startsWith("decisions.")) return "decision-model questions are not built yet";
	return undefined;
}

// A tier's checks on one revision: one child task per deterministic check, waited on together.
const ChecksTask = defineTask<ChecksInput, ChecksState, CheckRecord[]>({
	name: "melian.checks",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: {
		start: async (task, runtime, context) => {
			const { changeset, config, source, tier } = task.input;
			const head = changeset.revision.head;
			let checks: string[];
			try {
				checks = checksOfTier(config, tier);
			} catch (error) {
				if (!(error instanceof CheckError)) throw error;
				const failed = { message: error.message, detail: { code: error.code } };
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: failed } }), context);
				return;
			}
			await runtime.commit(async (tx) => {
				const { revisions } = await tx.doc(ChecksDocument, runtime.conversationId);
				const records = { ...revisions[head] };
				const tasks: Record<string, number> = {};
				for (const check of checks) {
					if ((deterministicChecks as readonly string[]).includes(check)) {
						tasks[check] = await tx.createTask(
							CheckTask,
							{ check: check as DeterministicCheck, changeset, config, source },
							{ ownership: { kind: "task", taskId: runtime.taskId } },
						);
						continue;
					}
					const reason = skippedReason(check);
					records[check] =
						reason === undefined
							? {
									check,
									status: "failed",
									error: { code: "unknownCheck", message: `no check is named ${check}` },
								}
							: { check, status: "skipped", reason };
				}
				revisions[head] = records;
				const ids = Object.values(tasks) as TaskId[];
				if (ids.length === 0) {
					return {
						status: "terminal",
						outcome: { status: "completed", result: checks.map((check) => records[check]!) },
					};
				}
				return {
					status: "waiting",
					checkpoint: { phase: "collect", checks, tasks },
					on: ids,
					policy: "allSettled",
				};
			}, context);
		},
		collect: async (task, runtime, context) => {
			const { checks, tasks } = task.state.checkpoint;
			const names = Object.keys(tasks);
			const outcomes = await runtime.outcomes(
				names.map((name) => tasks[name] as TaskId<CheckRecord>),
				context,
			);
			const head = task.input.changeset.revision.head;
			await runtime.commit(async (tx) => {
				const { revisions } = await tx.doc(ChecksDocument, runtime.conversationId);
				const records = { ...revisions[head] };
				// A check task that ended without recording itself, such as one that faulted, failed.
				names.forEach((name, index) => {
					const outcome = outcomes[index]!;
					if (outcome.status === "completed") return;
					const message =
						"error" in outcome && outcome.error !== undefined ? outcome.error.message : outcome.status;
					records[name] = { check: name, status: "failed", error: { code: outcome.status, message } };
				});
				revisions[head] = records;
				return {
					status: "terminal",
					outcome: { status: "completed", result: checks.map((check) => records[check]!) },
				};
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/**
 * The extension that runs checks. Install it in the registry of every harness that calls {@link runChecks}, including
 * one reopened after a crash, so pending check tasks resume. Static checks take their execution environment from the
 * harness's `env` option, the seam a container environment replaces.
 */
export const checksExtension = defineExtension({ name: "melian.checks", tasks: [ChecksTask, CheckTask] });

/** What {@link runChecks} runs. */
export interface RunChecksInput {
	/** The changeset's root conversation, which owns its findings and check records. */
	readonly rootConversationId: ConversationId;
	readonly changeset: Changeset;
	/** The configuration for the repository root, read from `source`; it names the tier's checks and static settings. */
	readonly config: MelianConfig;
	/** Where policy is read from: the base commit for a pull request. */
	readonly source: RepositorySource;
	/** Defaults to `fast`. */
	readonly tier?: string;
}

/**
 * Runs a tier's checks on the changeset's revision as durable tasks in its root conversation: one task per check,
 * waited on together, each writing its findings to the root's findings document through `upsertFinding` and its
 * status to the root's check records. Resolves with one record per check the tier names, in the tier's order.
 *
 * Asking again for the same revision and tier, even from a new process after a crash, finds the task already started
 * and waits for it, so the checks run once. Lens checks are recorded as skipped, since they run in the lens step;
 * a name that is no check is recorded as failed with `unknownCheck`. Rejects when the tier is unknown or includes
 * itself, and when the root conversation does not exist.
 */
export async function runChecks(
	harness: Harness,
	input: RunChecksInput,
	context: Context,
): Promise<readonly CheckRecord[]> {
	const tier = input.tier ?? "fast";
	const root = await harness.conversation(input.rootConversationId, context);
	if (root === undefined) {
		throw new CheckError("unknownConversation", tier, `no conversation has ID ${input.rootConversationId}`);
	}
	const key = `${input.changeset.revision.head} ${tier}`;
	const taskId = await root.commit(async (tx) => {
		const runs = await tx.doc(ChecksDocument, root.id);
		const existing = runs.tasks[key];
		if (existing !== undefined) return existing as TaskId<CheckRecord[]>;
		const created = await tx.createTask(
			ChecksTask,
			{ changeset: input.changeset, config: input.config, source: input.source, tier },
			{ ownership: { kind: "conversation" } },
		);
		runs.tasks[key] = created;
		return created;
	}, context);
	const settled = await harness.waitForTask(taskId, context);
	const { outcome } = settled.state;
	if (outcome.status === "completed") return outcome.result;
	if (outcome.status === "failed") {
		const code = (outcome.error.detail as { code?: CheckErrorCode } | undefined)?.code ?? "notCompleted";
		throw new CheckError(code, tier, outcome.error.message);
	}
	const reason = outcome.status === "faulted" ? outcome.error.message : (outcome.reason ?? outcome.status);
	throw new CheckError("notCompleted", tier, `the ${tier} checks ended ${outcome.status}: ${reason}`);
}

/** The check records of a revision, by check. Empty when no check has run on it. */
export async function readCheckRecords(
	harness: Pick<Harness, "snapshot">,
	rootConversationId: ConversationId,
	head: string,
	context: Context,
): Promise<Readonly<Record<string, CheckRecord>>> {
	const document = await harness.snapshot(ChecksDocument, rootConversationId, context);
	return structuredClone(document?.revisions[head] ?? {});
}
