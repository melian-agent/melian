import {
	type Changeset,
	type CheckRecord,
	checksOfTier,
	configLookup,
	type Decider,
	type Decision,
	type DecisionRequest,
	EscalationRule,
	type EscalationTrigger,
	type Finding,
	type FindingSource,
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
	type ModelReference,
	type RepositorySource,
	resolveModelForTier,
	type ScrutinyLevel,
	type Severity,
	type StandardsSection,
	triageQuestionSet,
	type Verdict,
	visibleText,
} from "@melian-agent/core";
import {
	type AdjudicationResult,
	AdjudicationTask,
	type AdjudicationTaskInput,
	adjudicationInput,
	type ReviewOrigin,
	readVerdict,
} from "./adjudication.ts";
import { checksExtension } from "./checks.ts";
import {
	DecisionDocument,
	type DecisionResult,
	type DecisionTaskInput,
	decisionExtension,
	decisionTask,
	readRecordedDecision,
} from "./decisions.ts";
import { ReviewError } from "./errors.ts";
import {
	FindingsDocument,
	findingsVersion,
	readFindings,
	recordRevision,
	revisionKey,
	sightingSeverities,
} from "./findings.ts";
import {
	backgroundContext,
	type Context,
	type ConversationId,
	configure,
	createNodeExecutionEnv,
	createRegistry,
	defineExtension,
	defineTask,
	type Harness,
	isFailoverError,
	openHarness,
	type Registry,
	type Storage,
	type TaskId,
	type Tx,
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
	reviewFiles,
	type StoredBudgetEnd,
} from "./lens-tools.ts";
import { modelsOf, type ReviewModels } from "./models.ts";
import { attachable, ReviewIndex, type ReviewIndexState, undecided } from "./review-index.ts";
import { injectionAttemptRule, quoteUntrusted, reviewNonce, triageBoundary } from "./untrusted.ts";

// One lens as the lens task runs it, at one level: everything resolved, nothing left to look up. `key` names the lens
// with its version and level, so a run at one level never stands in for a run at another: it keys the task's children,
// attempts, and results, the review index's selection, and each request's ID. A run at `quick` carries `escalation`,
// whose `next` is the run the escalation rule moves it to, absent when the band's ceiling stops it there.
interface LensRun {
	readonly key: string;
	readonly name: string;
	readonly version: string;
	readonly level: ScrutinyLevel;
	// The level's tier's models that were known with credentials when the review started, in routing order.
	readonly route: readonly ModelReference[];
	readonly instructions: string;
	readonly tools: readonly LensToolName[];
	readonly severities: readonly Severity[];
	readonly rules: readonly LensRule[];
	readonly budget: LensBudget;
	readonly coverage: LensCoverage;
	// The change as this lens sees it: only the files it covers.
	readonly prompt: string;
	readonly escalation?: { readonly next?: LensRun };
}

// `escalateAt` is absent from a task an older Melian created, which escalates nothing.
interface LensTaskInput {
	readonly root: ConversationId;
	readonly revision: ReviewState;
	readonly lenses: readonly LensRun[];
	readonly escalateAt?: Severity;
}

// A run the escalation rule moved on names why, and the key of the run it moved to, absent when its ceiling capped it.
type LensOutcome =
	| {
			readonly status: "done";
			readonly budgetEnded?: StoredBudgetEnd;
			readonly escalation?: { readonly trigger: EscalationTrigger; readonly to?: string };
	  }
	| { readonly status: "unanswered"; readonly reason: string }
	| { readonly status: "exhausted"; readonly tried: string[]; readonly reason: string };

type StoredTrigger = { kind: "severity"; severity: Severity } | { kind: "budget"; budget: "tokens" | "tools" };

// `attempts` is each run's position in its route, committed with the model change, so a resumed review continues on
// the model it had reached rather than retrying one that already failed. `escalations` names, by the key of the run
// that escalated, why it did, committed with the conversation of the run it escalated to, so a resumed review
// continues that run rather than deciding again.
type ReviewCheckpoint = {
	phase: "review";
	children: Record<string, ConversationId>;
	attempts: Record<string, number>;
	escalations?: Record<string, StoredTrigger>;
};

type LensCheckpoint = { phase: "spawn" } | ReviewCheckpoint;

type LensResult = Record<string, LensOutcome>;

function modelName(model: ModelReference): string {
	return `${model.provider}/${model.modelId}`;
}

const continuePrompt =
	"The model reviewing this change failed, and you take over. Continue the review where it stopped: findings already recorded stay recorded, so report only what is still missing. Then answer with one line saying how many findings you reported.";

// Creates one lens's conversation, owned by the lens task, and writes its policy on it.
async function spawnLens(tx: Tx, taskId: TaskId, input: LensTaskInput, lens: LensRun): Promise<ConversationId> {
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
		// A task an older Melian created names no level, and its findings keep naming the lens's version alone.
		...(lens.level === undefined ? {} : { level: lens.level }),
		review: input.root,
		revision: input.revision,
		tools: [...lens.tools],
		severities: [...lens.severities],
		rules: lens.rules.map((rule) => ({ ...rule })),
		budget: budget.findings,
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

// Spawns every lens conversation in one commit, so a crash leaves all of them or none; then runs them in parallel.
// A lens the escalation rule moves to its next level gets a conversation of its own, created in the commit that
// records why, and runs there. The orchestrating conversation's model is never asked which lenses to run.
const LensTask = defineTask<LensTaskInput, LensCheckpoint, LensResult>({
	name: "melian.lenses",
	// Version 2 added escalation: a run's `escalation`, the input's `escalateAt`, the checkpoint's `escalations`, and an
	// outcome's `escalation`. A version 1 task holds none of them, and runs as it did.
	version: 2,
	initial: () => ({ phase: "spawn" }),
	migrate: (input, checkpoint) => ({
		input: input as unknown as LensTaskInput,
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
			const run = async (lens: LensRun, id: ConversationId): Promise<LensOutcome> => {
				const child = (await runtime.conversation(id, context))!;
				for (let attempt = started.attempts[lens.key] ?? 0; ; attempt++) {
					const content = attempt === 0 ? lens.prompt : continuePrompt;
					const request = { type: "input", content, requestId: `lens:${lens.key}:${attempt}` } as const;
					const settled = await (await child.submit(request, context)).wait(context);
					if (settled.status === "done") {
						const ended = await budgetEnded(runtime, id, context);
						return { status: "done", ...(ended === undefined ? {} : { budgetEnded: ended }) };
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
			// Why a finished run escalates, from what it reported at this revision and the budget that ended it, read
			// from durable state, so a rerun after a crash decides alike.
			const triggerOf = async (lens: LensRun, outcome: LensOutcome): Promise<EscalationTrigger | undefined> => {
				if (rule === undefined || lens.escalation === undefined || outcome.status !== "done") return undefined;
				const decided = started.escalations?.[lens.key];
				if (decided !== undefined) return decided;
				const findings = await runtime.snapshot(FindingsDocument, input.root, context);
				const source = lensSource(lens.name, lens.version, lens.level);
				const severities = findings === undefined ? [] : sightingSeverities(findings, revision, source);
				const budget = outcome.budgetEnded?.budget;
				return rule.trigger({
					level: lens.level,
					severities,
					...(budget === undefined ? {} : { budgetEnded: budget }),
				});
			};
			// Each lens's runs in order: its first, then each the escalation rule moves it to.
			const chain = async (first: LensRun): Promise<[string, LensOutcome][]> => {
				const outcomes: [string, LensOutcome][] = [];
				let lens = first;
				let id = started.children[first.key]!;
				for (;;) {
					const outcome = await run(lens, id);
					const trigger = await triggerOf(lens, outcome);
					const next = lens.escalation?.next;
					if (trigger === undefined || outcome.status !== "done") return [...outcomes, [lens.key, outcome]];
					if (next === undefined) return [...outcomes, [lens.key, { ...outcome, escalation: { trigger } }]];
					outcomes.push([lens.key, { ...outcome, escalation: { trigger, to: next.key } }]);
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
									escalations: { ...checkpoint.escalations, [lens.key]: { ...trigger } },
								},
							};
						}, context);
					}
					lens = next;
					id = child!;
				}
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
	tools: [...Object.values(lensReadTools), reportFinding],
	sections: [injectionPolicySection],
	hooks: [lensPolicyHook],
	tasks: [LensTask, AdjudicationTask],
});

/** A registry holding {@link lensExtension}. */
export function createReviewRegistry(): Registry {
	const registry = createRegistry();
	registry.install(lensExtension);
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

	/** The prompt, limited to the files `only` names when given, matching a renamed file by its old path or its new one. */
	render(only?: readonly string[]): string {
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
			"Each file's diff follows in its own block, whose first line names the file. The diff has no context lines. Read the head revision with read_file for the code around each hunk.",
		].join("\n");
		const parts = [header];
		let size = Buffer.byteLength(header);
		for (const file of files) {
			const hunks = file.binary ? ["(binary)"] : file.hunks.map((hunk) => `${hunk.header}\n${hunk.text}`);
			const part = quoteUntrusted("diff", [`${named(file)} (${file.status})`, ...hunks].join("\n"), nonce);
			size += Buffer.byteLength(part);
			if (size > maxPromptBytes) {
				parts.push("[The diff continues; read the remaining files with read_file.]");
				break;
			}
			parts.push(part);
		}
		return parts.join("\n\n");
	}
}

// The tier's model and fallbacks, keeping those the collection knows and holds credentials for, in routing order.
async function chooseRoute(
	lens: string,
	tier: LensTier,
	config: MelianConfig,
	review: ReviewModels,
): Promise<ModelReference[]> {
	const models = modelsOf(review);
	const route = resolveModelForTier(tier, config.models);
	const available: ModelReference[] = [];
	for (const candidate of [route.model, ...route.fallbacks]) {
		if (models.getModel(candidate.provider, candidate.modelId) === undefined) continue;
		if ((await models.checkAuth(candidate.provider)) !== undefined) available.push(candidate);
	}
	if (available.length > 0) return available;
	const tried = [route.model, ...route.fallbacks].map(modelName).join(", ");
	throw new ReviewError(
		"noAvailableModel",
		`lens ${lens} needs a ${tier} model, and none of ${tried} is known with credentials; log in with pi or set the provider's API key`,
		{ lenses: [lens] },
	);
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

// Forgets a task the review index names, by `forget` on the index.
function inIndex(forget: (index: ReviewIndexState) => void) {
	return async (tx: Tx, root: ConversationId) => forget(await tx.doc(ReviewIndex, root));
}

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
	const { [key]: _, ...rest } = value;
	return rest;
}

// One lens task per head and selection. A repeat call, such as a rerun after a crash, attaches to the task the first
// call created, which the harness resumes, rather than running every lens a second time. `undefined` when the task did
// not complete.
async function runLenses(
	harness: Harness,
	input: LensTaskInput,
	rerun: boolean,
	context: Context,
): Promise<LensResult | undefined> {
	const root = await harness.root(context);
	const revision = revisionKey(input.revision);
	const selection = input.lenses.map((lens) => lens.key).sort();
	const taskId = await root.commit(async (tx) => {
		const index = await tx.doc(ReviewIndex, root.id);
		const known = index.reviews[revision];
		const same = known !== undefined && known.lenses.join("\n") === selection.join("\n");
		const attach =
			same && (await attachable(tx, known.task, undecided)) && !(rerun && (await anyLensFailed(tx, known.task)));
		if (attach) return known.task as TaskId<LensResult>;
		await recordRevision(tx, root.id, revision);
		const created = await tx.createTask(LensTask, input, { ownership: { kind: "conversation" } });
		index.reviews[revision] = { task: created, lenses: selection };
		return created;
	}, context);
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
	const { outcome } = (await harness.waitForTask(taskId, context)).state;
	return outcome.status === "completed" ? outcome.result : undefined;
}

// Whether a finished lens task left a lens without an answer, which `rerun` asks to try again.
async function anyLensFailed(tx: Tx, id: number | undefined): Promise<boolean> {
	const record = id === undefined ? undefined : await tx.task(id as TaskId);
	if (record?.state.status !== "terminal") return false;
	const { outcome } = record.state;
	if (outcome.status !== "completed") return true;
	return Object.values(outcome.result as LensResult).some((lens) => lens.status !== "done");
}

// One adjudication task per head and input. A repeat call with the same input, such as a rerun after a crash, attaches
// to the task the first call created. A call with other input, such as a static check that has since run, creates a
// task and records it as the head's, and a task an earlier call created then records no verdict.
async function startAdjudication(
	harness: Harness,
	input: AdjudicationTaskInput,
	lenses: readonly LensRun[],
	context: Context,
): Promise<TaskId<AdjudicationResult>> {
	const root = await harness.root(context);
	const key = JSON.stringify(input);
	const selection = lenses.map((lens) => lens.key).sort();
	return root.commit(async (tx) => {
		const index = await tx.doc(ReviewIndex, root.id);
		const known = index.reviews[revisionKey(input)];
		// A failed adjudication is always rerun: it is cheap, and its failure, such as a base commit a shallow clone had
		// not fetched yet, may have passed.
		const retry = [...undecided, "failed"];
		if (known?.adjudication?.input === key && (await attachable(tx, known.adjudication.task, retry))) {
			return known.adjudication.task as TaskId<AdjudicationResult>;
		}
		const created = await tx.createTask(AdjudicationTask, input, { ownership: { kind: "conversation" } });
		const same = known !== undefined && known.lenses.join("\n") === selection.join("\n");
		const entry = same ? known : { lenses: selection };
		index.reviews[revisionKey(input)] = { ...entry, adjudication: { task: created, input: key } };
		return created;
	}, context);
}

// The run whose record stands for a lens: its first, or the last the escalation rule moved it to, with its outcome,
// and a note for each escalation, saying why it ran again or that its ceiling capped it.
type SettledLens = { readonly run: LensRun; readonly outcome: LensOutcome | undefined; readonly notes: string[] };

function settle(first: LensRun, result: LensResult | undefined, rule: EscalationRule): SettledLens {
	const notes: string[] = [];
	for (let run = first; ; ) {
		const outcome = result?.[run.key];
		const escalation = outcome?.status === "done" ? outcome.escalation : undefined;
		const next = escalation?.to === undefined ? undefined : run.escalation?.next;
		if (escalation !== undefined) notes.push(rule.describe(escalation.trigger, run.level, next?.level));
		if (next === undefined) return { run, outcome, notes };
		run = next;
	}
}

// `notes` say why the lens ran where it did: hand-offs its instructions left out for size, a triage that failed, and
// each escalation. They go only on the record of a lens that ran, since an `ended` or `failed` record's reason is why it
// did not run.
function lensCheck(lens: LensRun, outcome: LensOutcome | undefined, completed: boolean, notes: string[]): CheckRecord {
	const name = `lens.${lens.name}`;
	const { level } = lens;
	if (!completed) return { name, status: "failed", level, reason: "the lens task did not complete" };
	if (outcome?.status === "done") {
		const { budgetEnded } = outcome;
		const noted = notes.length === 0 ? {} : { reason: notes.join("; ") };
		if (budgetEnded === undefined) return { name, status: "ran", level, ...noted };
		// A budget's end is reduced coverage, so it leaves the review not reviewed unless the level counts it.
		if (lens.budget.ended === "count") return { name, status: "ran", level, budgetEnded, ...noted };
		return { name, status: "ended", level, budgetEnded };
	}
	if (outcome?.status === "exhausted") {
		const error = `tried ${outcome.tried.join(", ")}; the last said: ${outcome.reason}`;
		return { name, status: "failed", level, reason: "every model of its tier failed", error };
	}
	return { name, status: "failed", level, reason: "the lens did not finish", error: outcome?.reason ?? "no outcome" };
}

// Records for the lenses and decision questions the tier names; the lens step owns `lens.*` and `decisions.*`, so a
// record of either from elsewhere, such as a check runner that skips them, gives way. Every other check's record comes
// from `supplied`; adjudication calls one with none a check that never started. `lenses` holds the lens step's own
// records, and `skippable` the lenses whose skip it allows. The producers are the sources whose findings the review
// counts: each lens at the level of the run that stands for it.
function account(
	checks: readonly string[],
	settled: readonly SettledLens[],
	lenses: { readonly records: readonly CheckRecord[]; readonly skippable: readonly string[] },
	options: Pick<ReviewOptions, "config" | "lenses" | "checks">,
): { readonly manifest: Manifest; readonly producers: FindingSource[] } {
	const { config } = options;
	const owned = (name: string) => name.startsWith("lens.") || name.startsWith("decisions.");
	const supplied = (options.checks ?? []).filter((check) => !owned(check.name));
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
				manifest.record({ name, status: "skipped", reason: "no decision provider is configured" });
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
	const producers: FindingSource[] = [
		...settled.map(({ run }) => lensSource(run.name, run.version, run.level)),
		...others.map((check) => {
			const version = versions.get(check);
			return version === undefined ? { check } : { check, version };
		}),
	];
	return { manifest, producers };
}

// The band each selected lens's level must lie in: the band of every file it reviews, each from the configuration of
// that file's path, read from the policy source, or `config` for every path without one.
async function bandsOf(
	selections: readonly { readonly lens: Lens; readonly covers: readonly string[] }[],
	options: Pick<ReviewOptions, "config" | "policy" | "changeset">,
): Promise<Map<string, LevelBand>> {
	const { policy, config, changeset } = options;
	const lookup = policy === undefined ? undefined : configLookup(changeset.repoRoot, policy);
	const bands = new Map<string, LevelBand>();
	for (const { lens, covers } of selections) {
		const configs = lookup === undefined ? [config] : await Promise.all(covers.map((path) => lookup(path)));
		const settings = configs.map((each) =>
			Object.hasOwn(each.lenses, lens.name) ? each.lenses[lens.name] : undefined,
		);
		const own = LevelBand.across(settings.map((each) => LevelBand.of(each?.level)));
		bands.set(lens.name, LevelBand.across([...(bands.has(lens.name) ? [bands.get(lens.name)!] : []), own]));
	}
	return bands;
}

// Triage's decision on the revision: one choice question per lens, asked through `decider` in a decision task, which
// stores the whole distribution. A repeat call with the same questions attaches to the task the first call created,
// so a crash or a second review keeps the levels the first chose; `rerun` asks again after a decision that failed.
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
	const taskId = await root.commit(async (tx) => {
		const document = await tx.doc(DecisionDocument, root.id);
		const known = document.decisions[revision]?.[set];
		const retry = rerun && known?.failure !== undefined;
		if (known?.key === key && !retry && (await attachable(tx, known.task, undecided))) {
			return known.task as TaskId<DecisionResult>;
		}
		const created = await tx.createTask(decisionTask(decider), input, { ownership: { kind: "conversation" } });
		document.decisions = {
			...document.decisions,
			[revision]: { ...document.decisions[revision], [set]: { key, task: created } },
		};
		return created;
	}, context);
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
 * Throws core's `ModelRoutingError` for a tier with no model, and {@link ReviewError}: `noAvailableModel` when no model
 * of a tier has credentials, `notInstalled` when the harness lacks {@link lensExtension}, or the decision extension for
 * a decider, `adjudicationFailed` when no verdict was recorded, `allModelsFailed` when every model of a lens's route
 * failed, naming them, and `lensFailed` when a lens did not finish for another reason. The last two carry the findings
 * reported so far and the `not-reviewed` verdict already recorded.
 */
export async function reviewChangeset(options: ReviewOptions): Promise<Review> {
	const { harness, changeset, config, standards, models } = options;
	const context = options.context ?? backgroundContext;
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
	const triaged =
		options.decider === undefined || covering.length === 0
			? {}
			: await triage(
					harness,
					reviewed,
					options.decider,
					{
						questionSet: triageQuestionSet,
						state: [triageBoundary(nonce), "## The change", prompt.render()].join("\n\n"),
						// One question per name: two variants of a lens in different folders share a name, and so its answer.
						questions: [...new Map(covering.map(({ lens }) => [lens.name, lens.triageQuestion()])).values()],
					},
					options.rerun === true,
					context,
				);
	const choices = new Map(covering.map(({ lens }) => [lens, lens.triage(bands.get(lens.name)!, triaged.decision)]));
	// A lens triage skipped is not running, so no lens hands it a defect.
	const running = covering.filter(({ lens }) => choices.get(lens) !== "skip");
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
		const noted: string[] = [];
		if (triaged.failure !== undefined)
			noted.push(`triage failed, so it ran at its default level: ${triaged.failure}`);
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
			return {
				key: `${lens.name}@${lens.version}@${level}`,
				name: lens.name,
				version: lens.version,
				level,
				route: await chooseRoute(lens.name, settings.tier, config, models),
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
		const next = lens.escalation(level, bands.get(lens.name)!);
		lenses.push({ ...first, escalation: next === undefined ? {} : { next: await runAt(next) } });
	}
	const state: ReviewState = {
		repoRoot,
		nonce,
		base: revision.base,
		head,
		files: reviewFiles(revision.files),
	};
	const { escalateAt } = config.triage;
	const lensResult =
		lenses.length === 0
			? {}
			: await runLenses(harness, { root, revision: state, lenses, escalateAt }, options.rerun === true, context);
	const rule = new EscalationRule(escalateAt);
	const settled = lenses.map((lens) => {
		const settledLens = settle(lens, lensResult, rule);
		const noted = notes.get(`${lens.name}@${lens.version}`) ?? [];
		return { ...settledLens, notes: [...noted, ...settledLens.notes] };
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
	];
	// Only the lenses this review ran count, each at the level whose record stands for it: one that configuration has
	// since disabled or retiered, or a quick run that escalated, leaves nothing behind.
	const { manifest: accounted, producers } = account(
		manifest,
		settled,
		{ records, skippable: skipped.map((name) => `lens.${name}`) },
		options,
	);
	const input = adjudicationInput({
		root,
		repoRoot,
		base,
		head,
		policy: options.policy,
		config,
		manifest,
		checks: accounted.records(),
		findingsVersion: await findingsVersion(harness, root, reviewed, context),
		allowSkip: accounted.skippable(),
		producers,
		origin: options.origin ?? { kind: "range" },
		lenses: settled.map(({ run }) => run.key),
	});
	const adjudication = await startAdjudication(harness, input, lenses, context);
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
	return { findings, verdict };
}
