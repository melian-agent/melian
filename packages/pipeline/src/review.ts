import { createHash } from "node:crypto";
import {
	type Changeset,
	type CheckRecord,
	type ChoiceQuestion,
	type ConfigFor,
	checksOfTier,
	configLookup,
	type Decider,
	type Decision,
	type DecisionRequest,
	defaultScrutinyLevel,
	describeLineage,
	EscalationRule,
	type EscalationTrigger,
	type Finding,
	Lens,
	type LensBudget,
	type LensCoverage,
	type LensLevel,
	type LensNeighbour,
	type LensRule,
	type LensTier,
	type LensToolName,
	LevelBand,
	lensLimits,
	loadConfig,
	Manifest,
	type MelianConfig,
	type MemberClaim,
	Merge,
	type ModelReference,
	type ModelRoute,
	ModelRoutingError,
	mutationSkipHasLeave,
	parseModelReference,
	type RepositorySource,
	type ReviewPlan,
	Revision,
	resolveModelForTier,
	resolveModelRoute,
	type ScrutinyLevel,
	type Severity,
	Standards,
	StandardsReading,
	type StandardsSection,
	triageChoices,
	triageQuestionSet,
	type Verdict,
	VerificationState,
	verificationBudget,
	visibleText,
} from "@melian-agent/core";
import { DecisionFiles, DesignSections } from "@melian-agent/decisions";
import {
	type AdjudicationResult,
	AdjudicationTask,
	type AdjudicationTaskInput,
	adjudicationInput,
	type ReviewOrigin,
	readVerdict,
	VerdictDocument,
} from "./adjudication.ts";
import { CallerContext, type CoverageSource } from "./callers.ts";
import { blindCallers, callersWithLegacyCaveat, lightTriage } from "./caveats.ts";
import { checksExtensionFor, type RunIdentity, runChecks, type WriterTrust } from "./checks.ts";
import { configsFor } from "./configurations.ts";
import {
	DecisionDocument,
	type DecisionResult,
	type DecisionTaskInput,
	decisionExtension,
	decisionTask,
	decisionTaskName,
	readRecordedDecision,
} from "./decisions.ts";
import { cutDiffNote, EnclosingFunctions } from "./enclosing-functions.ts";
import { ReviewError } from "./errors.ts";
import {
	clearSightings,
	clearVerifications,
	FindingsDocument,
	findingsVersion,
	overlapsSite,
	type Producer,
	type Restating,
	readFindings,
	recordInheritances,
	recordRevision,
	reopenDismissals,
	type SightedFinding,
	sightedBy,
} from "./findings.ts";
import {
	backgroundContext,
	type Context,
	type ConversationId,
	configure,
	createNodeExecutionEnv,
	createRegistry,
	type DocumentReader,
	defineExtension,
	defineTask,
	type Harness,
	isFailoverError,
	type JsonObject,
	openHarness,
	type Registry,
	type Storage,
	type TaskId,
	type Tx,
	UsageDoc,
} from "./harness.ts";
import {
	budgetEnded,
	findingsCapped,
	injectionPolicySection,
	LensDocument,
	type LensPolicy,
	lensListedTools,
	lensPolicyHook,
	lensSource,
	provingHunk,
	type ReviewState,
	recordPlan,
	reportFinding,
	reportVerdict,
	reviewFiles,
	roleTools,
	runProbe,
	runProbeTool,
	type StoredBudgetEnd,
	skipAttack,
} from "./lens-tools.ts";
import { hasCredentials, modelsOf, type ReviewModels } from "./models.ts";
import { Probe, type ProbeSandbox, probeLimits, probeRunnerSample } from "./probe.ts";
import {
	type Attack,
	answerPrompt,
	type ClaimProbe,
	carriedFindings,
	type EarlierFinding,
	earlierLimits,
	headRefusal,
	headTreeLimits,
	ProbeReruns,
	ProbingDocument,
	type ProbingEnvironment,
	plannerContext,
	plannerInstructions,
	probeClaimKey,
	probeConclusive,
	proberInstructions,
	probingHost,
	probingLimits,
	probingRenderings,
	probingWording,
	recordPlanPrompt,
	renderPlan,
	rerunKey,
	runHeadProbe,
} from "./probing.ts";
import { ConversationUsageRecorder } from "./reasoning.ts";
import { Predecessors } from "./restatement.ts";
import {
	attachable,
	type CallerRecord,
	finished,
	ReviewIndex,
	type ReviewIndexState,
	undecided,
} from "./review-index.ts";
import { RoundsDocument, RoundWriter } from "./rounds.ts";
import { PrepareSpans } from "./spans.ts";
import { SummaryTask, summarizeExtension } from "./summarize.ts";
import { injectionAttemptRule, quoteUntrusted, reviewNonce, triageBoundary } from "./untrusted.ts";
import {
	candidateIdentity,
	startVerification,
	startWave,
	type VerificationCandidate,
	type VerificationInput,
	type VerificationResult,
	VerificationTask,
} from "./verification.ts";
import { verifierVersion } from "./verification-instructions.ts";
import { claimKey, VerificationWaves, VerificationWavesDocument } from "./verification-waves.ts";

// One lens as the lens task runs it, at one level: everything resolved, nothing left to look up. `key` names the lens
// with its version and level, so a run at one level never stands in for a run at another: it keys the task's children,
// attempts, and results, the review index's selection, and each request's ID. A run at `quick` carries `escalation`,
// whose `next` is the run the escalation rule moves it to, absent when the band's ceiling stops it there, or `cap`,
// when the next level's tier reaches no model.
interface LensRun {
	readonly key: string;
	readonly name: string;
	readonly version: string;
	readonly level: ScrutinyLevel;
	// The level's tier's models that were known with credentials when the review started, in routing order.
	readonly route: readonly ModelReference[];
	readonly thinking?: ModelRoute["thinking"];
	readonly verify?: boolean;
	readonly instructions: string;
	readonly instructionFingerprint?: string;
	readonly standardsOmitted?: boolean;
	readonly standards?: readonly string[];
	readonly tools: readonly LensToolName[];
	readonly severities: readonly Severity[];
	readonly rules: readonly LensRule[];
	readonly budget: LensBudget;
	readonly coverage: LensCoverage;
	// The change as this lens sees it: only the files it covers, with the head's functions the first call read. Outside
	// the instruction fingerprint and so the attach key: reading them is best effort, and a repeat call attaches to
	// the first call's prompt whether or not it could read them.
	readonly prompt: string;
	// Why the first call could not read the head's functions for this run, when it could not; absent from a task an
	// older Melian created, whose records carry no such note.
	readonly unread?: string;
	readonly escalation?: { readonly next?: LensRun; readonly cap?: string };
	// The band triage held the level to, as `<floor>-<ceiling>`; absent from a task an older Melian created.
	readonly band?: string;
	// A run of a level that probes. Its conversation in `children` is the planner's, which runs on `route` and records
	// the attack plan; the prober's, on `probe.route`, is created once the plan is recorded, under `<key>/prober`.
	readonly probe?: {
		readonly route: readonly ModelReference[];
		readonly thinking?: ModelRoute["thinking"];
		readonly instructions: string;
		readonly environment: ProbingEnvironment;
		// Present when the prober runs on its level's own tier, so it answers to the policy the plan judges that level by.
		readonly onLevelTier?: true;
	};
}

// The caller notes and coverage source of the call that rendered the lens instructions, kept beside them. Absent from a
// task an older Melian created, and from one a review without Enola created.
interface StoredCallers {
	readonly notes: Record<string, string[]>;
	// Why no lens saw who calls the changed code, when none did; absent from a task an older Melian created.
	readonly caveat?: string;
	readonly coverage?: CoverageSource;
}

// `escalateAt` is absent from a task an older Melian created, which escalates nothing.
interface StoredLensTaskInput {
	readonly root: ConversationId;
	readonly revision: ReviewState;
	readonly lenses: readonly LensRun[];
	readonly escalateAt?: Severity;
	readonly callers?: StoredCallers;
}

class LensTaskInput {
	readonly root: ConversationId;
	readonly revision: ReviewState;
	readonly lenses: readonly LensRun[];
	readonly escalateAt?: Severity;
	readonly callers?: StoredCallers;

	constructor(
		root: ConversationId,
		revision: ReviewState,
		lenses: readonly LensRun[],
		escalateAt?: Severity,
		callers?: StoredCallers,
	) {
		this.root = root;
		this.revision = revision;
		this.lenses = lenses;
		if (escalateAt !== undefined) this.escalateAt = escalateAt;
		if (callers !== undefined) this.callers = callers;
	}

	static upgrade(input: unknown, from: number): StoredLensTaskInput {
		const stored = input as StoredLensTaskInput;
		const lenses =
			from >= 2 ? stored.lenses : (stored.lenses.map(({ level: _, ...run }) => run) as unknown as LensRun[]);
		const callers =
			from >= 5 || stored.callers === undefined ? stored.callers : callersWithLegacyCaveat(stored.callers);
		return new LensTaskInput(stored.root, stored.revision, lenses, stored.escalateAt, callers).toJSON();
	}

	toJSON(): StoredLensTaskInput {
		return {
			root: this.root,
			revision: this.revision,
			lenses: this.lenses,
			...(this.escalateAt === undefined ? {} : { escalateAt: this.escalateAt }),
			...(this.callers === undefined ? {} : { callers: this.callers }),
		};
	}
}

// A run the escalation rule moved on names why, and the key of the run it moved to, absent when its ceiling capped it.
type LensOutcome =
	| {
			readonly status: "done";
			// The model the lens finished on, after any failover; absent from an outcome an older Melian stored.
			readonly model?: string;
			readonly budgetEnded?: StoredBudgetEnd;
			// The findings budget, when a report past it was refused.
			readonly capped?: number;
			readonly escalation?: {
				readonly trigger: EscalationTrigger;
				readonly to?: string;
				// The IDs of the findings it carried to `to`, those `to` neither restated nor refuted, and those `to` refuted.
				readonly carried?: readonly string[];
				readonly kept?: readonly string[];
				readonly refuted?: readonly string[];
			};
			readonly usage?: { models: string[]; tokens: number; cost: number };
			readonly probing?: ProbingOutcome;
	  }
	| { readonly status: "unanswered"; readonly reason: string }
	| { readonly status: "exhausted"; readonly tried: string[]; readonly reason: string };

// What a probing run's prober did: its conversation and the model it finished on, absent when the plan held no attack,
// the plan's size, the probes it ran and their time, the attacks it skipped, and those it left with neither.
type ProbingOutcome = {
	readonly prober?: ConversationId;
	readonly model?: string;
	readonly attacks: number;
	readonly probes: number;
	readonly milliseconds: number;
	readonly skipped: number;
	readonly unanswered: readonly number[];
};

type StoredTrigger = { kind: "severity"; severity: Severity } | { kind: "budget"; budget: "tokens" | "tools" };

// Why a run escalated, and the IDs of the findings at or above `escalateAt` it carried to the next run.
type StoredEscalation = { trigger: StoredTrigger; carried: string[] };

// `attempts` is each run's position in its route, committed with the model change, so a resumed review continues on
// the model it had reached rather than retrying one that already failed. `escalations` names, by the key of the run
// that escalated, why it did, committed with the conversation of the run it escalated to, so a resumed review
// continues that run rather than deciding again.
type ReviewCheckpoint = {
	phase: "review";
	children: Record<string, ConversationId>;
	attempts: Record<string, number>;
	escalations?: Record<string, StoredEscalation>;
};

type LensCheckpoint = { phase: "spawn" } | ReviewCheckpoint;

// `prober` names a probing run's prober conversation whatever the run's outcome, so a finding it reported before the
// run failed still reaches its verifier with its probe.
type LensResult = Record<
	string,
	LensOutcome & { readonly conversation?: ConversationId; readonly prober?: ConversationId }
>;

function modelName(model: ModelReference): string {
	return `${model.provider}/${model.modelId}`;
}

const continuePrompt =
	"The model reviewing this change failed, and you take over. Continue the review where it stopped: findings already recorded stay recorded, so report only what is still missing. Then answer with one line saying how many findings you reported.";

// Creates one lens's conversation, owned by the lens task, and writes its policy on it.
async function spawnLens(tx: Tx, taskId: TaskId, input: StoredLensTaskInput, lens: LensRun): Promise<ConversationId> {
	const created = await tx.createConversation({ ownership: { kind: "task", taskId } });
	// An owned conversation starts with its owner's tools and extensions, so both are explicit. Selecting only the lens
	// extension puts its injection policy section first, ahead of the instructions.
	const tools = [
		...lens.tools.map((tool) => lensListedTools[tool]),
		reportFinding,
		...(lens.probe === undefined ? [] : [recordPlan]),
	];
	// A task an older Melian created and a crash left in this phase holds only the findings budget, as a number.
	const stored = lens.budget as LensBudget | number;
	const budget = typeof stored === "number" ? { findings: stored } : stored;
	await configure(tx, created.id, {
		model: lens.route[0],
		thinkingLevel: lens.thinking,
		instructions: lens.instructions,
		tools,
		extensions: [lensExtension],
	});
	(await tx.doc(LensDocument, created.id)).lens = lensPolicy(taskId, input, lens, budget);
	return created.id;
}

// The policy a lens conversation runs under, which its tools enforce: the planner's for a run that probes.
function lensPolicy(
	taskId: TaskId,
	input: StoredLensTaskInput,
	lens: LensRun,
	budget: LensBudget,
	role?: "prober",
): LensPolicy {
	return {
		name: lens.name,
		version: lens.version,
		...(lens.probe === undefined ? {} : { role: role ?? "planner" }),
		...(role === "prober" && lens.probe !== undefined ? { probing: structuredClone(lens.probe.environment) } : {}),
		// A run of a version 1 task has no level, since its migration strips it, so its findings name the lens's version
		// alone, as the review that created it expects.
		...((lens.level as ScrutinyLevel | undefined) === undefined ? {} : { level: lens.level }),
		review: input.root,
		revision: input.revision,
		tools: [...lens.tools],
		severities: [...lens.severities],
		rules: lens.rules.map((rule) => ({ ...rule })),
		budget: budget.findings,
		task: taskId,
		limits: {
			...(budget.tokens === undefined ? {} : { tokens: budget.tokens }),
			...(budget.tools === undefined ? {} : { tools: budget.tools }),
		},
		coverage: {
			scope: lens.coverage.scope,
			paths: [...lens.coverage.paths],
			nearer: [...lens.coverage.nearer],
			...(lens.coverage.moved === undefined ? {} : { moved: [...lens.coverage.moved] }),
		},
		...(input.callers?.coverage === undefined
			? {}
			: { graph: { root: input.callers.coverage.root, parts: structuredClone(input.callers.coverage.parts) } }),
	};
}

// Creates a probing run's prober conversation, which reads the plan alone, and gives it a copy of the plan.
async function spawnProber(
	tx: Tx,
	taskId: TaskId,
	input: StoredLensTaskInput,
	lens: LensRun,
	plan: readonly Attack[],
): Promise<ConversationId> {
	const probe = lens.probe!;
	const created = await tx.createConversation({ ownership: { kind: "task", taskId } });
	await configure(tx, created.id, {
		model: probe.route[0],
		thinkingLevel: probe.thinking,
		instructions: probe.instructions,
		tools: [...lens.tools.map((tool) => lensListedTools[tool]), reportFinding, runProbe, skipAttack],
		extensions: [lensExtension],
	});
	(await tx.doc(LensDocument, created.id)).lens = lensPolicy(taskId, input, lens, lens.budget, "prober");
	(await tx.doc(ProbingDocument, created.id)).plan = plan.map((attack) => ({ ...attack }));
	return created.id;
}

// A crash between replacing and aborting a task leaves live work behind. Pi cannot abort inside a commit, so sweep before resume.
async function abortReplacedRuns(harness: Harness, context: Context): Promise<void> {
	const { tasks } = await harness.inspect(context);
	const live = tasks.filter((task) =>
		[LensTask.definition.name, VerificationTask.definition.name].includes(task.record.kind),
	);
	const decisions = tasks.filter(
		(task) => task.record.kind === decisionTaskName && task.record.state.status !== "terminal",
	);
	const adjudications = tasks.filter(
		(task) => task.record.kind === AdjudicationTask.definition.name && task.record.state.status !== "terminal",
	);
	if (live.length === 0 && decisions.length === 0 && adjudications.length === 0) return;
	const root = await harness.root(context);
	const index = await harness.snapshot(ReviewIndex, root.id, context);
	const waves = await harness.snapshot(VerificationWavesDocument, root.id, context);
	for (const { record } of live) {
		const input = record.input as unknown as StoredLensTaskInput;
		const entry = index?.reviews[Revision.key(input.revision)];
		// An entry with no task is one a review that selected no lens rewrote: it names no run at all.
		const replaced =
			record.kind === VerificationTask.definition.name
				? !VerificationWaves.owns(index, waves, Revision.key(input.revision), record.id)
				: entry !== undefined && entry.task !== record.id;
		// An older entry lacks a level or route, so no current selection can attach to its lens task.
		const stale =
			record.kind === LensTask.definition.name &&
			entry !== undefined &&
			entry.lenses.length > 0 &&
			entry.lenses.every((lens) => !/^[^@\s]+@[^@\s]+@[^@\s]+ .*\bon /.test(lens));
		if (replaced || stale) await harness.abortTask(record.id, context);
	}
	for (const { record } of adjudications) {
		const input = record.input as unknown as AdjudicationTaskInput;
		if (index?.reviews[Revision.key(input)]?.adjudication?.task !== record.id) {
			await harness.abortTask(record.id, context);
		}
	}
	for (const { record } of decisions) {
		const input = record.input as unknown as DecisionTaskInput;
		const named = await readRecordedDecision(
			harness,
			input.root,
			input.revision,
			input.request.questionSet.name,
			context,
		);
		// A harness opened without the decider has no definition to abort through; the task stays blocked, and unnamed.
		if (named?.task !== record.id) await harness.abortTask(record.id, context).catch(() => undefined);
	}
}

// Whether the review index names another lens task, or none, for the task's revision: a later review replaced this run.
async function superseded(
	reader: DocumentReader,
	input: StoredLensTaskInput,
	taskId: number,
	context: Context,
): Promise<boolean> {
	const entry = (await reader.snapshot(ReviewIndex, input.root, context))?.reviews[Revision.key(input.revision)];
	return entry !== undefined && entry.task !== taskId;
}

// Spawns every lens conversation in one commit, so a crash leaves all of them or none; then runs them in parallel.
// A lens the escalation rule moves to its next level gets a conversation of its own, created in the commit that
// records why, and runs there. The orchestrating conversation's model is never asked which lenses to run.
const LensTask = defineTask<StoredLensTaskInput, LensCheckpoint, LensResult>({
	name: "melian.lenses",
	// Version 2 added escalation: a run's `escalation`, the input's `escalateAt`, the checkpoint's `escalations`, and an
	// outcome's `escalation`. A version 1 task holds none of them, and runs as it did. Its runs lose their `level`, so
	// its findings name the lens's version alone, as its review's producers do, and never share a producer with a review
	// after the upgrade that runs the lens at the same level.
	// Version 3 records each run's standards paths; older runs leave them absent. Version 4 changed no stored shape.
	// Version 5 lets the input's callers name a caveat; an older input names none. Version 6 lets a run probe, with the
	// prober's conversation in the checkpoint under `<key>/prober` and what it did in the outcome's `probing`; an older
	// task's runs probe nothing.
	version: 6,
	initial: () => ({ phase: "spawn" }),
	migrate: (input, checkpoint, from) => ({
		input: LensTaskInput.upgrade(input, from),
		checkpoint: checkpoint as unknown as LensCheckpoint,
	}),
	phases: {
		spawn: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const children: Record<string, ConversationId> = {};
				for (const lens of task.input.lenses)
					children[lens.key] = await spawnLens(tx, runtime.taskId, task.input, lens);
				const attempts = Object.fromEntries(Object.keys(children).map((key) => [key, 0]));
				return { status: "running", checkpoint: { phase: "review", children, attempts } };
			}, context);
		},
		review: async (task, runtime, context) => {
			const started = task.state.checkpoint as ReviewCheckpoint;
			const { input } = task;
			const rule = input.escalateAt === undefined ? undefined : new EscalationRule(input.escalateAt);
			const revision = Revision.key(input.revision);
			// One conversation of a run on `route`, from the attempt a crash left it at under `key`. A request ID per
			// attempt: a rerun after a crash finds the attempt it had reached, settled or not.
			const converse = async (
				key: string,
				route: readonly ModelReference[],
				id: ConversationId,
				prompt: string,
			): Promise<{ readonly status: "done"; readonly model: string } | Exclude<LensOutcome, { status: "done" }>> => {
				const child = (await runtime.conversation(id, context))!;
				for (let attempt = started.attempts[key] ?? 0; ; attempt++) {
					// A task a later review replaced asks no model again, even when a resume restarts it.
					if (await superseded(runtime, input, runtime.taskId, context)) {
						return { status: "unanswered", reason: "a later review of this revision replaced this run" };
					}
					const content = attempt === 0 ? prompt : continuePrompt;
					const request = { type: "input", content, requestId: `lens:${key}:${attempt}` } as const;
					const settled = await (await child.submit(request, context)).wait(context);
					if (settled.status === "done") return { status: "done", model: modelName(route[attempt]!) };
					const reason = unsettled(settled);
					const failover =
						settled.reason === "no_model" || (settled.reason === "model_error" && isFailoverError(reason));
					if (!failover) return { status: "unanswered", reason };
					const next = route[attempt + 1];
					if (next === undefined) {
						const tried = route.slice(0, attempt + 1).map(modelName);
						return { status: "exhausted", tried, reason };
					}
					await runtime.commit(async (tx, current) => {
						await configure(tx, id, { model: next });
						const checkpoint = current.state.checkpoint as ReviewCheckpoint;
						return {
							status: "running",
							checkpoint: { ...checkpoint, attempts: { ...checkpoint.attempts, [key]: attempt + 1 } },
						};
					}, context);
				}
			};
			// One more input to a conversation that finished without what its role owes, under a request ID of its own. A
			// reminder that does not finish ends the lens, so what its conversation did before it failed never stands as done.
			const remind = async (
				id: ConversationId,
				content: string,
				requestId: string,
				which: string,
			): Promise<Exclude<LensOutcome, { status: "done" }> | undefined> => {
				const child = (await runtime.conversation(id, context))!;
				const settled = await (await child.submit({ type: "input", content, requestId }, context)).wait(context);
				if (settled.status === "done") return undefined;
				return { status: "unanswered", reason: `${which} did not finish: ${unsettled(settled)}` };
			};
			// The attack numbers the prober answered with neither a probe nor a skip.
			const unanswered = async (prober: ConversationId, attacks: number): Promise<number[]> => {
				const state = (await runtime.snapshot(ProbingDocument, prober, context)) ?? {};
				const probed = new Set(Object.values(state.probes ?? {}).map((probe) => probe.attack));
				return Array.from({ length: attacks }, (_, index) => index + 1).filter(
					(attack) => !probed.has(attack) && state.skips?.[String(attack)] === undefined,
				);
			};
			// A probing run after its planner finished: the plan it recorded, then the prober's answer to it.
			// `carried` lists the findings a quick run carried, which the prober may refute with a probe that passes.
			const probe = async (
				lens: LensRun,
				planner: ConversationId,
				carried: string | undefined,
			): Promise<ProbingOutcome | Exclude<LensOutcome, { status: "done" }>> => {
				const planOf = async () => (await runtime.snapshot(ProbingDocument, planner, context))?.plan;
				let plan = await planOf();
				if (plan === undefined && (await budgetEnded(runtime, planner, context)) === undefined) {
					const failed = await remind(
						planner,
						recordPlanPrompt,
						`lens:${lens.key}:plan`,
						"the planner's reminder",
					);
					if (failed !== undefined) return failed;
					plan = await planOf();
				}
				if (plan === undefined) return { status: "unanswered", reason: "the planner recorded no attack plan" };
				const key = `${lens.key}/prober`;
				let prober = started.children[key];
				if (prober === undefined) {
					await runtime.commit(async (tx, current) => {
						// The plan as this commit reads it is the one the prober gets, or the empty one the level ends with, and a
						// reminder the planner may still be answering after a crash can no longer replace it.
						const planned = await tx.doc(ProbingDocument, planner);
						const checkpoint = current.state.checkpoint as ReviewCheckpoint;
						prober = checkpoint.children[key];
						if (prober !== undefined) return undefined;
						planned.frozen = true;
						plan = planned.plan!.map((attack) => ({ ...attack }));
						if (plan.length === 0) return undefined;
						prober = await spawnProber(tx, runtime.taskId, input, lens, plan);
						return {
							status: "running",
							checkpoint: {
								...checkpoint,
								children: { ...checkpoint.children, [key]: prober },
								attempts: { ...checkpoint.attempts, [key]: 0 },
							},
						};
					}, context);
				}
				if (plan.length === 0) return { attacks: 0, probes: 0, milliseconds: 0, skipped: 0, unanswered: [] };
				const plain = renderPlan(plan, input.revision.nonce);
				const answered = await converse(
					key,
					lens.probe!.route,
					prober!,
					carried === undefined ? plain : `${plain}\n\n${carried}`,
				);
				if (answered.status !== "done") return answered;
				let open = await unanswered(prober!, plan.length);
				if (open.length > 0 && (await budgetEnded(runtime, prober!, context)) === undefined) {
					const failed = await remind(prober!, answerPrompt(open), `lens:${key}:answer`, "the prober's reminder");
					if (failed !== undefined) return failed;
					open = await unanswered(prober!, plan.length);
				}
				const state = (await runtime.snapshot(ProbingDocument, prober!, context)) ?? {};
				const probes = Object.values(state.probes ?? {});
				return {
					prober: prober!,
					model: answered.model,
					attacks: plan.length,
					probes: probes.length,
					milliseconds: probes.reduce((sum, each) => sum + each.milliseconds, 0),
					// An attack skipped and then probed was probed.
					skipped: Object.keys(state.skips ?? {}).filter(
						(attack) => !probes.some((probe) => probe.attack === Number(attack)),
					).length,
					unanswered: open,
				};
			};
			// One run: its conversation, and for a level that probes, its planner's then its prober's.
			const run = async (
				lens: LensRun,
				id: ConversationId,
				prompt: string,
				carried?: string,
			): Promise<LensOutcome> => {
				const planned = await converse(lens.key, lens.route, id, prompt);
				if (planned.status !== "done") return planned;
				const probed = lens.probe === undefined ? undefined : await probe(lens, id, carried);
				if (probed !== undefined && "status" in probed) return probed;
				const conversations = [id, ...(probed?.prober === undefined ? [] : [probed.prober])];
				let ended: StoredBudgetEnd | undefined;
				let refused: number | undefined;
				const spends: (readonly [string, { totalTokens: number; cost: { total: number } }])[] = [];
				for (const conversation of conversations) {
					ended ??= await budgetEnded(runtime, conversation, context);
					refused ??= await findingsCapped(runtime, conversation, context);
					spends.push(...Object.entries((await runtime.snapshot(UsageDoc, conversation, context))?.models ?? {}));
				}
				// A refused report is the evidence a lens wanted more, and a lens told its budget stops at it without
				// asking, so a run that reached its budget counts as capped too.
				const budget = typeof lens.budget === "number" ? lens.budget : lens.budget.findings;
				const capped = refused ?? ((await sighted(lens)).length >= budget ? budget : undefined);
				const usage = {
					models: [...new Set(spends.map(([model]) => model))],
					tokens: spends.reduce((sum, [, item]) => sum + item.totalTokens, 0),
					cost: spends.reduce((sum, [, item]) => sum + item.cost.total, 0),
				};
				return {
					status: "done",
					model: planned.model,
					usage,
					...(ended === undefined ? {} : { budgetEnded: ended }),
					...(capped === undefined ? {} : { capped }),
					...(probed === undefined ? {} : { probing: probed }),
				};
			};
			const sighted = async (lens: LensRun) => {
				const findings = await runtime.snapshot(FindingsDocument, input.root, context);
				const source = lensSource(lens.name, lens.version, lens.level);
				return findings === undefined ? [] : sightedBy(findings, revision, source);
			};
			// Why a finished run escalates, and the findings it carries to the next run, from what it reported at this
			// revision and the budget that ended it, read from durable state, so a rerun after a crash decides alike.
			const escalationOf = async (lens: LensRun, outcome: LensOutcome): Promise<StoredEscalation | undefined> => {
				if (rule === undefined || lens.escalation === undefined || outcome.status !== "done") return undefined;
				const decided = started.escalations?.[lens.key];
				if (decided !== undefined) return decided;
				const reported = await sighted(lens);
				const budget = outcome.budgetEnded?.budget;
				const trigger = rule.trigger({
					level: lens.level,
					severities: reported.map((finding) => finding.severity),
					...(budget === undefined ? {} : { budgetEnded: budget }),
				});
				if (trigger === undefined) return undefined;
				const carried = reported.filter((finding) => rule.reaches(finding.severity)).map((finding) => finding.id);
				return { trigger: { ...trigger }, carried };
			};
			// A lens's first run, then the run the escalation rule moves it to. The escalated run is asked to confirm or
			// refute each severe finding the first reported; one it does neither stays, attributed to the first run.
			const chain = async (first: LensRun): Promise<[string, LensOutcome][]> => {
				const outcome = await run(first, started.children[first.key]!, first.prompt);
				const escalation = await escalationOf(first, outcome);
				const next = first.escalation?.next;
				if (escalation === undefined || outcome.status !== "done") return [[first.key, outcome]];
				const { trigger } = escalation;
				if (next === undefined) return [[first.key, { ...outcome, escalation: { trigger } }]];
				let child = started.children[next.key];
				if (child === undefined) {
					await runtime.commit(async (tx, current) => {
						const checkpoint = current.state.checkpoint as ReviewCheckpoint;
						child = checkpoint.children[next.key];
						if (child !== undefined) return undefined;
						child = await spawnLens(tx, runtime.taskId, input, next);
						return {
							status: "running",
							checkpoint: {
								...checkpoint,
								children: { ...checkpoint.children, [next.key]: child },
								attempts: { ...checkpoint.attempts, [next.key]: 0 },
								escalations: { ...checkpoint.escalations, [first.key]: escalation },
							},
						};
					}, context);
				}
				const carried = (await sighted(first)).filter((finding) => escalation.carried.includes(finding.id));
				const listed = carried.length === 0 ? undefined : carriedFindings(carried, input.revision.nonce);
				const prompt = listed === undefined ? next.prompt : `${next.prompt}\n\n${listed}`;
				const rerun = await run(next, child!, prompt, listed);
				const prober = rerun.status === "done" ? rerun.probing?.prober : undefined;
				// A probing level's planner may neither restate nor refute a carried finding: only what its prober reported
				// stands for one. Each conversation's lens document names the findings it reported.
				const reportedIn = async (conversation: ConversationId) =>
					Object.keys((await runtime.snapshot(LensDocument, conversation, context))?.spend?.reports ?? {});
				const planned = next.probe === undefined ? [] : await reportedIn(child!);
				const probed = prober === undefined ? [] : await reportedIn(prober);
				// A restatement is the same finding by its ID, or by its file, rule, and overlapping lines, since a run that
				// reported other lines of one defect hashes another snippet.
				const higher = (await sighted(next)).filter(
					(each) => !planned.includes(each.id) || probed.includes(each.id),
				);
				const restates = (finding: SightedFinding) =>
					higher.some((each) => each.id === finding.id || overlapsSite(each, finding));
				const restated = new Set(carried.filter(restates).map((finding) => finding.id));
				const refuting = [child!, ...(prober === undefined ? [] : [prober])];
				const reported: string[] = [];
				for (const conversation of refuting)
					reported.push(...((await runtime.snapshot(LensDocument, conversation, context))?.spend?.refuted ?? []));
				const refuted = reported.filter((id) => escalation.carried.includes(id) && !restated.has(id));
				const kept = escalation.carried.filter((id) => !restated.has(id) && !refuted.includes(id));
				const moved = { trigger, to: next.key, carried: escalation.carried, kept, refuted };
				return [
					[first.key, { ...outcome, escalation: moved }],
					[next.key, rerun],
				];
			};
			// Each lens's end is recorded as it happens, so the review can verify its claims while slower lenses run. Only
			// while the index names this task: a replaced run's ends start nothing.
			const chains = await Promise.all(
				input.lenses.map(async (first) => {
					const ended = await chain(first);
					await runtime.commit(async (tx, current) => {
						if ((await tx.doc(ReviewIndex, input.root)).reviews[revision]?.task !== runtime.taskId)
							return undefined;
						const { children } = current.state.checkpoint as ReviewCheckpoint;
						const entry = await VerificationWaves.open(tx, input.root, revision, runtime.taskId);
						for (const [key, outcome] of ended)
							entry.ended[key] = {
								...outcome,
								...(children[key] === undefined ? {} : { conversation: children[key] }),
							} as unknown as JsonObject;
						return undefined;
					}, context);
					return ended;
				}),
			);
			await runtime.commit(async (tx) => {
				const checkpoint = (await tx.task(runtime.taskId))!.state.checkpoint as ReviewCheckpoint;
				const result = Object.fromEntries(
					chains.flat().map(([key, outcome]) => {
						const prober = checkpoint.children[`${key}/prober`];
						return [
							key,
							{
								...outcome,
								conversation: checkpoint.children[key],
								...(prober === undefined ? {} : { prober }),
							},
						];
					}),
				);
				return { status: "terminal", outcome: { status: "completed", result } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/**
 * The extension a review harness needs, with probes run under `sandbox`, sandbox-runtime when absent: the lens task, the
 * lens tools, `report_finding`, the probing level's tools, the hook that holds each lens to its policy, and the
 * verification and adjudication tasks.
 */
export function createLensExtension(sandbox?: ProbeSandbox) {
	return defineExtension({
		name: "melian.lenses",
		tools: [
			...Object.values(lensListedTools),
			reportFinding,
			reportVerdict,
			recordPlan,
			sandbox === undefined ? runProbe : runProbeTool(sandbox),
			skipAttack,
		],
		sections: [injectionPolicySection],
		hooks: [lensPolicyHook],
		tasks: [LensTask, VerificationTask, AdjudicationTask, probeRerunTask(sandbox)],
	});
}

/**
 * The extension a review harness needs, with probes under sandbox-runtime. {@link ReviewHarness} installs it; a host
 * building its own registry installs it there.
 */
export const lensExtension = createLensExtension();

/**
 * A registry holding the lens extension, with probes under sandbox-runtime, the sandbox a review over a harness built
 * from it checks and reruns probes under. {@link ReviewHarness} takes another.
 */
export function createReviewRegistry(): Registry {
	return reviewRegistry();
}

function reviewRegistry(sandbox?: ProbeSandbox): Registry {
	const registry = createRegistry();
	registry.install(sandbox === undefined ? lensExtension : createLensExtension(sandbox));
	registry.install(summarizeExtension);
	return registry;
}

/** What {@link ReviewHarness.open} installs beside the lens extension. */
export interface ReviewHarnessOptions {
	readonly retry?: boolean;
	readonly checkout?: string;
	/** The host's environment, whose GitHub token the checks download pinned tools with. Without it, they send none. */
	readonly environment?: NodeJS.ProcessEnv;
	/** The decider triage asks, installed as `decisionExtension`; without it, every lens runs at its default level. */
	readonly decider?: Decider;
	/** The sandbox probes run under, sandbox-runtime when absent; a test passes its own. */
	readonly probeSandbox?: ProbeSandbox;
}

/**
 * A durable harness that runs reviews over one changeset's storage, with {@link lensExtension} installed. Pass this
 * wrapper to `reviewChangeset` for automatic checks, and its `harness` to `runChecks` and `readVerdict`. Closing it
 * closes the storage.
 */
export class ReviewHarness {
	/** Pi's harness, which the review functions take. */
	readonly harness: Harness;
	/** Whether this harness holds the checks extension and an execution environment. */
	readonly checksAvailable: boolean;
	/** The sandbox its probes run under, when it is not sandbox-runtime. */
	readonly probeSandbox: ProbeSandbox | undefined;

	private constructor(harness: Harness, checksAvailable: boolean, probeSandbox: ProbeSandbox | undefined) {
		this.harness = harness;
		this.checksAvailable = checksAvailable;
		this.probeSandbox = probeSandbox;
	}

	/**
	 * Opens one over `storage`, with models from `models`. Pass `retry: false` to fail a model request at once rather
	 * than retry it with backoff, as tests and scripted evals do. Pass `checkout`, the repository's working directory, to
	 * run the deterministic checks too: it installs `checksExtension` and a Node execution environment there, which
	 * `runChecks` needs for the static tools. Pass `decider` to triage through it: it installs `decisionExtension`, and
	 * `reviewChangeset` then takes the same decider. A failed open closes `storage`.
	 */
	static async open(
		storage: Storage,
		models: ReviewModels,
		options: ReviewHarnessOptions = {},
		context: Context = backgroundContext,
	): Promise<ReviewHarness> {
		const settings = options.retry === false ? { settings: { retry: { enabled: false } } } : {};
		const { checkout, decider, probeSandbox } = options;
		const registry = reviewRegistry(probeSandbox);
		if (checkout !== undefined) registry.install(checksExtensionFor(options.environment ?? {}));
		if (decider !== undefined) registry.install(decisionExtension(decider));
		const env = checkout === undefined ? {} : { env: () => createNodeExecutionEnv(checkout) };
		const recorder = new ConversationUsageRecorder(storage);
		const harness = await openHarness(
			storage,
			{ models: recorder.models(modelsOf(models)), registry, ...env, ...settings },
			context,
		).catch(async (error: unknown) => {
			// Pi closes the storage only once it has built a harness; an open refused before that leaves it to us.
			await storage.close(backgroundContext).catch(() => undefined);
			throw error;
		});
		recorder.attach(harness);
		await abortReplacedRuns(harness, context);
		// A walkthrough never outlives its process: a review resolves its light route only later, and any wait before that
		// would resume one on the old route. The summariser creates its own task.
		for (const { record } of (await harness.inspect(context)).tasks)
			if (record.kind === SummaryTask.definition.name) await harness.abortTask(record.id, context);
		return new ReviewHarness(harness, checkout !== undefined, probeSandbox);
	}

	/**
	 * Providers a live model task can still call when the harness resumes. A lens or verifier route counts from the
	 * attempt its checkpoint reached, so a provider it already failed over from stays locked; a lens run whose escalation
	 * is decided is finished, and an escalation run counts only when the task escalates.
	 */
	async resumedProviders(context: Context = backgroundContext): Promise<string[]> {
		const { tasks } = await this.harness.inspect(context);
		const providers = tasks.flatMap(({ record }) => {
			const checkpoint = (record.state as { checkpoint?: unknown }).checkpoint;
			if (record.kind === LensTask.definition.name) {
				const input = record.input as unknown as StoredLensTaskInput;
				const started =
					(checkpoint as LensCheckpoint | undefined)?.phase === "review"
						? (checkpoint as ReviewCheckpoint)
						: undefined;
				// A probing run's prober counts too, from its own attempt.
				const remaining = (run: LensRun) => [
					...run.route.slice(started?.attempts[run.key] ?? 0),
					...(run.probe?.route.slice(started?.attempts[`${run.key}/prober`] ?? 0) ?? []),
				];
				return input.lenses.flatMap((first) => {
					const next = input.escalateAt === undefined ? undefined : first.escalation?.next;
					const finished = started?.escalations?.[first.key] !== undefined;
					return [...(finished ? [] : remaining(first)), ...(next === undefined ? [] : remaining(next))].map(
						(model) => model.provider,
					);
				});
			}
			if (record.kind === VerificationTask.definition.name) {
				const input = record.input as unknown as VerificationInput;
				const attempts = (checkpoint as { attempts?: Record<string, number> } | undefined)?.attempts;
				// A reused candidate has no conversation, so the task never calls its route.
				const asked = input.candidates.filter((candidate) => input.reused?.[candidate.key] === undefined);
				return asked.flatMap((candidate) =>
					candidate.route.slice(attempts?.[candidate.key] ?? 0).map((model) => model.provider),
				);
			}
			if (record.kind === decisionTaskName) {
				const { key } = record.input as unknown as DecisionTaskInput;
				const { decider } = JSON.parse(key) as { decider: string };
				return /^llm-fallback:([^/]+)\//.exec(decider)?.slice(1) ?? [];
			}
			return [];
		});
		return [...new Set(providers)];
	}

	/** Whether a live task may ask a model when the harness resumes. */
	async resumesModels(context: Context = backgroundContext): Promise<boolean> {
		const { tasks } = await this.harness.inspect(context);
		return tasks.some(({ record }) =>
			[LensTask.definition.name, VerificationTask.definition.name, decisionTaskName].includes(record.kind),
		);
	}

	/** Closes the harness and its storage. Idempotent. */
	close(context: Context = backgroundContext): Promise<void> {
		return this.harness.close(context);
	}
}

/** Opens a {@link ReviewHarness} over `storage`, as {@link ReviewHarness.open} does. */
export function openReviewHarness(
	storage: Storage,
	models: ReviewModels,
	options: ReviewHarnessOptions = {},
	context: Context = backgroundContext,
): Promise<ReviewHarness> {
	return ReviewHarness.open(storage, models, options, context);
}

const maxPromptBytes = 200 * 1024;

/**
 * The input a lens receives: the revision, the files it changes, and its zero-context diff, bounded. Everything from
 * the head enters inside `quoteUntrusted` boundaries carrying the review's `nonce`: the file list as one listing, and
 * each file's diff as its own block whose first line is the file's path and status, so a changed line cannot pose as
 * another file's header. Paths are escaped with core's `visibleText`, so a newline in one cannot forge a line.
 */
export class ChangePrompt {
	readonly changeset: Changeset;
	readonly nonce: string;

	constructor(changeset: Changeset, nonce: string) {
		this.changeset = changeset;
		this.nonce = nonce;
	}

	/**
	 * The prompt, limited to the files `only` names when given, matching a renamed file by its old path or its new one.
	 * With `tools: false`, for a reader with no tools such as a decider, it does not tell the reader to read the head.
	 */
	render(
		only?: readonly string[],
		options: { readonly tools?: boolean; readonly functions?: EnclosingFunctions } = {},
	): string {
		return this.renderInput(only, options).text;
	}

	/** The bounded prompt and whether its size limit omitted any file's diff. */
	renderInput(
		only?: readonly string[],
		options: { readonly tools?: boolean; readonly functions?: EnclosingFunctions } = {},
	): { readonly text: string; readonly cut: boolean } {
		const { nonce } = this;
		const { base, head } = this.changeset.revision;
		const files = this.changeset.revision.files.filter(
			(file) =>
				only === undefined ||
				only.includes(file.path) ||
				(file.oldPath !== undefined && only.includes(file.oldPath)),
		);
		const named = (file: (typeof files)[number]) =>
			`${file.oldPath === undefined ? "" : `${visibleText(file.oldPath)} -> `}${visibleText(file.path)}`;
		const header = [
			`Review the change from ${base.slice(0, 12)} to ${head.slice(0, 12)}.`,
			"",
			"Files changed:",
			quoteUntrusted("listing", files.map((file) => `${file.status} ${named(file)}`).join("\n"), nonce),
			"",
			`Each file's diff follows in its own block, whose first line names the file. The diff has no context lines.${options.tools === false ? "" : " Read the head revision with read_file for the code around each hunk."}`,
		].join("\n");
		const parts = [header];
		let size = Buffer.byteLength(header);
		let cut = false;
		for (const file of files) {
			const hunks = file.binary ? ["(binary)"] : file.hunks.map((hunk) => `${hunk.header}\n${hunk.text}`);
			const part = quoteUntrusted("diff", [`${named(file)} (${file.status})`, ...hunks].join("\n"), nonce);
			size += Buffer.byteLength(part);
			if (size > maxPromptBytes) {
				cut = true;
				parts.push(
					options.tools === false
						? "[The diff continues; the remaining files are omitted.]"
						: "[The diff continues; read the remaining files with read_file.]",
				);
				break;
			}
			parts.push(part);
		}
		// The functions follow the diff, past its limit, so a cut diff never costs a function, and a function never a hunk.
		if (cut && options.functions !== undefined) parts.push(cutDiffNote);
		if (!cut && options.functions !== undefined)
			parts.push(
				...options.functions.blocks(
					files.map((file) => file.path),
					nonce,
				),
			);
		return { text: parts.join("\n\n"), cut };
	}
}

// A model tier's route as a review can run it: the tier's model and fallbacks that the collection knows and holds
// credentials for, in routing order, or why there are none.
type TierRoute = { readonly route: ModelReference[] } | { readonly unrouted: string };

async function routeOf(level: LevelRoute, review: ReviewModels): Promise<TierRoute> {
	const models = modelsOf(review);
	let route: ReturnType<typeof resolveModelRoute>;
	try {
		route = resolveModelRoute(level.route, level.tier, level.at, level.noun);
	} catch (error) {
		if (error instanceof ModelRoutingError) return { unrouted: error.message };
		throw error;
	}
	const available: ModelReference[] = [];
	for (const candidate of [route.model, ...route.fallbacks]) {
		if (models.getModel(candidate.provider, candidate.modelId) === undefined) continue;
		if (await hasCredentials(review, candidate.provider)) available.push(candidate);
	}
	if (available.length > 0) return { route: available };
	const tried = [route.model, ...route.fallbacks].map(modelName).join(", ");
	return { unrouted: `none of ${tried} is known with credentials` };
}

// The route one level of a lens runs on, keyed so that levels sharing a route resolve it once: the lens's own route
// where it names one, as the plan resolved it for that level, or else its tier's. `on` names it in a message, and
// `refused` says the plan refuses the level there.
class LevelRoute {
	readonly key: string;
	readonly on: string;
	readonly tier: string;
	readonly at: string;
	readonly noun: string;
	readonly route: ModelRoute | undefined;
	readonly refused: boolean;

	private constructor(fields: Omit<LevelRoute, never>) {
		this.key = fields.key;
		this.on = fields.on;
		this.tier = fields.tier;
		this.at = fields.at;
		this.noun = fields.noun;
		this.route = fields.route;
		this.refused = fields.refused;
	}

	static of(lens: Lens, level: ScrutinyLevel, config: MelianConfig, plan: ReviewPlan | undefined): LevelRoute {
		const at = `lenses.${lens.name}.route`;
		const planned = plan?.lensRoute(lens.name, lens.scope, level);
		if (plan !== undefined && planned !== undefined) {
			const [first, ...rest] =
				planned.status === "routed" || planned.status === "uncredentialed" ? planned.models : [];
			return new LevelRoute({
				key: `${at} ${lens.scope} ${level}`,
				on: at,
				tier: at,
				at,
				noun: at,
				route: {
					...(planned.thinking === undefined ? {} : { thinking: planned.thinking }),
					...(first === undefined ? {} : { model: first.model, fallbacks: rest.map(({ model }) => model) }),
				},
				refused: plan.judge(lens.name, level, undefined, lens.scope).refusal !== undefined,
			});
		}
		const own = Object.hasOwn(config.lenses, lens.name) ? config.lenses[lens.name]!.route : undefined;
		if (plan === undefined && own !== undefined) {
			return new LevelRoute({
				key: `${at} ${lens.scope}`,
				on: at,
				tier: at,
				at,
				noun: at,
				route: own,
				refused: false,
			});
		}
		return LevelRoute.ofTier(lens.level(level).tier, config, plan);
	}

	static ofTier(tier: LensTier, config: MelianConfig, plan: ReviewPlan | undefined): LevelRoute {
		return new LevelRoute({
			key: tier,
			on: tier,
			tier,
			at: `models.${tier}`,
			noun: `the ${tier} tier`,
			route: config.models[tier],
			refused: plan?.refusal(tier) !== undefined,
		});
	}
}

// Why a lens that reads functions got none in its prompt: it reads them with read_file, as its instructions say.
function unreadFunctions(reason: string): string {
	return `the head's functions could not be read (${reason}), so it read them with read_file`;
}

// The error for a lens that has no level it may run at, with `why` from `lens.unrunnable`.
function noLevel(name: string, band: LevelBand, why: string): ReviewError {
	return new ReviewError(
		"noAvailableModel",
		`lens ${name} may run from ${band.floor} to ${band.ceiling}, and no level there can run: ${why}. Route the tier in melian.local.yaml, log in with pi, or set the provider's API key`,
		{ lenses: [name] },
	);
}

// The options as the plan shapes them: each tier routed as the plan resolved it, and the host's records of lenses left
// out, which the lens step owns. The plan refuses a lens later, for the tier of the level triage chose for it.
function planned(options: ReviewOptions): ReviewOptions {
	const checks = (options.checks ?? []).filter((check) => !check.name.startsWith("lens."));
	const { plan } = options;
	if (plan === undefined) return { ...options, checks };
	return { ...options, config: { ...options.config, models: plan.routes() }, checks };
}

/**
 * Every fixed input a probing run's planner and prober receive, as this build holds them: each role tool's name,
 * description and schema, the fixed limits, the wording table, and each prompt rendered over fixed samples, which holds
 * how it is put together. A release that changes any of them runs the level again; the plan and its earlier findings,
 * which move between reviews of one head, stay out.
 */
export function probingProtocol(runner: unknown = probeRunnerSample()): string {
	return JSON.stringify({
		tools: [recordPlan, runProbe, skipAttack, reportFinding].map(({ name, description, parameters }) => ({
			name,
			description,
			parameters,
		})),
		roles: roleTools,
		limits: { probing: probingLimits, probe: probeLimits, head: headTreeLimits, earlier: earlierLimits },
		renderings: probingRenderings().prompts,
		runner,
		// The findings a quick run carries reach the planner and the prober too.
		wording: probingWording,
	});
}

// Each lens that finished, by name, to the scope of each variant that ran and the model it finished on, so its lineage
// names the model that ran.
function ranOn(
	lenses: readonly LensRun[],
	result: LensResult | undefined,
): Map<string, { scope: string; version: string; level: ScrutinyLevel; model: string }[]> {
	const ran = new Map<string, { scope: string; version: string; level: ScrutinyLevel; model: string }[]>();
	for (const lens of lenses) {
		const outcome = result?.[lens.key];
		if (outcome?.status !== "done" || outcome.model === undefined) continue;
		// A prober on its level's own tier answers to the policy the plan judges that level by, as its planner does, so a
		// preference that moved the lens cannot carry the prober onto a model the committed tier refuses.
		const prober = lens.probe?.onLevelTier === true ? outcome.probing?.model : undefined;
		ran.set(lens.name, [
			...(ran.get(lens.name) ?? []),
			...[outcome.model, ...(prober === undefined ? [] : [prober])].map((model) => ({
				scope: lens.coverage.scope,
				version: lens.version,
				level: lens.level,
				model,
			})),
		]);
	}
	return ran;
}

/** What {@link reviewChangeset} reviews, and with what. Raw harnesses must supply check records. */
export type ReviewOptions = ReviewSettings &
	(
		| { readonly harness: ReviewHarness; readonly checks?: readonly CheckRecord[] }
		| { readonly harness: Harness; readonly checks: readonly CheckRecord[] }
	);

interface ReviewSettings {
	readonly changeset: Changeset;
	readonly config: MelianConfig;
	/** The identity of checks the host ran upfront. Distinct runs mint rounds even when their records match. */
	readonly checkRun?: RunIdentity;
	/** Precomputed advisory callers; the host opens them after deterministic graph checks. */
	readonly callers?: CallerContext;
	/** The lenses that may run; configuration and the changed paths select among them. */
	readonly lenses: readonly Lens[];
	/** Chains for changed paths, or flat sections shared by every lens for older callers. */
	readonly standards: Standards | readonly StandardsSection[];
	/** The collection the harness was opened with, used to pick each tier's first model with credentials. */
	readonly models: ReviewModels;
	/**
	 * The decider triage asks, which the harness must hold as `decisionExtension`, as `ReviewHarness.open` installs it.
	 * Without it, every lens runs at its default level within its band.
	 */
	readonly decider?: Decider;
	/** Why the host has no decider for this review, noted on each lens's record; ignored with a decider. */
	readonly triageSkipped?: string;
	/**
	 * The review plan the host resolved. Its routes replace `config`'s; a lens on a tier it refuses records `failed`
	 * without running; a lens on a route off the committed one records that lineage; and the verdict's provenance
	 * keeps the plan. Without it, `config`'s routes apply as written.
	 */
	readonly plan?: ReviewPlan;
	/**
	 * Where adjudication reads each finding's configuration, the source `config` came from, such as the base commit.
	 * Without it, `config`'s resolution and rule aliases apply to every path.
	 */
	readonly policy?: RepositorySource;
	/**
	 * The tier whose checks the review accounts for, its manifest. Defaults to the tier configuration maps the
	 * `pull-request` stage to. Only lenses the manifest names run.
	 */
	readonly tier?: string;
	/**
	 * Run again a lens task of this head and selection that left a lens failed, and ask triage again after a decision
	 * that failed, rather than attach to either. Without it a repeat review attaches to the finished tasks and reports
	 * the same outcome, so it spends no tokens unasked.
	 */
	readonly rerun?: boolean;
	/**
	 * Unlocks the providers in a concrete task's routes before it starts. Finished attachments call nothing.
	 * Before any wait, hosts also unlock {@link ReviewHarness.resumedProviders}, which uses stored routes.
	 */
	readonly unlockModels?: (providers: readonly string[]) => Promise<void>;
	/** The chosen decider's providers, unlocked only before a triage task that may ask it. */
	readonly triageProviders?: readonly string[];
	/**
	 * Called once the review has recorded its lens run, and aborted any run it replaced, before it waits for that run.
	 * A host starts work there that needs the change but not the verdict, such as the walkthrough; anything that resumes
	 * the harness then cannot restart a replaced run. A review that runs no lens, or fails earlier, never calls it.
	 */
	readonly lensesStarted?: () => void;
	/**
	 * Where the revision came from, recorded with the verdict. Only a `pull-request` review whose policy came from a
	 * revision can be published. A range by default.
	 */
	readonly origin?: ReviewOrigin;
	/** Whether the head's writer is trusted to have its own code run by `static.mutation`; see {@link WriterTrust}. */
	readonly writer?: WriterTrust;
	/** Run `static.mutation` from nothing in the automatic checks, as a review that may pass must; see `RunChecksInput`. */
	readonly cold?: boolean;
	/** The host's spans, which the review's own steps between tasks join; the host stores them. */
	readonly spans?: PrepareSpans;
	readonly context?: Context;
}

/** What {@link reviewChangeset} found and concluded at the head under review. */
export interface Review {
	/**
	 * The findings the review's lenses sighted at the head, as the root conversation's findings document holds them:
	 * without a resolution, which only the verdict carries.
	 */
	readonly findings: readonly Finding[];
	/** The adjudicated outcome: findings merged across sources and resolved per path, grouped, and the review's status. */
	readonly verdict: Verdict;
}

// Why a conversation's request ended without finishing: the model's own message where it gave one.
function unsettled(settled: { readonly detail?: unknown; readonly reason?: string }): string {
	return typeof settled.detail === "string" ? settled.detail : (settled.reason ?? "unanswered");
}

// The sandbox a review's probes run under: its harness's, or the one a probe uses when none is named.
function probeSandboxOf(request: ReviewOptions): ProbeSandbox {
	return (request.harness instanceof ReviewHarness ? request.harness.probeSandbox : undefined) ?? Probe.sandbox;
}

// Why probes cannot run for this review, or `undefined` when they can: the host has not allowed the head's code to run
// here, the base policy does not trust writers, or the sandbox cannot run on this machine.
async function probeRefusal(
	request: ReviewOptions,
	config: MelianConfig,
	revision: { readonly repoRoot: string; readonly head: string },
): Promise<string | undefined> {
	const { writer } = request;
	if (writer === undefined) return "the host did not say whose head this is";
	if (!writer.trusted) return writer.detail;
	if (writer.by === "writer" && !config.trust.writers) return "trust.writers is false in the repository's policy";
	const sandbox = probeSandboxOf(request);
	const available = await Probe.availability(sandbox);
	if (!available.available) return available.reason;
	const refused = await headRefusal(
		revision,
		{
			writer,
			trustWriters: config.trust.writers,
			read: [...config.probe.read],
			host: probingHost(sandbox),
		},
		sandbox,
	);
	return refused === undefined ? undefined : `the head refuses probes: ${refused}`;
}

// The probe each claim of a probing run rests on, read from its planner's and its prober's conversations, with what its
// own run ran probes under, for its verifier to run each again. Nothing for a candidate no probing run reported.
async function claimProbes(
	harness: Harness,
	claims: readonly MemberClaim[],
	runs: readonly LensRun[],
	result: LensResult | undefined,
	context: Context,
): Promise<Pick<VerificationCandidate, "probes">> {
	const probes: Record<string, ClaimProbe> = {};
	for (const claim of claims) {
		const run = runs.find((each) => {
			const source = lensSource(each.name, each.version, each.level);
			return source.check === claim.source.check && source.version === claim.source.version;
		});
		const outcome = run === undefined ? undefined : result?.[run.key];
		const prober = outcome?.prober;
		if (run === undefined || outcome?.conversation === undefined || prober === undefined) continue;
		const plan = (await harness.snapshot(ProbingDocument, outcome.conversation, context))?.plan ?? [];
		const state = (await harness.snapshot(ProbingDocument, prober, context)) ?? {};
		const id = state.findings?.[claim.id];
		const probe = id === undefined ? undefined : state.probes?.[id];
		if (id === undefined || probe === undefined) continue;
		probes[probeClaimKey(claim)] = {
			id,
			attack: probe.attack,
			plan: structuredClone(plan),
			probe: structuredClone(probe),
			environment: structuredClone(run.probe!.environment),
		};
	}
	return Object.keys(probes).length === 0 ? {} : { probes };
}

type ProbeRerunInput = {
	root: ConversationId;
	revision: ReviewState;
	probes: { key: string; script: string; files: { path: string; text: string }[]; environment: ProbingEnvironment }[];
};

/**
 * Runs a revision's claim probes again, before verification, and stores each run on the root under the revision, so the
 * verifier reads the run whatever crashes or repeats around it. A probe a stored run failed or passed runs no more; one
 * refused, timed out, cut or ended by a signal runs again, since the cause may have passed. Only the task
 * {@link ProbeReruns} names for the revision writes: a later review whose claims rest on other probes takes the
 * revision over, and the task it replaced stops.
 */
export function probeRerunTask(sandbox?: ProbeSandbox) {
	return defineTask<ProbeRerunInput, { phase: "run" }, Record<string, never>>({
		name: "melian.probe-reruns",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const { root, revision, probes } = task.input;
				const at = Revision.key(revision);
				const done = { status: "terminal", outcome: { status: "completed", result: {} } } as const;
				for (const probe of probes) {
					const document = (await runtime.snapshot(ProbeReruns, root, context))!;
					// A task another review has replaced launches no probe; the fence after the run catches a takeover during it.
					if (document.tasks![at]!.task !== runtime.taskId) {
						await runtime.commit(() => done, context);
						return;
					}
					const stored = document.runs[at]?.[probe.key];
					if (stored !== undefined && "result" in stored && probeConclusive(stored.result)) continue;
					const run = await runHeadProbe(
						{ script: probe.script, files: probe.files },
						revision,
						probe.environment,
						sandbox,
					);
					let replaced = false;
					await runtime.commit(async (tx) => {
						const document = await tx.doc(ProbeReruns, root);
						replaced = document.tasks![at]!.task !== runtime.taskId;
						if (replaced) return done;
						document.runs = { ...document.runs, [at]: { ...document.runs[at], [probe.key]: run } };
						return undefined;
					}, context);
					if (replaced) return;
				}
				// A run again of a failed lens names new probes, so the revision keeps only the runs its current claims rest on.
				await runtime.commit(async (tx) => {
					const document = await tx.doc(ProbeReruns, root);
					if (document.tasks![at]!.task !== runtime.taskId) return done;
					const current = new Set(probes.map((probe) => probe.key));
					const kept = Object.entries(document.runs[at] ?? {}).filter(([key]) => current.has(key));
					document.runs = { ...document.runs, [at]: Object.fromEntries(kept) };
					return done;
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}

const ProbeRerunTask = probeRerunTask();

// Starts the task that runs each candidate's claim probes again, or attaches to the live one another review started
// for the same probes, and waits for it. Claims that cite one probe share its rerun, which the map holds once. False
// when a later review has replaced this one's lens task, before the reruns start or while they run.
async function rerunProbes(
	harness: Harness,
	root: ConversationId,
	revision: ReviewState,
	candidates: readonly VerificationCandidate[],
	lensTask: number | undefined,
	context: Context,
): Promise<boolean> {
	const at = Revision.key(revision);
	const probes = new Map<string, ProbeRerunInput["probes"][number]>();
	for (const candidate of candidates)
		for (const claim of candidate.state.claims) {
			const probe = candidate.probes?.[probeClaimKey(claim)];
			if (probe === undefined) continue;
			const key = rerunKey(claim, probe);
			probes.set(key, {
				key,
				script: probe.probe.script,
				files: structuredClone(probe.probe.files),
				environment: structuredClone(probe.environment),
			});
		}
	const input: ProbeRerunInput = { root, revision, probes: [...probes.values()] };
	const key = JSON.stringify(input.probes);
	const task = await (await harness.root(context)).commit(async (tx) => {
		// A review another has replaced takes nothing over: its claims may rest on probes the newer review no longer runs.
		if ((await tx.doc(ReviewIndex, root)).reviews[at]?.task !== lensTask) return undefined;
		const document = await tx.doc(ProbeReruns, root);
		const known = document.tasks?.[at];
		if (known?.key === key && (await tx.task(known.task as TaskId))!.state.status !== "terminal")
			return known.task as TaskId;
		const created = await tx.createTask(ProbeRerunTask, input, { ownership: { kind: "conversation" } });
		document.tasks = { ...document.tasks, [at]: { task: created, key } };
		return created as TaskId;
	}, context);
	if (task === undefined) return false;
	await harness.waitForTask(task, context);
	// Another review can replace this one's lens task while the reruns run, and take the reruns over then or later with
	// other probes. One sharing this lens task can start the same probes' rerun again, which leaves this review standing.
	if ((await harness.snapshot(ProbeReruns, root, context))!.tasks![at]!.key !== key) return false;
	return (await harness.snapshot(ReviewIndex, root, context))!.reviews[at]!.task === lensTask;
}

// The findings the change's last earlier revision was reported with, every producer's, for a probing level's planner.
async function earlierFindings(
	harness: Harness,
	root: ConversationId,
	revision: string,
	context: Context,
): Promise<EarlierFinding[]> {
	const revisions = (await harness.snapshot(FindingsDocument, root, context))?.revisions ?? [];
	// The revision reviewed before this one, never one reviewed after it; a revision new to the list follows the last.
	const at = revisions.indexOf(revision);
	const previous = at === -1 ? revisions.at(-1) : revisions[at - 1];
	if (previous === undefined) return [];
	return (await readFindings(harness, root, previous, context)).map((finding) => ({
		severity: finding.properties.severity,
		rule: finding.ruleId,
		path: finding.properties.path,
		line: finding.locations[0]?.physicalLocation.region?.startLine ?? 1,
		status: finding.properties.status,
		message: finding.message.text,
	}));
}

// A task no installed extension defines stays blocked, and waiting on it would never return. `forget` takes the aborted
// task out of the document that names it, so the next call starts a task rather than attach to this one.
async function refuseIfBlocked(
	harness: Harness,
	taskId: TaskId,
	lenses: readonly string[],
	forget: (tx: Tx, root: ConversationId) => Promise<void>,
	context: Context,
	missing = "the harness has no melian.lenses extension; pass the harness of openReviewHarness",
): Promise<void> {
	harness.resume();
	const blocked = (await harness.inspect(context)).tasks.find(
		(each) => each.record.id === taskId && each.state.kind === "blocked",
	);
	if (blocked === undefined) return;
	await harness.abortTask(taskId, context);
	const root = await harness.root(context);
	await root.commit((tx) => forget(tx, root.id), context);
	throw new ReviewError("notInstalled", missing, { lenses });
}

function inIndex(forget: (index: ReviewIndexState) => void) {
	return async (tx: Tx, root: ConversationId) => forget(await tx.doc(ReviewIndex, root));
}

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
	const { [key]: _, ...rest } = value;
	return rest;
}

// A review's lens selection as the review index keys it: each run's key and the route it resolved, with the band its
// level was held to, the severity that escalates it, and the run a quick run escalates to, with its route, or why it
// is capped. Problem: a selection of names alone let a review under another plan, such as one with --model or a
// changed preference file, attach to a lens task that ran on the old route, and one under a changed band or
// `escalateAt` attach to a task that escalated under the old rule. Solution: each is part of the selection, so a
// change to any of them runs the lenses again. A task an older Melian created names none of them.
function escalatesTo(escalation: NonNullable<LensRun["escalation"]>): string {
	const { next } = escalation;
	if (next !== undefined)
		return `escalates to ${next.key} (${next.route.map(modelName).join(", ")}) ${next.instructionFingerprint ?? ""}${next.thinking === undefined ? "" : ` thinking ${next.thinking}`}${next.probe === undefined ? "" : ` ${probesWith(next.probe)}`}`;
	return `capped ${escalation.cap ?? "at its ceiling"}`;
}

// A probing run's prober route and the whole environment its probes run under, so a review with another prober, writer,
// time limit or grant runs again.
function probesWith(probe: NonNullable<LensRun["probe"]>): string {
	return `probes ${JSON.stringify(probe.environment)} with ${probe.route.map(modelName).join(", ")}${probe.thinking === undefined ? "" : ` thinking ${probe.thinking}`}`;
}

function selectionOf(lenses: readonly LensRun[], escalateAt: Severity | undefined): string[] {
	return lenses
		.map((lens) =>
			[
				lens.key,
				...(lens.thinking === undefined ? [] : [`thinking ${lens.thinking}`]),
				...(lens.instructionFingerprint === undefined ? [] : [`instructions ${lens.instructionFingerprint}`]),
				...(lens.band === undefined ? [] : [`band ${lens.band}`]),
				...(escalateAt === undefined ? [] : [`escalateAt ${escalateAt}`]),
				...(lens.escalation === undefined ? [] : [escalatesTo(lens.escalation)]),
				...(lens.probe === undefined ? [] : [probesWith(lens.probe)]),
				`on ${lens.route.map(modelName).join(", ")}`,
			].join(" "),
		)
		.sort();
}

// Every run of `lenses`: each first run, and the run a quick one escalates to.
function runsOf(lenses: readonly LensRun[]): LensRun[] {
	return lenses.flatMap((lens) => [lens, ...(lens.escalation?.next === undefined ? [] : [lens.escalation.next])]);
}

// One lens task per head and selection. A repeat call, such as a rerun after a crash, attaches to the task the first
// call created, which the harness resumes, rather than running every lens a second time. Returns the task's result,
// `undefined` when the task did not complete, and the runs and `escalateAt` its stored input holds, which decided its
// escalations.
async function runLenses(
	harness: Harness,
	input: StoredLensTaskInput,
	rerun: boolean,
	context: Context,
	refused: (key: string, model: string, role?: "prober") => boolean = () => false,
	unlockModels: ((providers: readonly string[]) => Promise<void>) | undefined,
	whileRunning: (task: number, done: Promise<unknown>) => Promise<void>,
	started?: () => void,
): Promise<{ readonly result: LensResult | undefined; readonly ran: StoredLensTaskInput; readonly task: number }> {
	const root = await harness.root(context);
	const revision = Revision.key(input.revision);
	const selection = selectionOf(input.lenses, input.escalateAt);
	if (unlockModels !== undefined) {
		// Live tasks were unlocked from their checkpoints before resume; finished tasks ask no model.
		const known = (await harness.snapshot(ReviewIndex, root.id, context))?.reviews[revision];
		const record = known?.task === undefined ? undefined : await harness.getTask(known.task as TaskId, context);
		const attaches =
			known !== undefined &&
			known.lenses.join("\n") === selection.join("\n") &&
			record !== undefined &&
			(record.state.status !== "terminal" || finished(record, undecided)) &&
			!(rerun && lensFailed(record!, refused));
		if (!attaches)
			await unlockModels(
				runsOf(input.lenses).flatMap((run) =>
					[...run.route, ...(run.probe?.route ?? [])].map((model) => model.provider),
				),
			);
	}
	let replaced: number | undefined;
	const taskId = await root.commit(async (tx) => {
		const index = await tx.doc(ReviewIndex, root.id);
		const known = index.reviews[revision];
		const same = known !== undefined && known.lenses.join("\n") === selection.join("\n");
		const attach =
			same &&
			(await attachable(tx, known.task, undecided)) &&
			!(rerun && (await anyLensFailed(tx, known.task, refused)));
		if (attach) return known.task as TaskId<LensResult>;
		await recordRevision(tx, root.id, revision);
		// The new run reports afresh, so any earlier run's sightings of these lenses leave the revision in the same commit,
		// whether or not the index still names that run: a review that selected no lens rewrites the entry without one.
		// Each run names its producer with its level, and a run an older Melian stored named the bare version.
		const sources = runsOf(input.lenses).flatMap((run) => [
			lensSource(run.name, run.version, run.level),
			{ check: `lens.${run.name}`, version: run.version },
		]);
		await clearSightings(tx, root.id, revision, sources);
		const created = await tx.createTask(LensTask, input, { ownership: { kind: "conversation" } });
		replaced = known?.task;
		index.reviews[revision] = { task: created, lenses: selection };
		return created;
	}, context);
	// Before anything resumes the replaced run: it asks no model again and its reports no longer count, but a live
	// task would still hold its conversations open.
	if (replaced !== undefined && replaced !== taskId) {
		await harness.abortTask(replaced as TaskId, context).catch(() => undefined);
	}
	started?.();
	const forget = (index: ReviewIndexState) => {
		if (index.reviews[revision]?.task === taskId) index.reviews = omit(index.reviews, revision);
	};
	await refuseIfBlocked(
		harness,
		taskId,
		input.lenses.map((lens) => lens.name),
		inIndex(forget),
		context,
	);
	const waiting = harness.waitForTask(taskId, context);
	const [settled] = await Promise.all([waiting, whileRunning(taskId, waiting)]);
	const { outcome } = settled.state;
	return {
		result: outcome.status === "completed" ? outcome.result : undefined,
		ran: settled.input as unknown as StoredLensTaskInput,
		task: taskId,
	};
}

// Whether a finished lens task left a lens without an answer, which `rerun` asks to try again.
// A lens that finished on a model the plan refuses, such as a fallback outside a guarded accept, counts as failed, as
// its record does once `plan.mark` judges it, so `rerun` runs it again rather than reuse the refused result.
async function anyLensFailed(
	tx: Tx,
	id: number | undefined,
	refused: (key: string, model: string, role?: "prober") => boolean,
): Promise<boolean> {
	const record = id === undefined ? undefined : await tx.task(id as TaskId);
	return record !== undefined && lensFailed(record, refused);
}

function lensFailed(
	record: {
		readonly state: {
			readonly status: string;
			readonly outcome?: { readonly status: string; readonly result?: unknown };
		};
	},
	refused: (key: string, model: string, role?: "prober") => boolean,
): boolean {
	const { outcome } = record.state;
	if (record.state.status !== "terminal" || outcome === undefined) return false;
	if (outcome.status !== "completed") return true;
	return Object.entries(outcome.result as LensResult).some(
		([key, lens]) =>
			lens.status !== "done" ||
			(lens.model !== undefined && refused(key, lens.model)) ||
			(lens.probing?.model !== undefined && refused(key, lens.probing.model, "prober")),
	);
}

// The caller notes and coverage a review's records carry. Problem: they come from this call's graph cache, which a
// repeat call of the same head may not find, so a repeat rewrote the records, keyed a new adjudication task and
// fingerprinted a new verdict for the same findings. Solution: the first call that finishes the lens task stores them
// on the review's index entry, and a repeat call that attaches to that task reads them back. They derive from the task's
// stored input, which holds what the call that created it rendered, never from the finishing call's own context.
async function callersFor(
	harness: Harness,
	input: StoredLensTaskInput,
	task: number | undefined,
	settledLenses: boolean,
	{ notes, caveat }: Pick<StoredCallers, "notes" | "caveat">,
	coverage: () => Promise<Pick<CallerRecord, "coverage" | "coverageUnavailable">>,
	context: Context,
): Promise<CallerRecord> {
	const root = await harness.root(context);
	const revision = Revision.key(input.revision);
	const selection = selectionOf(input.lenses, input.escalateAt);
	const entryOf = async () => {
		const entry = (await harness.snapshot(ReviewIndex, root.id, context))?.reviews[revision];
		return entry?.lenses.join("\n") === selection.join("\n") ? entry : undefined;
	};
	// A record names the lens task it was computed from. A rerun that replaced the task leaves a record of the old one.
	const stored = (await entryOf())?.callers;
	if (stored !== undefined && stored.task === task) return stored;
	const fresh: CallerRecord = { notes, ...(caveat === undefined ? {} : { caveat }), ...(await coverage()), task };
	if (!settledLenses || task === undefined) return fresh;
	return root.commit(async (tx) => {
		const index = await tx.doc(ReviewIndex, root.id);
		const entry = index.reviews[revision];
		if (entry?.lenses.join("\n") !== selection.join("\n") || entry.task !== task) return fresh;
		if (entry.callers?.task !== task) entry.callers = fresh;
		return JSON.parse(JSON.stringify(entry.callers)) as CallerRecord;
	}, context);
}

// One adjudication task per head and input. A repeat call with the same input, such as a rerun after a crash, attaches
// to the task the first call created. A call with other input, such as a static check that has since run, creates a
// task and records it as the head's, and a task an earlier call created then records no verdict.
async function startAdjudication(
	harness: Harness,
	input: AdjudicationTaskInput,
	selection: readonly string[],
	verificationRefused: boolean,
	checkRun: string | undefined,
	context: Context,
): Promise<TaskId<AdjudicationResult> | undefined> {
	const root = await harness.root(context);
	return root.commit(async (tx) => {
		const index = await tx.doc(ReviewIndex, root.id);
		const revision = Revision.key(input);
		let known = index.reviews[revision];
		// A review whose lenses ran owns the entry only while it still names their selection. Problem: once a later review
		// replaced this one's lens task, rewriting the entry here dropped the newer run's task, and the guards then read
		// that live run as superseded. Solution: a replaced review adjudicates nothing.
		if (selection.length > 0 && known?.lenses.join("\n") !== selection.join("\n")) return undefined;
		const deciding = { ...input };
		if (verificationRefused) {
			await clearVerifications(tx, input.root, revision);
			// The waves' outcomes stood for the judgements just cleared, so no later review may reuse them.
			delete (await tx.doc(VerificationWavesDocument, input.root)).reviews[revision];
			deciding.findingsVersion = (await tx.doc(FindingsDocument, input.root)).versions[revision] ?? 0;
			if (known?.verification !== undefined) known = omit(omit(known, "verification"), "adjudication");
		}
		const key = JSON.stringify({ ...deciding, details: undefined });
		// A failed adjudication is always rerun: it is cheap, and its failure, such as a base commit a shallow clone had
		// not fetched yet, may have passed.
		const retry = [...undecided, "failed"];
		const rounds = new RoundWriter(tx, root.id);
		if (
			known?.adjudication?.input === key &&
			(await rounds.checkRun(known.adjudication.task, checkRun)) === checkRun &&
			(await attachable(tx, known.adjudication.task, retry))
		) {
			await rounds.keep(revision, known.adjudication.task, checkRun);
			return known.adjudication.task as TaskId<AdjudicationResult>;
		}
		const created = await tx.createTask(AdjudicationTask, deciding, { ownership: { kind: "conversation" } });
		await rounds.mint(revision, created, new Date().toISOString(), checkRun);
		const same = known !== undefined && known.lenses.join("\n") === selection.join("\n");
		const entry = same ? known : { lenses: [...selection] };
		index.reviews[revision] = { ...entry, adjudication: { task: created, input: key } };
		return created;
	}, context);
}

// The run whose record stands for a lens: its first, or the one the escalation rule moved it to, with its outcome; a
// note for each escalation, saying why it ran again or that it was capped, and what became of the findings it carried;
// and the first run's findings the escalated run neither restated nor refuted, which still count.
type SettledLens = {
	readonly run: LensRun;
	readonly outcome: LensOutcome | undefined;
	readonly notes: string[];
	readonly kept?: Producer;
};

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function settle(first: LensRun, result: LensResult | undefined, rule: EscalationRule): SettledLens {
	const outcome = result?.[first.key];
	const escalation = outcome?.status === "done" ? outcome.escalation : undefined;
	const next = escalation?.to === undefined ? undefined : first.escalation?.next;
	if (escalation === undefined) return { run: first, outcome, notes: [] };
	const notes = [rule.describe(escalation.trigger, first.level, next?.level, first.escalation?.cap)];
	if (next === undefined) return { run: first, outcome, notes };
	const carried = escalation.carried ?? [];
	const kept = escalation.kept ?? [];
	const refuted = escalation.refuted ?? [];
	const restated = carried.length - kept.length - refuted.length;
	if (restated > 0) notes.push(`${next.level} restated ${plural(restated, "finding")} ${first.level} carried`);
	if (refuted.length > 0)
		notes.push(`${next.level} refuted ${plural(refuted.length, "finding")} ${first.level} carried`);
	if (kept.length > 0) {
		notes.push(
			`${plural(kept.length, "finding")} ${first.level} carried at or above ${rule.escalateAt}, which ${next.level} neither restated nor refuted, still ${kept.length === 1 ? "counts" : "count"} as ${first.level} reported ${kept.length === 1 ? "it" : "them"}`,
		);
	}
	const source = lensSource(first.name, first.version, first.level);
	return {
		run: next,
		outcome: result?.[next.key],
		notes,
		...(kept.length === 0 ? {} : { kept: { ...source, ids: [...kept] } }),
	};
}

// `notes` say why the lens ran where it did: hand-offs its instructions left out for size, a triage that failed, and
// each escalation. A record of a lens that did not finish carries them after the reason it did not, and an `ended`
// record carries them as its reason, which renders after the budget's description, so neither ever replaces it.
function lensCheck(
	lens: LensRun,
	outcome: LensOutcome | undefined,
	completed: boolean,
	notes: string[],
	handedBy: readonly string[],
	caveats: readonly string[],
): CheckRecord {
	const record = lensRecord(lens, outcome, completed, notes, handedBy);
	return { ...record, version: lens.version, ...(caveats.length === 0 ? {} : { caveats: [...caveats] }) };
}

// What a probing run did, for its record: the plan's size, the probes and their time, and the attacks it skipped.
function probingNote(probing: ProbingOutcome): string {
	if (probing.attacks === 0) return "its planner found no attack to probe";
	// A probe that ran took some time, however fast the machine: never "0.0 s".
	const seconds = (probing.milliseconds / 1000).toFixed(1);
	const time = probing.probes > 0 && seconds === "0.0" ? "under 0.1" : seconds;
	const skipped = probing.skipped === 0 ? "" : `, and skipped ${plural(probing.skipped, "attack")}`;
	return `it planned ${plural(probing.attacks, "attack")} and ran ${plural(probing.probes, "probe")} in ${time} s${skipped}`;
}

function lensRecord(
	lens: LensRun,
	outcome: LensOutcome | undefined,
	completed: boolean,
	given: string[],
	handedBy: readonly string[],
): CheckRecord {
	const name = `lens.${lens.name}`;
	const { level } = lens;
	const probing = outcome?.status === "done" ? outcome.probing : undefined;
	const notes = probing === undefined ? given : [...given, probingNote(probing)];
	const noted = notes.length === 0 ? {} : { reason: notes.join("; ") };
	const failed = (why: string) => [why, ...notes].join("; ");
	if (!completed) return { name, status: "failed", level, reason: failed("the lens task did not complete") };
	if (outcome?.status === "done") {
		const { budgetEnded } = outcome;
		// An attack with neither a probe nor a skip is one the review never tried.
		const open = probing?.unanswered ?? [];
		if (open.length > 0) {
			const attacks = `${open.length === 1 ? "attack" : "attacks"} ${open.join(", ")}`;
			return {
				name,
				status: "ended",
				level,
				...(budgetEnded === undefined ? {} : { budgetEnded }),
				reason: failed(`its prober left ${attacks} with neither a probe nor a skip`),
			};
		}
		if (outcome.capped !== undefined) {
			const lost =
				handedBy.length === 0
					? `its findings budget of ${outcome.capped} ran out, so defects may be unreported`
					: `its findings budget of ${outcome.capped} ran out while ${handedBy.map((name) => `\`${name}\``).join(", ")} could have handed it defects, so one may be unreported`;
			return {
				name,
				status: "ended",
				level,
				...(budgetEnded === undefined ? {} : { budgetEnded }),
				reason: [lost, ...notes].join("; "),
			};
		}
		if (lens.standardsOmitted)
			return { name, status: "ended", level, ...(budgetEnded === undefined ? {} : { budgetEnded }), ...noted };
		if (budgetEnded === undefined) return { name, status: "ran", level, ...noted };
		// A budget's end is reduced coverage, so it leaves the review not reviewed unless the level counts it.
		if (lens.budget.ended === "count") return { name, status: "ran", level, budgetEnded, ...noted };
		return { name, status: "ended", level, budgetEnded, ...noted };
	}
	if (outcome?.status === "exhausted") {
		const error = `tried ${outcome.tried.join(", ")}; the last said: ${outcome.reason}`;
		return { name, status: "failed", level, reason: failed("every model of its tier failed"), error };
	}
	const error = outcome?.reason ?? "no outcome";
	return { name, status: "failed", level, reason: failed("the lens did not finish"), error };
}

// Records for the lenses and decision questions the tier names; the lens step owns `lens.*` and `decisions.*`, so a
// record of either from elsewhere, such as a check runner that skips them, gives way. Every other check's record comes
// from `supplied`; adjudication calls one with none a check that never started. `lenses` holds the lens step's own
// records, and `skippable` the lenses whose skip it allows. The producers are the sources whose findings the review
// counts: each lens at the level of the run that stands for it.
function account(
	checks: readonly string[],
	settled: readonly SettledLens[],
	lenses: {
		readonly records: readonly CheckRecord[];
		readonly skippable: readonly string[];
		// The decider that answered triage, when one did.
		readonly triagedBy?: string;
	},
	options: Pick<ReviewOptions, "config" | "lenses" | "checks">,
): { readonly manifest: Manifest; readonly producers: Producer[] } {
	const { config } = options;
	// The lens step owns `lens.*` and `decisions.*`, so the host's records of them give way. The plan's `failed` record of
	// a lens it refused at the level triage chose is the lens step's own, in `lenses.records`, beside the record of a
	// variant in another folder that ran, so a refused lens never reads as one no lens is named for.
	const supplied = (options.checks ?? []).filter(
		(check) => !check.name.startsWith("decisions.") && !check.name.startsWith("lens."),
	);
	const manifest = new Manifest(checks, [...supplied, ...lenses.records], config.checks.allowSkip);
	for (const name of lenses.skippable) manifest.allowSkip(name);
	// Mutation testing is advisory, so a change it has nothing to mutate in, or is too big or slow to mutate, or may not
	// run on, passes with the reason recorded. Any other skip of it still leaves the review not reviewed, and so does a
	// failed record, since the manifest lets only a skip pass.
	for (const check of supplied) {
		if (check.name === "static.mutation" && mutationSkipHasLeave(check.cause)) {
			manifest.allowSkip(check.name);
		}
	}
	const recorded = new Set(manifest.records().map((check) => check.name));
	const { provider } = config.decisions;
	for (const name of checks) {
		if (recorded.has(name)) continue;
		if (name.startsWith("lens.")) {
			const lens = name.slice("lens.".length);
			const settings = Object.hasOwn(config.lenses, lens) ? config.lenses[lens] : undefined;
			if (!options.lenses.some((each) => each.name === lens)) {
				manifest.record({ name, status: "failed", reason: `no lens is named ${lens}` });
			} else if (settings?.enabled === false) {
				manifest.record({ name, status: "skipped", reason: `lenses.${lens}.enabled is false` });
			} else {
				// Nothing it covers changed, so there was nothing for it to review: a change of excluded paths alone passes
				// on its deterministic checks.
				manifest.record({ name, status: "skipped", reason: "no paths" });
				manifest.allowSkip(name);
			}
		} else if (name.startsWith("decisions.")) {
			if (provider === undefined) {
				// The design lets the fast tier run without decision questions when no provider is configured.
				const triaged = lenses.triagedBy === undefined ? "" : `; triage ran on ${lenses.triagedBy}`;
				manifest.record({ name, status: "skipped", reason: `no decision provider is configured${triaged}` });
				manifest.allowSkip(name);
			} else {
				// A configured provider asks for the questions, and Melian cannot ask them yet, so the review fails closed
				// with the reason rather than with no record.
				const reason = `decisions.provider is ${provider}, and Melian has no adapter for a decision provider yet`;
				manifest.record({ name, status: "skipped", reason });
			}
		}
	}
	const versions = new Map(supplied.map((check) => [check.name, check.version]));
	const others = [...new Set([...checks, ...supplied.map((check) => check.name)])].filter(
		(name) => !name.startsWith("lens."),
	);
	const producers: Producer[] = [
		...settled.flatMap(({ run, kept }) => [
			lensSource(run.name, run.version, run.level),
			...(kept === undefined ? [] : [kept]),
		]),
		...others.map((check) => {
			const version = versions.get(check);
			return version === undefined ? { check } : { check, version };
		}),
	];
	return { manifest, producers };
}

// The band each selected lens's level must lie in, per selection, so two folder variants of one name keep their own:
// the band of every file it reviews, each from the configuration of
// that file's path, read from the policy source, or `config` for every path without one.
async function bandsOf(
	selections: readonly { readonly lens: Lens; readonly covers: readonly string[] }[],
	options: Pick<ReviewOptions, "config" | "policy" | "changeset" | "origin" | "decider">,
): Promise<Map<Lens, LevelBand>> {
	const { policy, config, changeset } = options;
	// A head the host does not trust writes the change triage reads, so until a calibrated decision model answers, its
	// default floor is careful: an uncalibrated model the head can steer never sends every lens to a quick look. The host
	// says it does not trust the head the way the CLI does for policy: a pull request, or a range whose policy it reads
	// from a revision rather than the working tree.
	const untrusted = options.origin?.kind === "pull-request" || policy?.kind === "revision";
	const floor = untrusted && options.decider?.calibrated !== true ? "careful" : "quick";
	const lookup = policy === undefined ? undefined : configLookup(changeset.repoRoot, policy);
	const bands = new Map<Lens, LevelBand>();
	for (const { lens, covers } of selections) {
		const configs = lookup === undefined ? [config] : await Promise.all(covers.map((path) => lookup(path)));
		const settings = configs.map((each) =>
			Object.hasOwn(each.lenses, lens.name) ? each.lenses[lens.name] : undefined,
		);
		bands.set(lens, LevelBand.across(settings.map((each) => LevelBand.of(each?.level, floor))));
	}
	return bands;
}

// One question per name: two variants of a lens in different folders share a name, and so its answer, which each
// variant then holds to its own band. The shared question offers every option any variant offers.
function sharedQuestions(questions: readonly ChoiceQuestion[]): ChoiceQuestion[] {
	const byName = new Map<string, ChoiceQuestion>();
	for (const question of questions) {
		const known = byName.get(question.id);
		const options = new Set([...(known?.options ?? []), ...question.options]);
		byName.set(question.id, {
			...(known ?? question),
			options: triageChoices.filter((choice) => options.has(choice)),
		});
	}
	return [...byName.values()];
}

// Triage's decision on the revision: one choice question per lens, asked through `decider` in a decision task, which
// stores the whole distribution. A repeat call with the same questions attaches to the task the first call created,
// so a crash or a second review keeps the levels the first chose; `rerun` asks again after any decision that did not
// complete, never after one that did.
// `undefined`, with why, when the decider gave no usable answer, so every lens runs at its default level.
async function triage(
	harness: Harness,
	revision: string,
	decider: Decider,
	request: DecisionRequest,
	inputCut: boolean,
	rerun: boolean,
	context: Context,
	providers: readonly string[],
	unlockModels?: (providers: readonly string[]) => Promise<void>,
): Promise<{ readonly decision?: Decision; readonly failure?: string }> {
	const root = await harness.root(context);
	const set = request.questionSet.name;
	// What was asked, without the state: the state carries this review's boundary nonce, which differs on every call.
	const key = JSON.stringify({
		decider: decider.name,
		questionSet: request.questionSet,
		questions: request.questions,
		...(inputCut ? { inputCut: true } : {}),
	});
	const input: DecisionTaskInput = {
		root: root.id,
		revision,
		key,
		request: structuredClone(request) as DecisionTaskInput["request"],
		...(inputCut ? { inputCut: true } : {}),
	};
	if (unlockModels !== undefined) {
		// What the commit below decides, read ahead of it: only a finished decision of these questions is attached to
		// without asking a model, and a rerun asks again after one that recorded none.
		const entry = (await harness.snapshot(DecisionDocument, root.id, context))?.decisions[revision]?.[set];
		const record = entry === undefined ? undefined : await harness.getTask(entry.task as TaskId, context);
		const attaches = entry?.key === key && !(rerun && entry.decision === undefined) && finished(record, undecided);
		if (!attaches) await unlockModels(providers);
	}
	let replaced: number | undefined;
	const taskId = await root.commit(async (tx) => {
		const document = await tx.doc(DecisionDocument, root.id);
		const known = document.decisions[revision]?.[set];
		// A rerun asks again after any decision that did not complete: one that failed, and one a crash left undecided.
		const retry = rerun && known?.decision === undefined;
		const attach = known?.key === key && !retry && (await attachable(tx, known.task, undecided));
		const index = await tx.doc(ReviewIndex, root.id);
		const previous = index.reviews[revision];
		const record = previous?.task === undefined ? undefined : await tx.task(previous.task as TaskId);
		const task = attach
			? (known.task as TaskId<DecisionResult>)
			: await tx.createTask(decisionTask(decider), input, { ownership: { kind: "conversation" } });
		if (!attach) {
			replaced = known?.task;
			document.decisions = {
				...document.decisions,
				[revision]: {
					...document.decisions[revision],
					[set]: { key, task, ...(inputCut ? { inputCut: true } : {}) },
				},
			};
		}
		if (!attach || (known.decision === undefined && known.failure === undefined)) {
			// Waiting starts every pending task, before triage can choose the selection that replaces this live run.
			if (record !== undefined && record.state.status !== "terminal") index.reviews[revision] = { lenses: [] };
			else if (previous !== undefined)
				index.reviews[revision] = omit(omit(previous, "adjudication"), "verification");
			// Its waves go with the verification, so the sweep aborts any still live.
			delete (await tx.doc(VerificationWavesDocument, root.id)).reviews[revision];
			const verdicts = await tx.doc(VerdictDocument, root.id);
			await new RoundWriter(tx, root.id).preserve(revision);
			delete verdicts.verdicts[revision];
			if (verdicts.provenance !== undefined) delete verdicts.provenance[revision];
			if (verdicts.decisions !== undefined) delete verdicts.decisions[revision];
		}
		return task;
	}, context);
	// A live replaced task would still ask its decider, and its answer lands nowhere.
	if (replaced !== undefined && replaced !== taskId) {
		await harness.abortTask(replaced as TaskId, context).catch(() => undefined);
	}
	const decided = await readRecordedDecision(harness, root.id, revision, set, context);
	if (decided?.task === taskId && (decided.decision !== undefined || decided.failure !== undefined)) {
		return decided.decision === undefined ? { failure: decided.failure } : { decision: decided.decision };
	}
	await abortReplacedRuns(harness, context);
	const forget = async (tx: Tx, rootId: ConversationId) => {
		const document = await tx.doc(DecisionDocument, rootId);
		const entries = document.decisions[revision];
		if (entries?.[set]?.task !== taskId) return;
		const { [set]: _, ...rest } = entries;
		document.decisions = { ...document.decisions, [revision]: rest };
	};
	const missing = "the harness has no melian.decision extension; open it with the decider, as ReviewHarness.open does";
	await refuseIfBlocked(harness, taskId, [], forget, context, missing);
	const settled = (await harness.waitForTask(taskId, context)).state.outcome;
	const recorded = await readRecordedDecision(harness, root.id, revision, set, context);
	if (settled.status !== "completed" || recorded?.task !== taskId) {
		return { failure: `the decision task ended ${settled.status === "completed" ? "superseded" : settled.status}` };
	}
	return recorded.decision === undefined
		? { failure: recorded.failure ?? "no decision" }
		: { decision: recorded.decision };
}

/**
 * Reviews a changeset: selects the lenses its paths and configuration call for, chooses each one's level, runs each
 * as a conversation owned by one lens task, then adjudicates in a task of its own and records the verdict on the root
 * conversation under the revision. Returns the findings the selected lenses sighted at the revision and the verdict.
 *
 * With `options.decider`, triage asks it one choice question per lens, `skip` or one of the lens's levels, in a
 * decision task that stores the whole distribution; without one, or when it gives no usable answer, every lens runs at
 * its default level, `careful`. Either way the level stays within the band policy sets for the files the lens reviews,
 * `lenses.<name>.level`, `quick` to `deep` by default. Only a floor of `skip` and complete triage input let triage skip a lens. A lens at
 * `quick` that reports a finding at or above `triage.escalateAt`, or that a budget ended before it reported anything,
 * runs again at its next level the band allows, in a conversation of its own, and that run's record and findings stand
 * for the lens. Each lens starts on its tier's first configured model that has credentials, moves to the next when a
 * provider failure outlasts pi-ai's retries or authentication fails, and becomes a check named `lens.<name>` beside
 * `options.checks`.
 *
 * With a `ReviewHarness` opened with `checkout`, runs deterministic checks first unless `checks` was supplied,
 * including an empty array. Checks use the original `config`, before the plan replaces its routes. `rerun` maps to
 * `rerunFailed`. Raw harnesses must supply records or throw `notInstalled`. Wrappers without an environment leave missing records not reviewed. A check run that does not complete propagates its `CheckError` without adjudicating.
 *
 * Throws {@link ReviewError}: `noAvailableModel` when a lens has no level in its band whose tier routes to a model with
 * credentials, naming each level and why, `missingPolicy` before any task starts when automatic checks lack a source, `notInstalled` when the harness lacks {@link lensExtension}, or the decision extension for
 * a decider, `adjudicationFailed` when no verdict was recorded, `superseded` when a later review replaced this one's lens run,
 * `allModelsFailed` when every model of a lens's route
 * failed, naming them, and `lensFailed` when a lens did not finish for another reason. The last two carry the findings
 * reported so far and the `not-reviewed` verdict already recorded.
 */
export async function reviewChangeset(request: ReviewOptions): Promise<Review> {
	if (request.checks === undefined && !(request.harness instanceof ReviewHarness)) {
		throw new ReviewError(
			"notInstalled",
			"automatic checks require ReviewHarness; raw harness callers must supply checks, including an empty array",
			{ lenses: [] },
		);
	}
	const harness = request.harness instanceof ReviewHarness ? request.harness.harness : request.harness;
	const automatic =
		request.checks === undefined && request.harness instanceof ReviewHarness && request.harness.checksAvailable;
	if (automatic && request.policy === undefined) {
		throw new ReviewError("missingPolicy", "automatic checks require the policy source the host chose", {
			lenses: [],
		});
	}
	const tier = request.tier ?? request.config.stages["pull-request"] ?? "full";
	// The host's open step ends before any check runs, so it never covers a check task.
	request.spans?.end();
	const checked = automatic
		? await runChecks(
				harness,
				{
					rootConversationId: (await harness.root(request.context ?? backgroundContext)).id,
					changeset: request.changeset,
					config: request.config,
					source: request.policy!,
					tier,
					rerunFailed: request.rerun,
					...(request.writer === undefined ? {} : { writer: request.writer }),
					...(request.cold === true ? { cold: true } : {}),
				},
				request.context ?? backgroundContext,
			)
		: undefined;
	const options = planned({ ...request, checks: checked?.records ?? request.checks ?? [] });
	const { changeset, config, standards, models } = options;
	// A host that keeps no spans gets a recorder nobody stores, on a clock that reads nothing.
	const spans = options.spans ?? PrepareSpans.start("review", 0, () => 0);
	spans.step("standards.trust");
	const standardsSource =
		standards instanceof Standards && (await standards.trustedBy(options.policy)) ? "revision" : "worktree";
	const context = options.context ?? backgroundContext;
	spans.step("abort.replaced");
	await abortReplacedRuns(harness, context);
	const root = (await harness.root(context)).id;
	// A file's old path too, so a move out of a lens's paths still runs the lens on what left them.
	const paths = changeset.revision.paths();
	const manifest = checksOfTier(config, tier);
	const named = new Set(manifest.filter((name) => name.startsWith("lens.")).map((name) => name.slice("lens.".length)));
	const selected = Lens.select(
		options.lenses.filter((lens) => named.has(lens.name)),
		config,
		paths,
	);
	const nonce = reviewNonce();
	let headFunctions: Promise<EnclosingFunctions> | undefined;
	const enclosing = () => (headFunctions ??= spans.time("functions", () => EnclosingFunctions.read(changeset)));
	const { unlockModels } = options;
	const prompt = new ChangePrompt(changeset, nonce);
	const { repoRoot, revision } = changeset;
	const { base, head } = revision;
	const reviewed = Revision.key(revision);
	// A lens selected through a file's old path covers its head path for this review, so it can report what it moved.
	const covering = selected.map((selection) => {
		const { files } = selection;
		const moved = changeset.revision.files
			.filter((file) => file.oldPath !== undefined && files.includes(file.oldPath) && !files.includes(file.path))
			.map((file) => file.path);
		return { ...selection, moved, covers: [...files, ...moved] };
	});
	spans.step("bands");
	const bands = await bandsOf(covering, options);
	spans.step("routes");
	const { plan } = request;
	const levelRoutes = new Map(
		covering.flatMap(({ lens }) =>
			lens
				.declaredLevels()
				.map(
					(level) => [`${lens.name}@${lens.version}@${level}`, LevelRoute.of(lens, level, config, plan)] as const,
				),
		),
	);
	// A level that probes runs its prober on a tier of its own, which must route too.
	const proberRoutes = new Map(
		covering.flatMap(({ lens }) =>
			lens.declaredLevels().flatMap((level) => {
				const prober = lens.level(level).probe?.prober;
				return prober === undefined ? [] : [[prober, LevelRoute.ofTier(prober, config, plan)] as const];
			}),
		),
	);
	const routeKeys = new Map(
		[...levelRoutes.values(), ...proberRoutes.values()].map((level) => [level.key, level] as const),
	);
	const resolved = new Map(
		await Promise.all(
			[...routeKeys.values()].map(async (level) => [level.key, await routeOf(level, models)] as const),
		),
	);
	const routeAt = (lens: Lens, level: ScrutinyLevel) => levelRoutes.get(`${lens.name}@${lens.version}@${level}`)!;
	const routeFor = (lens: Lens, level: ScrutinyLevel) => resolved.get(routeAt(lens, level).key)!;
	// A prober on its level's tier runs on the level's route, the lens's own where it names one.
	const proberAt = (lens: Lens, level: ScrutinyLevel) => {
		const prober = lens.level(level).probe!.prober;
		return prober === undefined ? routeAt(lens, level) : proberRoutes.get(prober)!;
	};
	// A route the plan refuses has none, yet triage may still choose it: the lens then records the plan's refusal, as
	// it would at that level, rather than quietly run at another.
	const routed = (lens: Lens) => (_: LensTier, level: ScrutinyLevel) =>
		"route" in routeFor(lens, level) || routeAt(lens, level).refused;
	// A lens runs only at a level its band holds whose route reaches a model; with none, the review fails before any lens
	// runs, rather than run it below its floor.
	const unrouted = (lens: Lens) => (_: LensTier, level: ScrutinyLevel) => {
		const route = routeFor(lens, level);
		return "unrouted" in route ? route.unrouted : undefined;
	};
	// Levels the band holds that triage could not offer, by lens, noted on its record so coverage never shrinks unseen.
	const unrunnable = new Map<Lens, string[]>();
	const runnable = new Map(
		covering.map(({ lens }) => {
			const band = bands.get(lens)!;
			const levels = lens.runnableLevels(band, routed(lens));
			if (levels.length === 0) throw noLevel(lens.name, band, lens.unrunnable(band, unrouted(lens)));
			// The level the lens runs at without a decision must run, as it had to before triage, so a missing model
			// fails the review rather than quietly moving the lens to a lighter level.
			const fallback = band.bound(defaultScrutinyLevel, band.holds(lens.declaredLevels()));
			if (fallback !== "skip" && !levels.includes(fallback)) {
				const { tier } = lens.level(fallback);
				throw noLevel(
					lens.name,
					band,
					`its default level, ${fallback}, runs on ${routeAt(lens, fallback).on}, and ${unrouted(lens)(tier, fallback)}`,
				);
			}
			// Without a decider the lens runs at its default level, so a level it could not have chosen changes nothing.
			const dropped =
				options.decider === undefined
					? []
					: band.holds(lens.declaredLevels()).filter((level) => !levels.includes(level));
			unrunnable.set(
				lens,
				dropped.map((level) => {
					const { tier } = lens.level(level);
					return `triage could not choose ${level}, since ${level} runs on ${routeAt(lens, level).on}, and ${unrouted(lens)(tier, level)}`;
				}),
			);
			return [lens, levels] as const;
		}),
	);
	// Whether probes may run for this review, asked once and only when a level that probes runs: for a head the host
	// allows, under trusting policy, on a sandbox that runs here.
	// What a probe may read and whether policy trusts writers come from the base, never from the change, whoever vouches
	// for it: the allowlist decides what of the reviewer's machine a probe reads, by the maintainer's ruling of 2026-11-10.
	let basePolicy: Promise<MelianConfig> | undefined;
	// The base is the policy revision the host named, as a pull request's base tip, or the merge base; never a worktree.
	const policyBase = options.policy?.kind === "revision" ? options.policy.commit : base;
	const baseConfig = () =>
		(basePolicy ??= loadConfig(repoRoot, { kind: "revision", commit: policyBase }, ".").then(
			({ config: policy }) => policy,
		));
	let probesAsked: Promise<string | undefined> | undefined;
	const probeRefused = () =>
		(probesAsked ??= baseConfig().then((policy) => probeRefusal(request, policy, { repoRoot, head })));
	// Why a level that probes runs without them here: probes may not run, or its prober's tier reaches no model, or the
	// plan refuses that tier. It then runs as it would without `probe`, and its record says why.
	const withoutProbes = async (lens: Lens, level: ScrutinyLevel, settings: LensLevel): Promise<string | undefined> => {
		const refused = await probeRefused();
		if (refused !== undefined) return `${level} ran without probes, which cannot run here: ${refused}`;
		const prober = proberAt(lens, level);
		const planned =
			settings.probe!.prober === undefined
				? plan?.judge(lens.name, level, undefined, lens.scope).refusal
				: plan?.refusal(settings.probe!.prober);
		if (planned !== undefined)
			return `${level} ran without probes, since the plan refuses its prober's tier, ${prober.on}: ${planned}`;
		const route = resolved.get(prober.key)!;
		return "route" in route
			? undefined
			: `${level} ran without probes, since its prober runs on ${prober.on}, and ${route.unrouted}`;
	};
	const triageInput = prompt.renderInput(undefined, { tools: false });
	spans.end();
	const triaged =
		options.decider === undefined || covering.length === 0
			? {}
			: await triage(
					harness,
					reviewed,
					options.decider,
					{
						questionSet: triageQuestionSet,
						state: [triageBoundary(nonce), "## The change", triageInput.text].join("\n\n"),
						questions: sharedQuestions(
							covering.map(({ lens }) => lens.triageQuestion(bands.get(lens)!, runnable.get(lens)!)),
						),
					},
					triageInput.cut,
					options.rerun === true,
					context,
					options.triageProviders ?? [],
					unlockModels,
				);
	spans.step("lenses.prepare");
	const choices = new Map(
		covering.map(({ lens }) => {
			const levels = runnable.get(lens)!;
			const choice = lens.triage(bands.get(lens)!, levels, triaged.decision);
			return [lens, triageInput.cut && choice === "skip" ? levels[0]! : choice] as const;
		}),
	);
	// The plan judges each lens at the level triage chose for it: a lens it refuses there records `failed` with the
	// plan's reason and lineage, and asks no model.
	const refusals = new Map<string, CheckRecord>();
	const refused = new Set<Lens>();
	for (const { lens } of covering) {
		const level = choices.get(lens);
		if (plan === undefined || level === undefined || level === "skip") continue;
		const { refusal: reason, lineage } = plan.judge(lens.name, level, undefined, lens.scope);
		if (reason === undefined) continue;
		refused.add(lens);
		if (refusals.has(`${lens.name}@${lens.version}`)) continue;
		const name = `lens.${lens.name}`;
		refusals.set(`${lens.name}@${lens.version}`, {
			name,
			version: lens.version,
			status: "failed",
			level,
			reason,
			...(lineage === undefined ? {} : { lineage }),
		});
	}
	// A lens triage skipped or the plan refused is not running, so no lens hands it a defect.
	const running = covering.filter(({ lens }) => choices.get(lens) !== "skip" && !refused.has(lens));
	const skipped = covering.filter(({ lens }) => choices.get(lens) === "skip").map(({ lens }) => lens.name);
	// Read once for the review, and only when a level that probes runs.
	let probingRead: Promise<{ decisions: string; earlier: EarlierFinding[] }> | undefined;
	const probingContext = () =>
		(probingRead ??= (async () => ({
			decisions: (await spans.time("probing.decisions", () => DecisionFiles.load(repoRoot, base))).render(),
			earlier: await earlierFindings(harness, root, reviewed, context),
		}))());
	const lenses: LensRun[] = [];
	const notes = new Map<string, string[]>();
	// Each running lens, by name, to the lenses whose instructions could have handed it defects: the hand-off that rendered.
	const handedBy = new Map<string, string[]>();
	const leading = new Map<string, number>();
	const callerNotes: Record<string, string[]> = {};
	for (const { lens, coverage: configured, files, moved, covers } of running) {
		const coverage = moved.length === 0 ? configured : { ...configured, moved };
		// A neighbour takes defects off this lens only in the files it reviews too; this lens keeps them in the rest,
		// rather than leave them unreviewed where the neighbour's paths do not reach.
		const neighbours = [...new Set(running.map((other) => other.lens.name))].flatMap((name): LensNeighbour[] => {
			if (name === lens.name) return [];
			const theirs = new Set(running.flatMap((other) => (other.lens.name === name ? other.covers : [])));
			// A neighbour over a renamed file's head path covers its old path too, as one over the old path covers the head.
			for (const file of changeset.revision.files)
				if (file.oldPath !== undefined && theirs.has(file.path)) theirs.add(file.oldPath);
			const shared = covers.filter((file) => theirs.has(file));
			if (shared.length === 0) return [];
			return [{ name, files: shared.length === covers.length ? "every" : shared }];
		});
		const standardsFiles = [
			...covers,
			...changeset.revision.files
				.filter((file) => file.oldPath !== undefined && covers.includes(file.path))
				.map((file) => file.oldPath!),
		];
		const reading = lens.standards
			? standards instanceof Standards
				? standards.forFiles(standardsFiles)
				: StandardsReading.from(standards)
			: StandardsReading.from([]);

		const noted: string[] = [...(unrunnable.get(lens) ?? [])];
		if (config.static.enola.enabled)
			callerNotes[`${lens.name}@${lens.version}`] = options.callers?.notes(covers) ?? [
				"Callers unavailable: the host supplied no graph context",
			];
		const omitted = reading.note();
		if (omitted !== undefined) noted.push(omitted);
		if (options.decider !== undefined && triageInput.cut) noted.push("triage input was cut, so no lens could skip");

		if (triaged.failure !== undefined)
			noted.push(`triage failed, so it ran at its default level: ${triaged.failure}`);
		if (options.decider === undefined && options.triageSkipped !== undefined)
			noted.push(`triage did not run, so it ran at its default level: ${options.triageSkipped}`);
		const oversized = lens.oversizedHandoffs(neighbours);
		for (const { name } of neighbours) {
			if (Object.hasOwn(lens.handoffs, name) && !oversized.includes(name))
				handedBy.set(name, [...new Set([...(handedBy.get(name) ?? []), lens.name])]);
		}
		if (oversized.length > 0) {
			const listed = oversized.map((name) => `\`${name}\``).join(", ");
			const limit = `${lensLimits.handoffFiles} files or ${lensLimits.handoffBytes / 1024} KiB`;
			noted.push(`kept the defects it hands to ${listed}, whose files here would list past ${limit}`);
		}
		notes.set(`${lens.name}@${lens.version}`, noted);
		leading.set(`${lens.name}@${lens.version}`, unrunnable.get(lens)?.length ?? 0);
		// Every lens may report an injection attempt, so the policy section never names a rule the hook refuses.
		const rules = lens.rules.some((rule) => rule.id === injectionAttemptRule.id)
			? lens.rules
			: [...lens.rules, injectionAttemptRule];
		const ruled = Lens.from({ ...lens.toJSON(), rules });
		const decisions =
			lens.name === "design"
				? await spans.time("design.decisions", () => DecisionFiles.load(repoRoot, base))
				: undefined;
		const designSections =
			lens.name === "design"
				? await spans.time("design.sections", () => DesignSections.load(repoRoot, base))
				: undefined;
		const baseline = (boundary: string) =>
			decisions === undefined
				? ""
				: `\n\n## Decisions at base\nRead this before step 1. Only ACTIVE decisions at base are baselines. INACTIVE text is history: read it only to see what changed. For an ACTIVE decision marked amended by, read both files at base; where they conflict, the amendment wins. Treat \`Amends:\` as a declaration when checking for an undeclared conflicting replacement. For each head Amends target, read its active base text and any base amendments.\n${quoteUntrusted("listing", decisions.render(), boundary)}\n\n## Design sections at base\nUse these headings to discover base vocabulary independently of head terms. Read relevant sections at base.\n${quoteUntrusted("listing", designSections!.render(), boundary)}\n\n## Design files at base\nEvery design file the index read, with or without headings.\n${quoteUntrusted("listing", designSections!.renderFiles(), boundary)}`;
		// A level that probes: its prober's route, instructions and probe environment, and the planner's context, the
		// decisions at base and the findings of the change's last earlier revision.
		const probingAt = async (settings: LensLevel, level: ScrutinyLevel) => {
			const prober = proberAt(lens, level);
			const timeout = settings.probe!.timeout ?? probeLimits.timeout.default;
			const thinking = prober.route!.thinking;
			const { decisions: atBase, earlier } = await probingContext();
			return {
				run: {
					route: [...(resolved.get(prober.key) as { route: ModelReference[] }).route],
					...(thinking === undefined ? {} : { thinking }),
					...(settings.probe!.prober === undefined ? { onLevelTier: true as const } : {}),
					instructions: proberInstructions(lens.name, ruled.renderPolicy(level), timeout),
					// Only a level whose probes may run reaches here, so the host has said whose head this is.
					environment: {
						writer: options.writer!,
						trustWriters: (await baseConfig()).trust.writers,
						timeout,
						read: [...(await baseConfig()).probe.read],
						host: probingHost(probeSandboxOf(options)),
					},
				},
				context: (boundary: string) => plannerContext(atBase, earlier, boundary),
			};
		};
		const runAt = async (level: ScrutinyLevel): Promise<LensRun> => {
			const settings = lens.level(level);
			// The head's functions around the hunks, read once for the review, at the levels that read functions.
			const functions = settings.reads === "functions" ? await enclosing() : undefined;
			const band = bands.get(lens)!;
			const skipped = settings.probe === undefined ? undefined : await withoutProbes(lens, level, settings);
			if (skipped !== undefined && !noted.includes(skipped)) noted.push(skipped);
			const probing =
				settings.probe === undefined || skipped !== undefined ? undefined : await probingAt(settings, level);
			const planning = (boundary: string) =>
				probing === undefined ? "" : `\n\n${plannerInstructions(probing.context(boundary))}`;
			return {
				key: `${lens.name}@${lens.version}@${level}`,
				band: `${band.floor}-${band.ceiling}`,
				name: lens.name,
				version: lens.version,
				level,
				...(routeAt(lens, level).route?.thinking === undefined
					? {}
					: { thinking: routeAt(lens, level).route!.thinking! }),
				route: [...(routeFor(lens, level) as { route: ModelReference[] }).route],
				verify: settings.verify,
				instructions:
					ruled.renderInstructions(
						reading.sections,
						level,
						neighbours,
						(text, label = "listing") => quoteUntrusted(label, text, nonce),
						standardsSource,
						options.callers?.render(covers, nonce),
					) +
					baseline(nonce) +
					planning(nonce),
				instructionFingerprint: createHash("sha256")
					.update(
						JSON.stringify({
							instructions:
								ruled.renderInstructions(
									reading.sections,
									level,
									neighbours,
									(text, label = "listing") => quoteUntrusted(label, text, "0".repeat(24)),
									standardsSource,
								) +
								// The planner's decisions and earlier findings move between reviews of one head, as caller context
								// does, so they stay out of the key; the probe field below holds the fixed probing protocol.
								baseline("0".repeat(24)),
							standards: reading.sections,
							standardsOmitted: reading.omitted.length > 0,
							source: standards instanceof Standards ? standards.source : null,
							trusted: standardsSource,
							tools: lens.tools,
							severities: lens.severities,
							rules,
							budget: settings.budget,
							coverage,
							prompt: new ChangePrompt(changeset, "0".repeat(24)).render(files),
							probe:
								probing === undefined
									? undefined
									: { ...probing.run, environment: undefined, protocol: probingProtocol() },
						}),
					)
					.digest("hex"),
				standards: reading.paths(),
				standardsOmitted: reading.omitted.length > 0,
				tools: lens.tools,
				severities: lens.severities,
				rules,
				budget: settings.budget,
				coverage,
				prompt: prompt.render(files, { ...(functions === undefined ? {} : { functions }) }),
				...(functions?.unavailable === undefined ? {} : { unread: functions.unavailable }),
				...(probing === undefined ? {} : { probe: probing.run }),
			};
		};
		const level = choices.get(lens) as ScrutinyLevel;
		const first = await runAt(level);
		if (level !== "quick") {
			lenses.push(first);
			continue;
		}
		const next = lens.escalation(level, bands.get(lens)!);
		// The plan judges the escalation's next level as it judged the first: a level it refuses caps the escalation.
		const nextRefusal = next === undefined ? undefined : plan?.judge(lens.name, next, undefined, lens.scope).refusal;
		const escalation =
			next === undefined
				? {}
				: nextRefusal !== undefined
					? { cap: `since the plan refuses ${next}: ${nextRefusal}` }
					: !("route" in routeFor(lens, next))
						? {
								cap: `since ${next} runs on ${routeAt(lens, next).on}, which reaches no model with credentials`,
							}
						: { next: await runAt(next) };
		lenses.push({ ...first, escalation });
	}
	const state: ReviewState = {
		repoRoot,
		nonce,
		base: revision.base,
		head,
		files: reviewFiles(revision.files),
	};
	const { escalateAt } = config.triage;
	const coverageSource = options.callers?.coverageSource();
	const callerCaveat =
		options.callers === undefined ? `${blindCallers}: the host supplied no graph context` : options.callers.caveat();
	const callersInput: StoredCallers | undefined = config.static.enola.enabled
		? {
				notes: callerNotes,
				...(callerCaveat === undefined ? {} : { caveat: callerCaveat }),
				...(coverageSource ? { coverage: coverageSource } : {}),
			}
		: undefined;
	// The verification candidates of what `producers` sighted, each with the finder its lens run and outcome name. A
	// wave asks for the lenses that have ended, and the final step for every lens.
	const candidatesFor = async (
		producers: Producer[],
		lensResult: LensResult | undefined,
		runs: readonly LensRun[],
	) => {
		// As the lenses reported them: a lowering stored by a verification this review attaches to must not change which
		// finding speaks for a defect, or the candidates would read as new input and the stored judgements be cleared.
		const storedFindings = await readFindings(harness, root, reviewed, context, { producers, asReported: true });
		const policies =
			options.policy === undefined
				? undefined
				: await configsFor(repoRoot, options.policy, storedFindings).catch((error: unknown) => {
						throw new ReviewError("adjudicationFailed", error instanceof Error ? error.message : String(error), {
							lenses: [],
							findings: storedFindings,
						});
					});
		const configFor: ConfigFor = policies ?? (() => config);
		const allRuns = runsOf(runs);
		const candidates: VerificationCandidate[] = [];
		const designRules = new Set(
			(await Lens.builtins())
				.filter((lens) => lens.name === "design")
				.flatMap((lens) => lens.rules.map((rule) => rule.id)),
		);
		let decisionsAtBase: string | undefined;
		let designAtBase: VerificationCandidate["designAtBase"];
		const predecessors = await Predecessors.open(harness, root, reviewed, state, context);
		const restating = new Map<string, Restating>();
		for (const defect of new Merge(storedFindings, configFor, changeset.revision).defects()) {
			if (defect.speaker.properties.status === "dismissed") continue;
			const candidateState = VerificationState.from(defect.speaker).toJSON();
			if (
				!candidateState.claims.some((claim) => {
					const run = allRuns.find((each) => {
						const source = lensSource(each.name, each.version, each.level);
						return source.check === claim.source.check && source.version === claim.source.version;
					});
					return (
						run !== undefined &&
						((run.verify ??
							covering
								.find(({ lens }) => lens.name === run.name && lens.version === run.version)
								?.lens.level(run.level ?? defaultScrutinyLevel).verify ??
							run.level !== "quick") ||
							producers.some(
								(producer) =>
									producer.check === claim.source.check &&
									producer.version === claim.source.version &&
									producer.ids?.includes(claim.id),
							))
					);
				})
			)
				continue;
			const finderClaim =
				candidateState.claims.find(
					(claim) =>
						claim.source.check === defect.speaker.properties.source.check &&
						claim.source.version === defect.speaker.properties.source.version,
				) ?? candidateState.claims[0]!;
			const run = allRuns.find((each) => {
				const source = lensSource(each.name, each.version, each.level);
				return source.check === finderClaim.source.check && source.version === finderClaim.source.version;
			})!;
			const outcome = lensResult?.[run.key];
			// A probing run's findings come from its prober, so the verifier is chosen against the prober's model, and against
			// its route when the run failed before naming the model it finished on.
			const finder =
				outcome?.status === "done" && (outcome.probing?.model ?? outcome.model) !== undefined
					? (outcome.probing?.model ?? outcome.model)!
					: modelName((run.probe?.route ?? run.route)[0]!);
			let route = request.plan?.verifierRoute(finder).map(({ model }) => parseModelReference(model, "verifier"));
			if (route === undefined) {
				const configured = config.models.verifier;
				if (
					configured !== undefined &&
					(configured.thinking === undefined || configured.model !== undefined || configured.accept !== undefined)
				) {
					const resolved = resolveModelForTier("verifier", config.models);
					route = [resolved.model, ...resolved.fallbacks];
				} else route = [...(run.probe?.route ?? run.route)];
			}
			const available: ModelReference[] = [];
			const collection = modelsOf(models);
			for (const model of route)
				if (
					collection.getModel(model.provider, model.modelId) !== undefined &&
					// A store that cannot be read passes the candidate over, as an absent credential does.
					(await hasCredentials(models, model.provider).catch(() => false))
				)
					available.push(model);
			const designClaim = candidateState.claims.some(
				(claim) => claim.source.check === "lens.design" || designRules.has(claim.ruleId),
			);
			if (designClaim) {
				decisionsAtBase ??= (await DecisionFiles.load(repoRoot, base)).render();
				if (designAtBase === undefined) {
					const sections = await DesignSections.load(repoRoot, base);
					designAtBase = { sections: sections.render(), files: sections.renderFiles() };
				}
			}
			const probed = await claimProbes(harness, candidateState.claims, allRuns, lensResult, context);
			const restatement = await predecessors.of(defect);
			if (restatement !== undefined) restating.set(defect.speaker.id, restatement.restating);
			candidates.push({
				...(designClaim ? { decisionsAtBase, designAtBase } : {}),
				...probed,
				key: defect.speaker.id,
				state: candidateState,
				finder,
				route: available,
				...(config.models.verifier?.thinking === undefined ? {} : { thinking: config.models.verifier.thinking }),
				budget: { ...verificationBudget },
				fence: {
					coReported: !defect.lensOnly(),
					silent: defect.silentAt(configFor),
				},
				...(restatement === undefined
					? {}
					: {
							dismissed: restatement.dismissed,
							dismissals: Object.fromEntries(
								restatement.restating.dismissed.map(({ id, dismissal }) => [id, dismissal]),
							),
						}),
			});
		}
		return { storedFindings, policies, candidates, restating };
	};
	const verifierRefuses = (model: string) =>
		request.plan?.tier("verifier").acceptOverridden === false &&
		request.plan.verifierLineage(model)?.outside === true;
	// Verifies each lens's claims as its lens ends, while slower lenses run. A defect a later lens joins is a new
	// candidate, which the next wave verifies again with every sighting; the final step reuses each wave outcome whose
	// candidate it still holds. Any failure here leaves the work to the final step.
	const startedWaves: number[] = [];
	const verifyAsLensesEnd = async (task: number, done: Promise<unknown>) => {
		if (request.plan?.refusal("verifier") !== undefined) return;
		const record = await harness.getTask(task as TaskId, context);
		if (record === undefined || record.state.status === "terminal") return;
		const runs = record.input as unknown as StoredLensTaskInput;
		// A level that probes has each claim's probe run again before the verifier reads it, which the final step does.
		if (runsOf(runs.lenses).some((run) => run.probe !== undefined)) return;
		const rule = new EscalationRule(runs.escalateAt ?? escalateAt);
		const stored = new Map(runs.lenses.map((run) => [run.key, run]));
		await (await harness.root(context)).commit(async (tx) => {
			if ((await tx.doc(ReviewIndex, root)).reviews[reviewed]?.task === task)
				await VerificationWaves.open(tx, root, reviewed, task);
		}, context);
		const watch = await harness.watchDoc(VerificationWavesDocument, root, context);
		if (watch === undefined) return;
		let wake = () => {};
		let finished = false;
		const stop = () => {
			finished = true;
			wake();
		};
		done.then(stop, stop);
		watch.start(async () => wake());
		let seen = 0;
		try {
			for (;;) {
				const changed = new Promise<void>((resolve) => {
					wake = resolve;
				});
				if (finished) return;
				const read = async () =>
					VerificationWaves.of(await harness.snapshot(VerificationWavesDocument, root, context), reviewed, task);
				// One wave at a time: the verifier's cap of eight conversations holds per revision, and a wave never clears
				// claims an earlier one is still judging. Waiting on a finished wave returns at once.
				const running = (await read()).tasks().at(-1);
				if (running !== undefined) await harness.waitForTask(running as TaskId, context);
				const waves = await read();
				const ended = waves.ended() as unknown as LensResult;
				if (Object.keys(ended).length > seen) {
					seen = Object.keys(ended).length;
					const settledEnded = lenses
						.map((lens) => stored.get(lens.key) ?? lens)
						.filter((first) => ended[first.key] !== undefined)
						.map((first) => settle(first, ended, rule));
					const { producers } = account(manifest, settledEnded, { records: [], skippable: [] }, options);
					const { candidates } = await candidatesFor(producers, ended, runs.lenses);
					// startWave keeps only the candidates no wave already stands for.
					const started =
						candidates.length > 0 && candidates.every((candidate) => candidate.route.length > 0)
							? await startWave(
									harness,
									{ root, revision: runs.revision, version: verifierVersion, candidates },
									task,
									context,
									unlockModels,
								)
							: undefined;
					if (started !== undefined) startedWaves.push(started);
				}
				await changed;
			}
		} catch {
			return;
		} finally {
			await watch.stop();
		}
	};
	const lensInput = new LensTaskInput(root, state, lenses, escalateAt, callersInput).toJSON();
	spans.end();
	const {
		result: lensResult,
		ran,
		task: lensTask,
	} = lenses.length === 0
		? { result: {} as LensResult, ran: lensInput, task: undefined }
		: await runLenses(
				harness,
				lensInput,
				options.rerun === true,
				context,
				(key, model, role) => {
					const run = runsOf(lenses).find((each) => each.key === key);
					// A prober on a tier of its own is held to that tier by its route, as adjudication judges it.
					if (role === "prober" && run?.probe?.onLevelTier !== true) return false;
					const judged =
						run === undefined ? undefined : request.plan?.judge(run.name, run.level, model, run.coverage.scope);
					return judged?.refusal !== undefined;
				},
				unlockModels,
				verifyAsLensesEnd,
				request.lensesStarted,
			);
	// Escalation is settled from the runs the task stored, which decided it, never from this call's own computation.
	// Every wave this review started settles before the next step starts, so no step of the host's overlaps its
	// verifier. Another run's wave is waited for only when the final step reuses it.
	for (const wave of startedWaves) await harness.waitForTask(wave as TaskId, context);
	const waves = VerificationWaves.of(
		await harness.snapshot(VerificationWavesDocument, root, context),
		reviewed,
		lensTask,
	);
	const rule = new EscalationRule(ran.escalateAt ?? escalateAt);
	const stored = new Map(ran.lenses.map((run) => [run.key, run]));
	const settling = lenses.map((lens) => settle(stored.get(lens.key) ?? lens, lensResult, rule));
	// The change triage reads can steer it, so a review in which every lens stayed at quick says so.
	const light =
		triaged.decision !== undefined &&
		settling.length === selected.length &&
		settling.every(({ run }) => run.level === "quick")
			? [lightTriage]
			: [];
	spans.step("callers.coverage");
	// The task's own input says what its lenses read, so a call that attached to another's task records that call's.
	const rendered = ran.callers;
	const callers = await callersFor(
		harness,
		lensInput,
		lensTask,
		lenses.length > 0 && lensResult !== undefined,
		rendered ?? callersInput ?? { notes: callerNotes },
		async () => {
			try {
				const source = rendered === undefined ? options.callers : CallerContext.restore(rendered.coverage);
				const coverage = await source?.recordCoverage({
					harness,
					children: Object.fromEntries(
						Object.entries(lensResult ?? {}).flatMap(([key, outcome]) =>
							outcome.conversation === undefined ? [] : [[key, outcome.conversation]],
						),
					),
					lenses: ran.lenses.flatMap((lens) => {
						const next = lens.escalation?.next;
						return [lens, ...(next && lensResult?.[next.key] !== undefined ? [next] : [])];
					}),
					files: revision.files,
					nonce: ran.revision.nonce,
					context,
				});
				return coverage ? { coverage } : {};
			} catch {
				return { coverageUnavailable: true as const };
			}
		},
		context,
	);
	spans.step("verification.prepare");
	const settled = settling.map((settledLens) => {
		const { run } = settledLens;
		const key = `${run.name}@${run.version}`;
		const noted = notes.get(key) ?? [];
		const at = leading.get(key) ?? 0;
		const unread = settledLens.run.unread === undefined ? [] : [unreadFunctions(settledLens.run.unread)];
		return {
			...settledLens,
			notes: [
				...noted.slice(0, at),
				...(callers.notes[key] ?? []),
				...noted.slice(at),
				...unread,
				...settledLens.notes,
				...light,
			],
		};
	});
	const caveats = [...(callers.caveat === undefined ? [] : [callers.caveat]), ...light];
	const records = [
		...settled.map(({ run, outcome, notes: noted }) =>
			lensCheck(run, outcome, lensResult !== undefined, noted, handedBy.get(run.name) ?? [], caveats),
		),
		...skipped.map(
			(name): CheckRecord => ({
				name: `lens.${name}`,
				status: "skipped",
				reason: "triage skipped it, as its floor allows",
			}),
		),
		...refusals.values(),
	];
	if (callers.coverage)
		for (let index = 0; index < settled.length; index++)
			records[index] = { ...records[index]!, coverage: callers.coverage };
	if (callers.coverageUnavailable)
		for (let index = 0; index < settled.length; index++)
			records[index] = {
				...records[index]!,
				reason: [records[index]!.reason, "Review coverage unavailable: transcript or cache could not be read"]
					.filter(Boolean)
					.join("; "),
			};
	// Only the lenses this review ran count, each at the level whose record stands for it: one that configuration has
	// since disabled or retiered, or a quick run that escalated, leaves nothing behind.
	const { manifest: accounted, producers } = account(
		manifest,
		settled,
		{
			records,
			skippable: skipped.map((name) => `lens.${name}`),
			...(triaged.decision === undefined
				? {}
				: {
						triagedBy: triaged.decision.decider.startsWith("llm-fallback")
							? "the LLM fallback"
							: triaged.decision.decider,
					}),
		},
		options,
	);
	await (await harness.root(context)).commit(
		(tx) =>
			reopenDismissals(
				tx,
				root,
				reviewed,
				state.files.flatMap((file) => file.hunks.map(provingHunk)),
			),
		context,
	);
	const { storedFindings, policies, candidates, restating } = await candidatesFor(producers, lensResult, ran.lenses);
	let verificationCheck: CheckRecord | undefined;
	let verificationRefused = false;
	let verifying: TaskId<VerificationResult> | undefined;
	let verifierSuperseded = false;
	if (candidates.length === 0) {
		const previous = (await harness.snapshot(ReviewIndex, root, context))?.reviews[reviewed]?.verification;
		if (previous !== undefined) {
			const owner = await harness.root(context);
			await owner.commit(async (tx) => {
				const index = await tx.doc(ReviewIndex, root);
				const entry = index.reviews[reviewed];
				if (entry?.verification?.task === previous.task) index.reviews[reviewed] = omit(entry, "verification");
			}, context);
			await abortReplacedRuns(harness, context);
		}
	}
	if (candidates.length > 0) {
		const refusal = request.plan?.refusal("verifier");
		const missing = candidates.some((candidate) => candidate.route.length === 0);
		if (refusal !== undefined || missing) {
			verificationRefused = true;
			verificationCheck = {
				name: "verifier",
				status: "failed",
				version: verifierVersion,
				reason: refusal ?? "the verifier has no model with credentials",
				...(request.plan?.lineage("verifier") === undefined ? {} : { lineage: request.plan.lineage("verifier")! }),
			};
		} else {
			if (!(await rerunProbes(harness, root, state, candidates, lensTask, context)))
				throw new ReviewError(
					"superseded",
					`a later review of ${reviewed} replaced this one's lens run, so this review records no verdict`,
					{ lenses: lenses.map((lens) => lens.name) },
				);
			const reused: Record<string, VerificationResult[string]> = {};
			// The dismissals each reused wave was shown, by candidate.
			const shownTo = new Map<string, Record<string, string>>();
			for (const candidate of candidates) {
				const wave = waves.standing(
					JSON.stringify(candidateIdentity(candidate)),
					candidate.state.claims.map(claimKey),
					verifierVersion,
				);
				// A wave another run started, a crashed one's included, is waited for only where it would be reused.
				const record = wave === undefined ? undefined : await harness.waitForTask(wave as TaskId, context);
				const outcome =
					record?.state.status === "terminal" && record.state.outcome.status === "completed"
						? (record.state.outcome.result as VerificationResult)[candidate.key]
						: undefined;
				if (outcome === undefined) continue;
				// A rerun asks again for what a wave left unanswered, as it would of a final task.
				if (options.rerun === true && (outcome.status !== "done" || verifierRefuses(outcome.model))) continue;
				reused[candidate.key] = outcome;
				const shown = (record!.input as unknown as VerificationInput).candidates.find(
					(each) => each.key === candidate.key,
				)?.dismissals;
				shownTo.set(candidate.key, shown ?? {});
			}
			const verificationInput: VerificationInput = {
				root,
				revision: ran.revision,
				version: verifierVersion,
				candidates,
				...(Object.keys(reused).length === 0 ? {} : { reused }),
			};
			const own = new Set<string>();
			for (const wave of startedWaves)
				for (const candidate of (
					(await harness.getTask(wave as TaskId, context))!.input as unknown as VerificationInput
				).candidates)
					own.add(JSON.stringify(candidateIdentity(candidate)));
			const attached = (await harness.snapshot(ReviewIndex, root, context))?.reviews[reviewed]?.verification?.task;
			spans.end();
			verifying = await startVerification(
				harness,
				verificationInput,
				selectionOf(lenses, escalateAt),
				options.rerun === true,
				context,
				verifierRefuses,
				unlockModels,
				own,
			);
			verifierSuperseded = verifying === undefined;
			// A final task this call starts stands on its reused waves' judgements, made under the dismissals each wave was
			// shown, whichever process started it; one replaced since is not the one judged. A final task this call attaches
			// to is re-derived under the dismissals this call read, as every round's is.
			if (verifying !== undefined && verifying !== attached)
				for (const [key, shown] of shownTo) {
					const fresh = restating.get(key);
					if (fresh !== undefined)
						restating.set(key, {
							...fresh,
							dismissed: fresh.dismissed.map(({ id }) => ({ id, dismissal: shown[id] ?? "" })),
						});
				}
			if (verifying === undefined)
				verificationCheck = { name: "verifier", status: "failed", version: verifierVersion, reason: "superseded" };
			else {
				await abortReplacedRuns(harness, context);
				await refuseIfBlocked(
					harness,
					verifying,
					[],
					inIndex((index) => {
						const entry = index.reviews[reviewed];
						if (entry?.verification?.task === verifying) index.reviews[reviewed] = omit(entry, "verification");
					}),
					context,
				);
				const finished = (await harness.waitForTask(verifying, context)).state.outcome;
				const results = finished.status === "completed" ? (finished.result as VerificationResult) : {};
				const ended = Object.values(results).find((result) => result.status === "ended");
				const failed = candidates
					.map((candidate) => results[candidate.key])
					.find((result) => result?.status !== "done");
				verificationCheck =
					ended?.status === "ended"
						? { name: "verifier", status: "ended", version: verifierVersion, budgetEnded: ended.budgetEnded }
						: Object.keys(results).length !== candidates.length || failed !== undefined
							? {
									name: "verifier",
									status: "failed",
									version: verifierVersion,
									reason:
										failed !== undefined && "reason" in failed
											? failed.reason
											: "the verification task did not complete",
								}
							: { name: "verifier", status: "ran", version: verifierVersion };
				const completed = Object.values(results).filter((result) => result.status === "done");
				const model =
					completed.find(
						(result) =>
							request.plan?.tier("verifier").acceptOverridden === false &&
							request.plan.verifierLineage(result.model)?.outside === true,
					) ?? completed[0];
				const lineage = request.plan?.verifierLineage(
					model?.status === "done" ? model.model : modelName(candidates[0]!.route[0]!),
				);
				if (lineage !== undefined) {
					verificationCheck = { ...verificationCheck, lineage };
					if (lineage.outside && request.plan?.tier("verifier").acceptOverridden === false)
						verificationCheck = {
							...verificationCheck,
							status: "failed",
							reason: "the verifier finished outside its guarded accepted route",
						};
				}
			}
		}
	}
	// Each round re-derives every restatement link from its own stored judgements, in one commit, before adjudication
	// reads the findings version. A verifier that did not run to the end judged no sameness, and leaves no links.
	// A review a later one replaced, by lens selection or by verification task, leaves the links that one recorded.
	await (await harness.root(context)).commit(async (tx) => {
		const entry = (await tx.doc(ReviewIndex, root)).reviews[reviewed];
		const selection = selectionOf(lenses, escalateAt);
		if (selection.length > 0 && entry?.lenses.join("\n") !== selection.join("\n")) return;
		if (verifierSuperseded || (verifying !== undefined && entry?.verification?.task !== verifying)) return;
		await recordInheritances(
			tx,
			root,
			reviewed,
			verificationCheck?.status === "ran" ? [...restating.values()] : [],
			verifierVersion,
		);
	}, context);
	spans.step("adjudication.prepare");
	const checks =
		request.plan?.mark(
			accounted.records(),
			ranOn(
				settled.map(({ run }) => run),
				lensResult,
			),
		) ?? accounted.records();
	const lensRan = (key: string) => {
		const outcome = lensResult?.[key];
		return outcome?.status === "done" ? outcome : undefined;
	};
	const lineageOf = (name: string, level: ScrutinyLevel) =>
		checks.find((check) => check.name === `lens.${name}` && check.level === level)?.lineage;
	const input = adjudicationInput({
		root,
		repoRoot,
		base,
		head,
		policy: options.policy,
		resolutionPolicy: policies?.fingerprint,
		config,
		manifest: verificationCheck === undefined ? manifest : [...manifest, "verifier"],
		checks: verificationCheck === undefined ? checks : [...checks, verificationCheck],
		verifierVersion,
		verificationRan: true,
		findingsVersion: await findingsVersion(harness, root, reviewed, context),
		allowSkip: accounted.skippable(),
		producers,
		origin: options.origin ?? { kind: "range" },
		lenses: settled.map(({ run }) => run.key),
		plan: request.plan,
		// Only the files the findings name: the review index stores this input for every revision.
		files: changeset.revision.outline(storedFindings),
	});
	// Recorded with the verdict by the adjudication task, so a run that a later review replaced leaves none behind.
	input.details = {
		policy: input.provenance.policy,
		manifest: [...input.manifest],
		lenses: settled
			.map(({ run }) => run)
			.map(({ key, name, version, level, route, budget, standards: paths }) => ({
				name,
				version,
				level,
				models: route.map(modelName),
				...(paths === undefined ? {} : { standards: [...paths] }),
				...(lensRan(key)?.model === undefined ? {} : { ran: lensRan(key)?.model }),
				...(lineageOf(name, level) === undefined ? {} : { lineage: describeLineage(lineageOf(name, level)!) }),
				...(lensRan(key)?.usage === undefined ? {} : { usage: structuredClone(lensRan(key)?.usage) }),
				budget: {
					findings: budget.findings,
					...(budget.tokens === undefined ? {} : { tokens: budget.tokens }),
					...(budget.tools === undefined ? {} : { tools: budget.tools }),
				},
			})),
		standards: [...new Set(settled.flatMap(({ run }) => run.standards ?? []))],
	};
	spans.end();
	const adjudication = await startAdjudication(
		harness,
		input,
		selectionOf(lenses, escalateAt),
		verificationRefused,
		JSON.stringify(checked?.identity ?? request.checkRun),
		context,
	);
	if (adjudication === undefined) {
		throw new ReviewError(
			"superseded",
			`a later review of ${reviewed} replaced this one's lens run, so this review records no verdict`,
			{ lenses: lenses.map((lens) => lens.name) },
		);
	}
	const rounds = (await harness.snapshot(RoundsDocument, root, context))!;
	spans.bindRound(Object.entries(rounds.items).find(([, round]) => round.tasks.includes(adjudication))![0]);
	if (verificationRefused) await abortReplacedRuns(harness, context);
	const forget = (index: ReviewIndexState) => {
		const entry = index.reviews[reviewed];
		if (entry?.adjudication?.task !== adjudication) return;
		index.reviews = { ...index.reviews, [reviewed]: omit(entry, "adjudication") };
	};
	await refuseIfBlocked(harness, adjudication, [], inIndex(forget), context);
	const adjudicated = (await harness.waitForTask(adjudication, context)).state.outcome;
	spans.step("verdict.read");
	const findings = await readFindings(harness, root, reviewed, context, { producers });
	const verdict = await readVerdict(harness, root, reviewed, context);
	const superseded = adjudicated.status === "completed" && adjudicated.result === "superseded";
	if (adjudicated.status !== "completed" || superseded || verdict === undefined) {
		const why =
			adjudicated.status === "failed"
				? `: ${adjudicated.error.message}`
				: superseded
					? ": a later review of the head with other input replaced it"
					: "";
		throw new ReviewError("adjudicationFailed", `adjudication of ${reviewed} did not complete${why}`, {
			lenses: [],
			findings,
		});
	}
	const exhausted = settled.flatMap(({ run, outcome }) =>
		outcome?.status === "exhausted" ? [{ lens: run.name, ...outcome }] : [],
	);
	if (exhausted.length > 0) {
		const each = exhausted.map(
			({ lens, tried, reason }) => `lens ${lens} tried ${tried.join(", ")}; the last said: ${reason}`,
		);
		throw new ReviewError("allModelsFailed", `every model of a lens's tier failed: ${each.join("; ")}`, {
			lenses: exhausted.map(({ lens }) => lens),
			models: [...new Set(exhausted.flatMap(({ tried }) => tried))],
			findings,
			verdict,
		});
	}
	const failed = settled.filter(({ outcome }) => outcome?.status !== "done").map(({ run }) => run.name);
	if (failed.length > 0) {
		throw new ReviewError("lensFailed", `lenses did not finish: ${failed.join(", ")}`, {
			lenses: failed,
			findings,
			verdict,
		});
	}
	if (verificationCheck !== undefined && verificationCheck.status !== "ran")
		throw new ReviewError("verifierFailed", "the verifier did not judge every claim", {
			lenses: [],
			findings,
			verdict,
		});
	return { findings, verdict };
}
