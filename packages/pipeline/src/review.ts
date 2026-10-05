import {
	type Changeset,
	type CheckRecord,
	type ChoiceQuestion,
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
	type LensNeighbour,
	type LensRule,
	type LensTier,
	type LensToolName,
	LevelBand,
	lensLimits,
	Manifest,
	type MelianConfig,
	Merge,
	type ModelReference,
	ModelRoutingError,
	parseModelReference,
	type RepositorySource,
	type ReviewPlan,
	resolveModelForTier,
	type ScrutinyLevel,
	type Severity,
	type StandardsSection,
	triageChoices,
	triageQuestionSet,
	type Verdict,
	VerificationState,
	verificationBudget,
	visibleText,
} from "@melian-agent/core";
import {
	type AdjudicationResult,
	AdjudicationTask,
	type AdjudicationTaskInput,
	adjudicationInput,
	type ReviewOrigin,
	readVerdict,
	VerdictDocument,
} from "./adjudication.ts";
import { checksExtension } from "./checks.ts";
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
import { ReviewError } from "./errors.ts";
import {
	clearSightings,
	clearVerifications,
	FindingsDocument,
	findingsVersion,
	type Producer,
	readFindings,
	recordRevision,
	revisionKey,
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
	openHarness,
	type Registry,
	type Storage,
	type TaskId,
	type Tx,
	UsageDoc,
} from "./harness.ts";
import {
	budgetEnded,
	injectionPolicySection,
	LensDocument,
	lensPolicyHook,
	lensReadTools,
	lensSource,
	type ReviewState,
	reportFinding,
	reportVerdict,
	reviewFiles,
	type StoredBudgetEnd,
} from "./lens-tools.ts";
import { modelsOf, type ReviewModels } from "./models.ts";
import { attachable, ReviewIndex, type ReviewIndexState, undecided } from "./review-index.ts";
import { summarizeExtension } from "./summarize.ts";
import { injectionAttemptRule, quoteUntrusted, reviewNonce, triageBoundary } from "./untrusted.ts";
import {
	startVerification,
	type VerificationCandidate,
	type VerificationInput,
	type VerificationResult,
	VerificationTask,
} from "./verification.ts";
import { verifierVersion } from "./verification-instructions.ts";

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
	readonly verify?: boolean;
	readonly instructions: string;
	readonly tools: readonly LensToolName[];
	readonly severities: readonly Severity[];
	readonly rules: readonly LensRule[];
	readonly budget: LensBudget;
	readonly coverage: LensCoverage;
	// The change as this lens sees it: only the files it covers.
	readonly prompt: string;
	readonly escalation?: { readonly next?: LensRun; readonly cap?: string };
	// The band triage held the level to, as `<floor>-<ceiling>`; absent from a task an older Melian created.
	readonly band?: string;
}

// `escalateAt` is absent from a task an older Melian created, which escalates nothing.
interface StoredLensTaskInput {
	readonly root: ConversationId;
	readonly revision: ReviewState;
	readonly lenses: readonly LensRun[];
	readonly escalateAt?: Severity;
}

class LensTaskInput {
	readonly root: ConversationId;
	readonly revision: ReviewState;
	readonly lenses: readonly LensRun[];
	readonly escalateAt?: Severity;

	constructor(root: ConversationId, revision: ReviewState, lenses: readonly LensRun[], escalateAt?: Severity) {
		this.root = root;
		this.revision = revision;
		this.lenses = lenses;
		if (escalateAt !== undefined) this.escalateAt = escalateAt;
	}

	static upgrade(input: unknown): StoredLensTaskInput {
		const stored = input as StoredLensTaskInput;
		const lenses = stored.lenses.map(({ level: _, ...run }) => run) as unknown as LensRun[];
		return new LensTaskInput(stored.root, stored.revision, lenses, stored.escalateAt).toJSON();
	}

	toJSON(): StoredLensTaskInput {
		return {
			root: this.root,
			revision: this.revision,
			lenses: this.lenses,
			...(this.escalateAt === undefined ? {} : { escalateAt: this.escalateAt }),
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
			readonly escalation?: {
				readonly trigger: EscalationTrigger;
				readonly to?: string;
				// The IDs of the findings it carried to `to`, those `to` neither restated nor refuted, and those `to` refuted.
				readonly carried?: readonly string[];
				readonly kept?: readonly string[];
				readonly refuted?: readonly string[];
			};
			readonly usage?: { models: string[]; tokens: number; cost: number };
	  }
	| { readonly status: "unanswered"; readonly reason: string }
	| { readonly status: "exhausted"; readonly tried: string[]; readonly reason: string };

type StoredTrigger = { kind: "severity"; severity: Severity } | { kind: "budget"; budget: "tokens" | "tools" };

// Why a run escalated, and the IDs of the findings at or above `escalateAt` it carried to the next run.
type StoredEscalation = { trigger: StoredTrigger; carried: string[] };

// The findings a quick run carries to the run it escalated to, quoted as the change's data, since a model wrote them
// after reading the change, with how to confirm or refute each.
function carriedFindings(findings: readonly SightedFinding[], nonce: string): string {
	const listed = findings.map(
		(finding) =>
			`${finding.id} ${finding.severity} ${visibleText(finding.ruleId)} at ${visibleText(finding.path)}:${finding.line}-${finding.endLine}: ${visibleText(finding.message.split("\n")[0] ?? "")}`,
	);
	return [
		"## Findings a quicker look reported",
		"A quicker look at this change reported the findings below, and you were brought in to check them as well as review the change. Each line gives the finding's ID, severity, rule, and file with its first and last lines. For each, if it is a defect, report it with report_finding at the same file, lines, and rule, with its own failure scenario and evidence. If the code shows it is not a defect, report it with refuted set to its ID, at the same file, lines, and rule, with a failureScenario saying why it cannot fail and evidence holding the code that prevents it. A finding you leave unanswered stays in the review as the quicker look reported it.",
		quoteUntrusted("findings", listed.join("\n"), nonce),
	].join("\n\n");
}

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

type LensResult = Record<string, LensOutcome>;

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
	const tools = [...lens.tools.map((tool) => lensReadTools[tool]), reportFinding];
	// A task an older Melian created and a crash left in this phase holds only the findings budget, as a number.
	const stored = lens.budget as LensBudget | number;
	const budget = typeof stored === "number" ? { findings: stored } : stored;
	await configure(tx, created.id, {
		model: lens.route[0],
		instructions: lens.instructions,
		tools,
		extensions: [lensExtension],
	});
	(await tx.doc(LensDocument, created.id)).lens = {
		name: lens.name,
		version: lens.version,
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
	};
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
	for (const { record } of live) {
		const input = record.input as unknown as StoredLensTaskInput;
		const entry = index?.reviews[revisionKey(input.revision)];
		// An entry with no task is one a review that selected no lens rewrote: it names no run at all.
		const replaced =
			record.kind === VerificationTask.definition.name
				? entry?.verification?.task !== record.id
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
		if (index?.reviews[revisionKey(input)]?.adjudication?.task !== record.id) {
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
	const entry = (await reader.snapshot(ReviewIndex, input.root, context))?.reviews[revisionKey(input.revision)];
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
	version: 2,
	initial: () => ({ phase: "spawn" }),
	migrate: (input, checkpoint) => ({
		input: LensTaskInput.upgrade(input),
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
			const revision = revisionKey(input.revision);
			// One run on its conversation, from the attempt a crash left it at. A request ID per attempt: a rerun after a
			// crash finds the attempt it had reached, settled or not.
			const run = async (lens: LensRun, id: ConversationId, prompt: string): Promise<LensOutcome> => {
				const child = (await runtime.conversation(id, context))!;
				for (let attempt = started.attempts[lens.key] ?? 0; ; attempt++) {
					// A task a later review replaced asks no model again, even when a resume restarts it.
					if (await superseded(runtime, input, runtime.taskId, context)) {
						return { status: "unanswered", reason: "a later review of this revision replaced this run" };
					}
					const content = attempt === 0 ? prompt : continuePrompt;
					const request = { type: "input", content, requestId: `lens:${lens.key}:${attempt}` } as const;
					const settled = await (await child.submit(request, context)).wait(context);
					if (settled.status === "done") {
						const ended = await budgetEnded(runtime, id, context);
						const spend = (await runtime.snapshot(UsageDoc, id, context))?.models ?? {};
						const usage = {
							models: Object.keys(spend),
							tokens: Object.values(spend).reduce((sum, item) => sum + item.totalTokens, 0),
							cost: Object.values(spend).reduce((sum, item) => sum + item.cost.total, 0),
						};
						const model = modelName(lens.route[attempt]!);
						return { status: "done", model, usage, ...(ended === undefined ? {} : { budgetEnded: ended }) };
					}
					const reason = typeof settled.detail === "string" ? settled.detail : (settled.reason ?? "unanswered");
					const failover =
						settled.reason === "no_model" || (settled.reason === "model_error" && isFailoverError(reason));
					if (!failover) return { status: "unanswered", reason };
					const next = lens.route[attempt + 1];
					if (next === undefined) {
						const tried = lens.route.slice(0, attempt + 1).map(modelName);
						return { status: "exhausted", tried, reason };
					}
					await runtime.commit(async (tx, current) => {
						await configure(tx, id, { model: next });
						const checkpoint = current.state.checkpoint as ReviewCheckpoint;
						return {
							status: "running",
							checkpoint: { ...checkpoint, attempts: { ...checkpoint.attempts, [lens.key]: attempt + 1 } },
						};
					}, context);
				}
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
				const prompt =
					carried.length === 0
						? next.prompt
						: `${next.prompt}\n\n${carriedFindings(carried, input.revision.nonce)}`;
				const rerun = await run(next, child!, prompt);
				// A restatement is the same finding by its ID, or by its file, rule, and overlapping lines, since a run that
				// reported other lines of one defect hashes another snippet.
				const higher = await sighted(next);
				const restates = (finding: SightedFinding) =>
					higher.some(
						(each) =>
							each.id === finding.id ||
							(each.path === finding.path &&
								each.ruleId === finding.ruleId &&
								each.line <= finding.endLine &&
								finding.line <= each.endLine),
					);
				const restated = new Set(carried.filter(restates).map((finding) => finding.id));
				const reported = (await runtime.snapshot(LensDocument, child!, context))?.spend?.refuted ?? [];
				const refuted = reported.filter((id) => escalation.carried.includes(id) && !restated.has(id));
				const kept = escalation.carried.filter((id) => !restated.has(id) && !refuted.includes(id));
				const moved = { trigger, to: next.key, carried: escalation.carried, kept, refuted };
				return [
					[first.key, { ...outcome, escalation: moved }],
					[next.key, rerun],
				];
			};
			const chains = await Promise.all(input.lenses.map(chain));
			const result = Object.fromEntries(chains.flat());
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/**
 * The extension a review harness needs: the lens task, the lens tools, `report_finding`, the hook that holds each lens
 * to its policy, and the adjudication task. {@link ReviewHarness} installs it; a host building its own registry
 * installs it there.
 */
export const lensExtension = defineExtension({
	name: "melian.lenses",
	tools: [...Object.values(lensReadTools), reportFinding, reportVerdict],
	sections: [injectionPolicySection],
	hooks: [lensPolicyHook],
	tasks: [LensTask, VerificationTask, AdjudicationTask],
});

/** A registry holding {@link lensExtension}. */
export function createReviewRegistry(): Registry {
	const registry = createRegistry();
	registry.install(lensExtension);
	registry.install(summarizeExtension);
	return registry;
}

/** What {@link ReviewHarness.open} installs beside the lens extension. */
export interface ReviewHarnessOptions {
	readonly retry?: boolean;
	readonly checkout?: string;
	/** The decider triage asks, installed as `decisionExtension`; without it, every lens runs at its default level. */
	readonly decider?: Decider;
}

/**
 * A durable harness that runs reviews over one changeset's storage, with {@link lensExtension} installed. Pass its
 * `harness` to `reviewChangeset`, `runChecks`, and `readVerdict`, and close it when done, which closes the storage.
 */
export class ReviewHarness {
	/** Pi's harness, which the review functions take. */
	readonly harness: Harness;

	private constructor(harness: Harness) {
		this.harness = harness;
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
		const registry = createReviewRegistry();
		const { checkout, decider } = options;
		if (checkout !== undefined) registry.install(checksExtension);
		if (decider !== undefined) registry.install(decisionExtension(decider));
		const env = checkout === undefined ? {} : { env: () => createNodeExecutionEnv(checkout) };
		const harness = await openHarness(
			storage,
			{ models: modelsOf(models), registry, ...env, ...settings },
			context,
		).catch(async (error: unknown) => {
			// Pi closes the storage only once it has built a harness; an open refused before that leaves it to us.
			await storage.close(backgroundContext).catch(() => undefined);
			throw error;
		});
		await abortReplacedRuns(harness, context);
		return new ReviewHarness(harness);
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
	render(only?: readonly string[], options: { readonly tools?: boolean } = {}): string {
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
		for (const file of files) {
			const hunks = file.binary ? ["(binary)"] : file.hunks.map((hunk) => `${hunk.header}\n${hunk.text}`);
			const part = quoteUntrusted("diff", [`${named(file)} (${file.status})`, ...hunks].join("\n"), nonce);
			size += Buffer.byteLength(part);
			if (size > maxPromptBytes) {
				parts.push(
					options.tools === false
						? "[The diff continues; the remaining files are omitted.]"
						: "[The diff continues; read the remaining files with read_file.]",
				);
				break;
			}
			parts.push(part);
		}
		return parts.join("\n\n");
	}
}

// A model tier's route as a review can run it: the tier's model and fallbacks that the collection knows and holds
// credentials for, in routing order, or why there are none.
type TierRoute = { readonly route: ModelReference[] } | { readonly unrouted: string };

async function routeOf(tier: LensTier, config: MelianConfig, review: ReviewModels): Promise<TierRoute> {
	const models = modelsOf(review);
	let route: ReturnType<typeof resolveModelForTier>;
	try {
		route = resolveModelForTier(tier, config.models);
	} catch (error) {
		if (error instanceof ModelRoutingError) return { unrouted: error.message };
		throw error;
	}
	const available: ModelReference[] = [];
	for (const candidate of [route.model, ...route.fallbacks]) {
		if (models.getModel(candidate.provider, candidate.modelId) === undefined) continue;
		if ((await models.checkAuth(candidate.provider)) !== undefined) available.push(candidate);
	}
	if (available.length > 0) return { route: available };
	const tried = [route.model, ...route.fallbacks].map(modelName).join(", ");
	return { unrouted: `none of ${tried} is known with credentials` };
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

// Each lens that finished, by name, to the scope of each variant that ran and the model it finished on, so its lineage
// names the model that ran.
function ranOn(
	lenses: readonly LensRun[],
	result: LensResult | undefined,
): Map<string, { scope: string; level: ScrutinyLevel; model: string }[]> {
	const ran = new Map<string, { scope: string; level: ScrutinyLevel; model: string }[]>();
	for (const lens of lenses) {
		const outcome = result?.[lens.key];
		if (outcome?.status !== "done" || outcome.model === undefined) continue;
		ran.set(lens.name, [
			...(ran.get(lens.name) ?? []),
			{ scope: lens.coverage.scope, level: lens.level, model: outcome.model },
		]);
	}
	return ran;
}

/** What {@link reviewChangeset} reviews, and with what. */
export interface ReviewOptions {
	/** A harness with {@link lensExtension} installed, over the changeset's own storage. */
	readonly harness: Harness;
	readonly changeset: Changeset;
	readonly config: MelianConfig;
	/** The lenses that may run; configuration and the changed paths select among them. */
	readonly lenses: readonly Lens[];
	readonly standards: readonly StandardsSection[];
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
	 * What the review's other checks did, such as static analysis and guardrails, one record per check. A check of the
	 * manifest with no record makes the verdict not reviewed. The lens step records every `lens.*` check itself, so a
	 * record here under such a name is ignored.
	 */
	readonly checks?: readonly CheckRecord[];
	/**
	 * Run again a lens task of this head and selection that left a lens failed, and ask triage again after a decision
	 * that failed, rather than attach to either. Without it a repeat review attaches to the finished tasks and reports
	 * the same outcome, so it spends no tokens unasked.
	 */
	readonly rerun?: boolean;
	/**
	 * Where the revision came from, recorded with the verdict. Only a `pull-request` review whose policy came from a
	 * revision can be published. A range by default.
	 */
	readonly origin?: ReviewOrigin;
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
	if (next !== undefined) return `escalates to ${next.key} (${next.route.map(modelName).join(", ")})`;
	return `capped ${escalation.cap ?? "at its ceiling"}`;
}

function selectionOf(lenses: readonly LensRun[], escalateAt: Severity | undefined): string[] {
	return lenses
		.map((lens) =>
			[
				lens.key,
				...(lens.band === undefined ? [] : [`band ${lens.band}`]),
				...(escalateAt === undefined ? [] : [`escalateAt ${escalateAt}`]),
				...(lens.escalation === undefined ? [] : [escalatesTo(lens.escalation)]),
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
	refused: (key: string, model: string) => boolean = () => false,
): Promise<{ readonly result: LensResult | undefined; readonly ran: StoredLensTaskInput }> {
	const root = await harness.root(context);
	const revision = revisionKey(input.revision);
	const selection = selectionOf(input.lenses, input.escalateAt);
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
	const settled = await harness.waitForTask(taskId, context);
	const { outcome } = settled.state;
	return {
		result: outcome.status === "completed" ? outcome.result : undefined,
		ran: settled.input as unknown as StoredLensTaskInput,
	};
}

// Whether a finished lens task left a lens without an answer, which `rerun` asks to try again.
// A lens that finished on a model the plan refuses, such as a fallback outside a guarded accept, counts as failed, as
// its record does once `plan.mark` judges it, so `rerun` runs it again rather than reuse the refused result.
async function anyLensFailed(
	tx: Tx,
	id: number | undefined,
	refused: (key: string, model: string) => boolean,
): Promise<boolean> {
	const record = id === undefined ? undefined : await tx.task(id as TaskId);
	if (record?.state.status !== "terminal") return false;
	const { outcome } = record.state;
	if (outcome.status !== "completed") return true;
	return Object.entries(outcome.result as LensResult).some(
		([key, lens]) => lens.status !== "done" || (lens.model !== undefined && refused(key, lens.model)),
	);
}

// One adjudication task per head and input. A repeat call with the same input, such as a rerun after a crash, attaches
// to the task the first call created. A call with other input, such as a static check that has since run, creates a
// task and records it as the head's, and a task an earlier call created then records no verdict.
async function startAdjudication(
	harness: Harness,
	input: AdjudicationTaskInput,
	selection: readonly string[],
	verificationRefused: boolean,
	context: Context,
): Promise<TaskId<AdjudicationResult> | undefined> {
	const root = await harness.root(context);
	return root.commit(async (tx) => {
		const index = await tx.doc(ReviewIndex, root.id);
		const revision = revisionKey(input);
		let known = index.reviews[revision];
		// A review whose lenses ran owns the entry only while it still names their selection. Problem: once a later review
		// replaced this one's lens task, rewriting the entry here dropped the newer run's task, and the guards then read
		// that live run as superseded. Solution: a replaced review adjudicates nothing.
		if (selection.length > 0 && known?.lenses.join("\n") !== selection.join("\n")) return undefined;
		const deciding = { ...input };
		if (verificationRefused) {
			await clearVerifications(tx, input.root, revision);
			deciding.findingsVersion = (await tx.doc(FindingsDocument, input.root)).versions[revision] ?? 0;
			if (known?.verification !== undefined) known = omit(omit(known, "verification"), "adjudication");
		}
		const key = JSON.stringify({ ...deciding, details: undefined });
		// A failed adjudication is always rerun: it is cheap, and its failure, such as a base commit a shallow clone had
		// not fetched yet, may have passed.
		const retry = [...undecided, "failed"];
		if (known?.adjudication?.input === key && (await attachable(tx, known.adjudication.task, retry))) {
			return known.adjudication.task as TaskId<AdjudicationResult>;
		}
		const created = await tx.createTask(AdjudicationTask, deciding, { ownership: { kind: "conversation" } });
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
function lensCheck(lens: LensRun, outcome: LensOutcome | undefined, completed: boolean, notes: string[]): CheckRecord {
	const name = `lens.${lens.name}`;
	const { level } = lens;
	const noted = notes.length === 0 ? {} : { reason: notes.join("; ") };
	const failed = (why: string) => [why, ...notes].join("; ");
	if (!completed) return { name, status: "failed", level, reason: failed("the lens task did not complete") };
	if (outcome?.status === "done") {
		const { budgetEnded } = outcome;
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
	rerun: boolean,
	context: Context,
): Promise<{ readonly decision?: Decision; readonly failure?: string }> {
	const root = await harness.root(context);
	const set = request.questionSet.name;
	// What was asked, without the state: the state carries this review's boundary nonce, which differs on every call.
	const key = JSON.stringify({
		decider: decider.name,
		questionSet: request.questionSet,
		questions: request.questions,
	});
	const input: DecisionTaskInput = {
		root: root.id,
		revision,
		key,
		request: structuredClone(request) as DecisionTaskInput["request"],
	};
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
				[revision]: { ...document.decisions[revision], [set]: { key, task } },
			};
		}
		if (!attach || (known.decision === undefined && known.failure === undefined)) {
			// Waiting starts every pending task, before triage can choose the selection that replaces this live run.
			if (record !== undefined && record.state.status !== "terminal") index.reviews[revision] = { lenses: [] };
			else if (previous !== undefined)
				index.reviews[revision] = omit(omit(previous, "adjudication"), "verification");
			const verdicts = await tx.doc(VerdictDocument, root.id);
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
 * `lenses.<name>.level`, `quick` to `deep` by default, and only a floor of `skip` lets triage skip a lens. A lens at
 * `quick` that reports a finding at or above `triage.escalateAt`, or that a budget ended before it reported anything,
 * runs again at its next level the band allows, in a conversation of its own, and that run's record and findings stand
 * for the lens. Each lens starts on its tier's first configured model that has credentials, moves to the next when a
 * provider failure outlasts pi-ai's retries or authentication fails, and becomes a check named `lens.<name>` beside
 * `options.checks`.
 *
 * Throws {@link ReviewError}: `noAvailableModel` when a lens has no level in its band whose tier routes to a model with
 * credentials, naming each level and why, `notInstalled` when the harness lacks {@link lensExtension}, or the decision extension for
 * a decider, `adjudicationFailed` when no verdict was recorded, `superseded` when a later review replaced this one's lens run,
 * `allModelsFailed` when every model of a lens's route
 * failed, naming them, and `lensFailed` when a lens did not finish for another reason. The last two carry the findings
 * reported so far and the `not-reviewed` verdict already recorded.
 */
export async function reviewChangeset(request: ReviewOptions): Promise<Review> {
	const options = planned(request);
	const { harness, changeset, config, standards, models } = options;
	const context = options.context ?? backgroundContext;
	await abortReplacedRuns(harness, context);
	const root = (await harness.root(context)).id;
	// A file's old path too, so a move out of a lens's paths still runs the lens on what left them.
	const paths = changeset.revision.paths();
	const manifest = checksOfTier(config, options.tier ?? config.stages["pull-request"] ?? "full");
	const named = new Set(manifest.filter((name) => name.startsWith("lens.")).map((name) => name.slice("lens.".length)));
	const selected = Lens.select(
		options.lenses.filter((lens) => named.has(lens.name)),
		config,
		paths,
	);
	const nonce = reviewNonce();
	const prompt = new ChangePrompt(changeset, nonce);
	const { repoRoot, revision } = changeset;
	const { base, head } = revision;
	const reviewed = revisionKey(revision);
	// A lens selected through a file's old path covers its head path for this review, so it can report what it moved.
	const covering = selected.map((selection) => {
		const { files } = selection;
		const moved = changeset.revision.files
			.filter((file) => file.oldPath !== undefined && files.includes(file.oldPath) && !files.includes(file.path))
			.map((file) => file.path);
		return { ...selection, moved, covers: [...files, ...moved] };
	});
	const bands = await bandsOf(covering, options);
	const tiers = new Set(covering.flatMap(({ lens }) => lens.declaredLevels().map((level) => lens.level(level).tier)));
	const routes = new Map(
		await Promise.all([...tiers].map(async (tier) => [tier, await routeOf(tier, config, models)] as const)),
	);
	// A tier the plan refuses has no route, yet triage may still choose it: the lens then records the plan's refusal, as
	// it would at that level, rather than quietly run at another.
	const { plan } = request;
	const routed = (tier: LensTier) => "route" in routes.get(tier)! || plan?.refusal(tier) !== undefined;
	// A lens runs only at a level its band holds whose tier reaches a model; with none, the review fails before any lens
	// runs, rather than run it below its floor.
	const unrouted = (tier: LensTier) => {
		const route = routes.get(tier);
		return route !== undefined && "unrouted" in route ? route.unrouted : undefined;
	};
	// Levels the band holds that triage could not offer, by lens, noted on its record so coverage never shrinks unseen.
	const unrunnable = new Map<Lens, string[]>();
	const runnable = new Map(
		covering.map(({ lens }) => {
			const band = bands.get(lens)!;
			const levels = lens.runnableLevels(band, routed);
			if (levels.length === 0) throw noLevel(lens.name, band, lens.unrunnable(band, unrouted));
			// The level the lens runs at without a decision must run, as it had to before triage, so a missing model
			// fails the review rather than quietly moving the lens to a lighter level.
			const fallback = band.bound(defaultScrutinyLevel, band.holds(lens.declaredLevels()));
			if (fallback !== "skip" && !levels.includes(fallback)) {
				const { tier } = lens.level(fallback);
				throw noLevel(lens.name, band, `its default level, ${fallback}, runs on ${tier}, and ${unrouted(tier)}`);
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
					return `triage could not choose ${level}, since ${level} runs on ${tier}, and ${unrouted(tier)}`;
				}),
			);
			return [lens, levels] as const;
		}),
	);
	const triaged =
		options.decider === undefined || covering.length === 0
			? {}
			: await triage(
					harness,
					reviewed,
					options.decider,
					{
						questionSet: triageQuestionSet,
						state: [triageBoundary(nonce), "## The change", prompt.render(undefined, { tools: false })].join(
							"\n\n",
						),
						questions: sharedQuestions(
							covering.map(({ lens }) => lens.triageQuestion(bands.get(lens)!, runnable.get(lens)!)),
						),
					},
					options.rerun === true,
					context,
				);
	const choices = new Map(
		covering.map(({ lens }) => [lens, lens.triage(bands.get(lens)!, runnable.get(lens)!, triaged.decision)]),
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
		if (refusals.has(lens.name)) continue;
		const name = `lens.${lens.name}`;
		refusals.set(lens.name, { name, status: "failed", level, reason, ...(lineage === undefined ? {} : { lineage }) });
	}
	// A lens triage skipped or the plan refused is not running, so no lens hands it a defect.
	const running = covering.filter(({ lens }) => choices.get(lens) !== "skip" && !refused.has(lens));
	const skipped = covering.filter(({ lens }) => choices.get(lens) === "skip").map(({ lens }) => lens.name);
	const lenses: LensRun[] = [];
	const notes = new Map<string, string[]>();
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
		const noted: string[] = [...(unrunnable.get(lens) ?? [])];
		if (triaged.failure !== undefined)
			noted.push(`triage failed, so it ran at its default level: ${triaged.failure}`);
		if (options.decider === undefined && options.triageSkipped !== undefined)
			noted.push(`triage did not run, so it ran at its default level: ${options.triageSkipped}`);
		const oversized = lens.oversizedHandoffs(neighbours);
		if (oversized.length > 0) {
			const listed = oversized.map((name) => `\`${name}\``).join(", ");
			const limit = `${lensLimits.handoffFiles} files or ${lensLimits.handoffBytes / 1024} KiB`;
			noted.push(`kept the defects it hands to ${listed}, whose files here would list past ${limit}`);
		}
		notes.set(`${lens.name}@${lens.version}`, noted);
		// Every lens may report an injection attempt, so the policy section never names a rule the hook refuses.
		const rules = lens.rules.some((rule) => rule.id === injectionAttemptRule.id)
			? lens.rules
			: [...lens.rules, injectionAttemptRule];
		const ruled = Lens.from({ ...lens.toJSON(), rules });
		const runAt = async (level: ScrutinyLevel): Promise<LensRun> => {
			const settings = lens.level(level);
			const band = bands.get(lens)!;
			return {
				key: `${lens.name}@${lens.version}@${level}`,
				band: `${band.floor}-${band.ceiling}`,
				name: lens.name,
				version: lens.version,
				level,
				route: [...(routes.get(settings.tier) as { route: ModelReference[] }).route],
				verify: settings.verify,
				instructions: ruled.renderInstructions(standards, level, neighbours, (listing) =>
					quoteUntrusted("listing", listing, nonce),
				),
				tools: lens.tools,
				severities: lens.severities,
				rules,
				budget: settings.budget,
				coverage,
				prompt: prompt.render(files),
			};
		};
		const level = choices.get(lens) as ScrutinyLevel;
		const first = await runAt(level);
		if (level !== "quick") {
			lenses.push(first);
			continue;
		}
		const next = lens.escalation(level, bands.get(lens)!);
		const nextTier = next === undefined ? undefined : lens.level(next).tier;
		// The plan judges the escalation's next level as it judged the first: a level it refuses caps the escalation.
		const nextRefusal = next === undefined ? undefined : plan?.judge(lens.name, next, undefined, lens.scope).refusal;
		const escalation =
			next === undefined
				? {}
				: nextRefusal !== undefined
					? { cap: `since the plan refuses ${next}: ${nextRefusal}` }
					: nextTier !== undefined && !("route" in routes.get(nextTier)!)
						? { cap: `since ${next} runs on ${nextTier}, which reaches no model with credentials` }
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
	const lensInput = new LensTaskInput(root, state, lenses, escalateAt).toJSON();
	const { result: lensResult, ran } =
		lenses.length === 0
			? { result: {}, ran: lensInput }
			: await runLenses(harness, lensInput, options.rerun === true, context, (key, model) => {
					const run = runsOf(lenses).find((each) => each.key === key);
					const judged =
						run === undefined ? undefined : request.plan?.judge(run.name, run.level, model, run.coverage.scope);
					return judged?.refusal !== undefined;
				});
	// Escalation is settled from the runs the task stored, which decided it, never from this call's own computation.
	const rule = new EscalationRule(ran.escalateAt ?? escalateAt);
	const stored = new Map(ran.lenses.map((run) => [run.key, run]));
	const settling = lenses.map((lens) => settle(stored.get(lens.key) ?? lens, lensResult, rule));
	// The change triage reads can steer it, so a review in which every lens stayed at quick says so.
	const light =
		triaged.decision !== undefined && settling.length > 0 && settling.every(({ run }) => run.level === "quick")
			? ["triage chose quick for every lens, so the whole review looked lightly, at a change that can steer triage"]
			: [];
	const settled = settling.map((settledLens) => {
		const { run } = settledLens;
		const noted = notes.get(`${run.name}@${run.version}`) ?? [];
		return { ...settledLens, notes: [...noted, ...settledLens.notes, ...light] };
	});
	const records = [
		...settled.map(({ run, outcome, notes: noted }) => lensCheck(run, outcome, lensResult !== undefined, noted)),
		...skipped.map(
			(name): CheckRecord => ({
				name: `lens.${name}`,
				status: "skipped",
				reason: "triage skipped it, as its floor allows",
			}),
		),
		...refusals.values(),
	];
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
	const storedFindings = await readFindings(harness, root, reviewed, context, { producers });
	const configFor =
		options.policy === undefined
			? () => config
			: await configsFor(repoRoot, options.policy, storedFindings).catch((error: unknown) => {
					throw new ReviewError("adjudicationFailed", error instanceof Error ? error.message : String(error), {
						lenses: [],
						findings: storedFindings,
					});
				});
	const allRuns = runsOf(ran.lenses);
	const candidates: VerificationCandidate[] = [];
	for (const defect of new Merge(storedFindings, configFor).defects()) {
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
		const finder =
			outcome?.status === "done" && outcome.model !== undefined ? outcome.model : modelName(run.route[0]!);
		let route = request.plan?.verifierRoute(finder).map(({ model }) => parseModelReference(model, "verifier"));
		if (route === undefined) {
			const configured = config.models.verifier;
			if (configured !== undefined) {
				const resolved = resolveModelForTier("verifier", config.models);
				route = [resolved.model, ...resolved.fallbacks];
			} else route = [...run.route];
		}
		const available: ModelReference[] = [];
		const collection = modelsOf(models);
		for (const model of route)
			if (
				collection.getModel(model.provider, model.modelId) !== undefined &&
				(await collection.checkAuth(model.provider).catch(() => undefined)) !== undefined
			)
				available.push(model);
		candidates.push({
			key: defect.speaker.id,
			state: candidateState,
			finder,
			route: available,
			budget: { ...verificationBudget },
		});
	}
	let verificationCheck: CheckRecord | undefined;
	let verificationRefused = false;
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
			const verificationInput: VerificationInput = {
				root,
				revision: ran.revision,
				version: verifierVersion,
				candidates,
			};
			const verifying = await startVerification(
				harness,
				verificationInput,
				selectionOf(lenses, escalateAt),
				options.rerun === true,
				context,
			);
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
				const model = Object.values(results).find((result) => result.status === "done");
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
	});
	// Recorded with the verdict by the adjudication task, so a run that a later review replaced leaves none behind.
	input.details = {
		policy: input.provenance.policy,
		manifest: [...input.manifest],
		lenses: settled
			.map(({ run }) => run)
			.map(({ key, name, version, level, route, budget }) => ({
				name,
				version,
				level,
				models: route.map(modelName),
				...(lensRan(key)?.model === undefined ? {} : { ran: lensRan(key)?.model }),
				...(lineageOf(name, level) === undefined ? {} : { lineage: describeLineage(lineageOf(name, level)!) }),
				...(lensRan(key)?.usage === undefined ? {} : { usage: structuredClone(lensRan(key)?.usage) }),
				budget: {
					findings: budget.findings,
					...(budget.tokens === undefined ? {} : { tokens: budget.tokens }),
					...(budget.tools === undefined ? {} : { tools: budget.tools }),
				},
			})),
		standards: standards.map((section) => section.path),
	};
	const adjudication = await startAdjudication(
		harness,
		input,
		selectionOf(lenses, escalateAt),
		verificationRefused,
		context,
	);
	if (adjudication === undefined) {
		throw new ReviewError(
			"superseded",
			`a later review of ${reviewed} replaced this one's lens run, so this review records no verdict`,
			{ lenses: lenses.map((lens) => lens.name) },
		);
	}
	if (verificationRefused) await abortReplacedRuns(harness, context);
	const forget = (index: ReviewIndexState) => {
		const entry = index.reviews[reviewed];
		if (entry?.adjudication?.task !== adjudication) return;
		index.reviews = { ...index.reviews, [reviewed]: omit(entry, "adjudication") };
	};
	await refuseIfBlocked(harness, adjudication, [], inIndex(forget), context);
	const adjudicated = (await harness.waitForTask(adjudication, context)).state.outcome;
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
