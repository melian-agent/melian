import { createHash } from "node:crypto";
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
import { replaceCheckFindings, revisionKey } from "./findings.ts";
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
 * What became of one check on one revision, in the shape of core's `CheckRecord`, so a review takes it as it is: it
 * ran, with the tool version its findings name, how many findings it wrote, and anything it could not look at; it was
 * skipped, and why; or it failed, with the error's code as `reason` and its message as `error`. A failed check wrote no
 * findings, so adjudication reports the revision as not reviewed by it rather than as clean.
 */
export type CheckRunRecord =
	| { name: string; status: "ran"; version?: string; findings: number; notes: string[] }
	| { name: string; status: "skipped"; reason: string }
	| { name: string; status: "failed"; reason: string; error: string };

/**
 * What identifies one run of a tier: both commits, the tier, a hash of the configuration and source it ran under, and
 * the task that ran it, since a rerun of failed checks is a new task with the same policy.
 */
export type RunIdentity = { base: string; head: string; tier: string; policy: string; task: number };

/** One run of a tier: its identity, and one record per check the tier names, in the tier's order. */
export interface CheckRun {
	readonly identity: RunIdentity;
	readonly records: readonly CheckRunRecord[];
}

type Runs = {
	// Each run's check records, keyed by its whole identity, then by check.
	runs: Record<string, Record<string, CheckRunRecord>>;
	// The latest task for each identity short of its task, so asking again finds it rather than starting another.
	tasks: Record<string, number>;
};

export const ChecksDocument = defineDoc<Runs>({
	kind: "melian.checks",
	version: 3,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ runs: {}, tasks: {} }),
});

function identityKey({ base, head, tier, policy, task }: RunIdentity): string {
	return `${base} ${head} ${tier} ${policy} ${task}`;
}

interface CheckInput {
	// The run this check belongs to, as identityKey writes it.
	readonly run: string;
	readonly check: DeterministicCheck;
	readonly changeset: Changeset;
	readonly config: MelianConfig;
	readonly source: RepositorySource;
}

type Outcome =
	| { readonly status: "ran"; readonly report: CheckReport; readonly version?: string }
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
		tool,
		settings,
		base: base.status === "ran" ? base.log : empty,
		head: head.log,
	});
	const notes = [...report.notes, ...head.notes, ...(base.status === "ran" ? base.notes : [])];
	return {
		status: "ran",
		report: { findings: report.findings, notes },
		version: head.log.runs[0].tool.driver.version,
	};
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

function failure(name: string, error: unknown): CheckRunRecord {
	const code =
		typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unexpected";
	const message = error instanceof Error ? error.message : String(error);
	return { name, status: "failed", reason: code, error: message };
}

// One check on one revision. Rerunning it after a crash runs the tools again on the same commits and writes the same
// findings, so the task is safe to replay. The check's findings at this base and head are replaced, not added to, in
// the commit that records it, so a failed rerun leaves none of an earlier run's findings behind.
const CheckTask = defineTask<CheckInput, { phase: "run" }, CheckRunRecord>({
	name: "melian.check",
	version: 2,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const { check, changeset, run } = task.input;
			let outcome: Outcome | undefined;
			let record: CheckRunRecord;
			try {
				outcome = await runCheck(task.input, () => runtime.env(context), context);
				record =
					outcome.status === "skipped"
						? { name: check, status: "skipped", reason: outcome.reason }
						: {
								name: check,
								status: "ran",
								...(outcome.version === undefined ? {} : { version: outcome.version }),
								findings: outcome.report.findings.length,
								notes: [...outcome.report.notes],
							};
			} catch (error) {
				record = failure(check, error);
			}
			const revision = revisionKey(changeset.revision);
			await runtime.commit(async (tx) => {
				const findings = outcome?.status === "ran" ? outcome.report.findings : [];
				await replaceCheckFindings(tx, runtime.conversationId, check, revision, findings);
				const { runs } = await tx.doc(ChecksDocument, runtime.conversationId);
				runs[run] = { ...runs[run], [check]: record };
				return { status: "terminal", outcome: { status: "completed", result: record } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

interface ChecksInput {
	readonly identity: Omit<RunIdentity, "task">;
	readonly changeset: Changeset;
	readonly config: MelianConfig;
	readonly source: RepositorySource;
	readonly tier: string;
	// A rerun runs only `checks`, and keeps the earlier run's records for the rest.
	readonly rerun?: { readonly checks: readonly string[]; readonly kept: Readonly<Record<string, CheckRunRecord>> };
}

type ChecksState = { phase: "start" } | { phase: "collect"; checks: string[]; tasks: Record<string, number> };

function skippedReason(check: string): string | undefined {
	if (check.startsWith("lens.")) return "lenses run in the lens step, not as a check task";
	if (check.startsWith("decisions.")) return "decision-model questions are not built yet";
	return undefined;
}

// A tier's checks on one revision: one child task per deterministic check, waited on together.
const ChecksTask = defineTask<ChecksInput, ChecksState, CheckRunRecord[]>({
	name: "melian.checks",
	version: 2,
	initial: () => ({ phase: "start" }),
	phases: {
		start: async (task, runtime, context) => {
			const { changeset, config, source, tier, rerun } = task.input;
			const run = identityKey({ ...task.input.identity, task: runtime.taskId });
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
				const { runs } = await tx.doc(ChecksDocument, runtime.conversationId);
				const records: Record<string, CheckRunRecord> = {};
				const tasks: Record<string, number> = {};
				for (const check of checks) {
					const kept = rerun?.checks.includes(check) === false ? rerun.kept[check] : undefined;
					if (kept !== undefined) {
						records[check] = kept;
						continue;
					}
					if ((deterministicChecks as readonly string[]).includes(check)) {
						tasks[check] = await tx.createTask(
							CheckTask,
							{ run, check: check as DeterministicCheck, changeset, config, source },
							{ ownership: { kind: "task", taskId: runtime.taskId } },
						);
						continue;
					}
					const reason = skippedReason(check);
					records[check] =
						reason === undefined
							? { name: check, status: "failed", reason: "unknownCheck", error: `no check is named ${check}` }
							: { name: check, status: "skipped", reason };
				}
				runs[run] = records;
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
				names.map((name) => tasks[name] as TaskId<CheckRunRecord>),
				context,
			);
			const run = identityKey({ ...task.input.identity, task: runtime.taskId });
			await runtime.commit(async (tx) => {
				const { runs } = await tx.doc(ChecksDocument, runtime.conversationId);
				const records = { ...runs[run] };
				// A check task that ended without recording itself, such as one that faulted, failed.
				names.forEach((name, index) => {
					const outcome = outcomes[index]!;
					if (outcome.status === "completed") return;
					const message =
						"error" in outcome && outcome.error !== undefined ? outcome.error.message : outcome.status;
					records[name] = { name, status: "failed", reason: outcome.status, error: message };
				});
				runs[run] = records;
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
	/** Run again the checks that failed in an earlier run with the same identity, or the whole tier if that run did not complete. */
	readonly rerunFailed?: boolean;
}

// Canonical JSON: object keys sorted, so two equal configurations hash alike whatever order their files merged in.
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).filter(([, each]) => each !== undefined);
		entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

// What decides a run's results: both commits, the tier, and the policy it ran under.
function runIdentity(input: RunChecksInput, tier: string): Omit<RunIdentity, "task"> {
	const { base, head } = input.changeset.revision;
	const policy = createHash("sha256")
		.update(canonical({ config: input.config, source: input.source }))
		.digest("hex")
		.slice(0, 16);
	return { base, head, tier, policy };
}

// What a rerun repeats: the checks that failed, or the whole tier when the run did not complete.
function rerunOf(outcome: {
	status: string;
	result?: readonly CheckRunRecord[];
}): ChecksInput["rerun"] | "none" | "all" {
	if (outcome.status !== "completed" || outcome.result === undefined) return "all";
	const failed = outcome.result.filter((record) => record.status === "failed").map((record) => record.name);
	if (failed.length === 0) return "none";
	const kept = Object.fromEntries(
		outcome.result.filter((record) => record.status !== "failed").map((record) => [record.name, record]),
	);
	return { checks: failed, kept };
}

/**
 * Runs a tier's checks on the changeset's revision as durable tasks in its root conversation: one task per check,
 * waited on together, each replacing its findings at the revision in the root's findings document and recording its status
 * under the run's identity, in one commit. Resolves with the run's identity and one record per check the tier names, in
 * the tier's order.
 *
 * Asking again with the same base, head, tier, configuration, and source, even from a new process after a crash, finds
 * the task already started and waits for it, so the checks run once. A different base, configuration, or source runs
 * them again. `rerunFailed` runs again the checks that failed, as a new task with its own identity, so a transient
 * failure is not kept for good. Lens checks are recorded as skipped, since they run in the lens step; a name that is no
 * check is recorded as failed with `unknownCheck`. Rejects when the tier is unknown or includes
 * itself, and when the root conversation does not exist.
 */
export async function runChecks(harness: Harness, input: RunChecksInput, context: Context): Promise<CheckRun> {
	const tier = input.tier ?? "fast";
	const root = await harness.conversation(input.rootConversationId, context);
	if (root === undefined) {
		throw new CheckError("unknownConversation", tier, `no conversation has ID ${input.rootConversationId}`);
	}
	const identity = runIdentity(input, tier);
	const key = identityKey({ ...identity, task: 0 });
	const task: ChecksInput = {
		identity,
		changeset: input.changeset,
		config: input.config,
		source: input.source,
		tier,
	};
	// Starts a run unless one with this key exists, or replaces `stale` with a rerun when it is still the key's task.
	const start = (rerun?: ChecksInput["rerun"], stale?: number) =>
		root.commit(async (tx) => {
			const runs = await tx.doc(ChecksDocument, root.id);
			const existing = runs.tasks[key];
			if (existing !== undefined && existing !== stale) return existing as TaskId<CheckRunRecord[]>;
			const created = await tx.createTask(ChecksTask, rerun === undefined ? task : { ...task, rerun }, {
				ownership: { kind: "conversation" },
			});
			runs.tasks[key] = created;
			return created;
		}, context);
	let taskId = await start();
	let settled = await harness.waitForTask(taskId, context);
	if (input.rerunFailed) {
		const rerun = rerunOf(settled.state.outcome as { status: string; result?: readonly CheckRunRecord[] });
		if (rerun !== "none") {
			taskId = await start(rerun === "all" ? undefined : rerun, taskId);
			settled = await harness.waitForTask(taskId, context);
		}
	}
	const { outcome } = settled.state;
	if (outcome.status === "completed") return { identity: { ...identity, task: taskId }, records: outcome.result };
	if (outcome.status === "failed") {
		const code = (outcome.error.detail as { code?: CheckErrorCode } | undefined)?.code ?? "notCompleted";
		throw new CheckError(code, tier, outcome.error.message);
	}
	const reason = outcome.status === "faulted" ? outcome.error.message : (outcome.reason ?? outcome.status);
	throw new CheckError("notCompleted", tier, `the ${tier} checks ended ${outcome.status}: ${reason}`);
}

/** The check records of one run, by check. Empty when no run has that identity. */
export async function readCheckRecords(
	harness: Pick<Harness, "snapshot">,
	rootConversationId: ConversationId,
	identity: RunIdentity,
	context: Context,
): Promise<Readonly<Record<string, CheckRunRecord>>> {
	const document = await harness.snapshot(ChecksDocument, rootConversationId, context);
	return structuredClone(document?.runs[identityKey(identity)] ?? {});
}
