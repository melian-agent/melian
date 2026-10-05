import {
	type Changeset,
	type CheckRecord,
	checksOfTier,
	defaultScrutinyLevel,
	type Finding,
	type FindingSource,
	Lens,
	type LensBudget,
	type LensCoverage,
	type LensNeighbour,
	type LensRule,
	type LensTier,
	type LensToolName,
	lensLimits,
	Manifest,
	type MelianConfig,
	type ModelReference,
	type RepositorySource,
	type ReviewPlan,
	resolveModelForTier,
	type ScrutinyLevel,
	type Severity,
	type StandardsSection,
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
import { ReviewError } from "./errors.ts";
import { clearSightings, findingsVersion, readFindings, recordRevision, revisionKey } from "./findings.ts";
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
} from "./harness.ts";
import {
	budgetEnded,
	injectionPolicySection,
	LensDocument,
	lensPolicyHook,
	lensReadTools,
	type ReviewState,
	reportFinding,
	reviewFiles,
	type StoredBudgetEnd,
} from "./lens-tools.ts";
import { modelsOf, type ReviewModels } from "./models.ts";
import { attachable, ReviewIndex, type ReviewIndexState, undecided } from "./review-index.ts";
import { injectionAttemptRule, quoteUntrusted, reviewNonce } from "./untrusted.ts";

// One lens as the lens task runs it, at one level: everything resolved, nothing left to look up.
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
}

interface LensTaskInput {
	readonly root: ConversationId;
	readonly revision: ReviewState;
	readonly lenses: readonly LensRun[];
}

type LensOutcome =
	// `model` is the model the lens finished on, after any failover; absent from an outcome an older Melian stored.
	| { readonly status: "done"; readonly model?: string; readonly budgetEnded?: StoredBudgetEnd }
	| { readonly status: "unanswered"; readonly reason: string }
	| { readonly status: "exhausted"; readonly tried: string[]; readonly reason: string };

// `attempts` is each lens's position in its route, committed with the model change, so a resumed review continues on
// the model it had reached rather than retrying one that already failed.
type ReviewCheckpoint = {
	phase: "review";
	children: Record<string, ConversationId>;
	attempts: Record<string, number>;
};

type LensCheckpoint = { phase: "spawn" } | ReviewCheckpoint;

type LensResult = Record<string, LensOutcome>;

function modelName(model: ModelReference): string {
	return `${model.provider}/${model.modelId}`;
}

const continuePrompt =
	"The model reviewing this change failed, and you take over. Continue the review where it stopped: findings already recorded stay recorded, so report only what is still missing. Then answer with one line saying how many findings you reported.";

// Whether the review index names another lens task for the task's revision: a later review replaced this run.
async function superseded(
	reader: DocumentReader,
	input: LensTaskInput,
	taskId: number,
	context: Context,
): Promise<boolean> {
	const named = (await reader.snapshot(ReviewIndex, input.root, context))?.reviews[revisionKey(input.revision)]?.task;
	return named !== undefined && named !== taskId;
}

// Spawns every lens conversation in one commit, so a crash leaves all of them or none; then runs them in parallel.
// The orchestrating conversation's model is never asked which lenses to run.
const LensTask = defineTask<LensTaskInput, LensCheckpoint, LensResult>({
	name: "melian.lenses",
	version: 1,
	initial: () => ({ phase: "spawn" }),
	phases: {
		spawn: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const children: Record<string, ConversationId> = {};
				for (const lens of task.input.lenses) {
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
					// An owned conversation starts with its owner's tools and extensions, so both are explicit. Selecting only
					// the lens extension puts its injection policy section first, ahead of the instructions.
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
						review: task.input.root,
						revision: task.input.revision,
						tools: [...lens.tools],
						severities: [...lens.severities],
						rules: lens.rules.map((rule) => ({ ...rule })),
						budget: budget.findings,
						task: runtime.taskId,
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
					children[lens.key] = created.id;
				}
				const attempts = Object.fromEntries(Object.keys(children).map((key) => [key, 0]));
				return { status: "running", checkpoint: { phase: "review", children, attempts } };
			}, context);
		},
		review: async (task, runtime, context) => {
			const { children, attempts } = task.state.checkpoint as ReviewCheckpoint;
			const outcomes = await Promise.all(
				Object.entries(children).map(async ([key, id]): Promise<[string, LensOutcome]> => {
					const child = (await runtime.conversation(id, context))!;
					const lens = task.input.lenses.find((each) => each.key === key)!;
					// A request ID per attempt: a rerun after a crash finds the attempt it had reached, settled or not.
					for (let attempt = attempts[key] ?? 0; ; attempt++) {
						// A task a later review replaced asks no model again, even when a resume restarts it.
						if (await superseded(runtime, task.input, runtime.taskId, context)) {
							return [
								key,
								{ status: "unanswered", reason: "a later review of this revision replaced this run" },
							];
						}
						const content = attempt === 0 ? lens.prompt : continuePrompt;
						const request = { type: "input", content, requestId: `lens:${key}:${attempt}` } as const;
						const settled = await (await child.submit(request, context)).wait(context);
						if (settled.status === "done") {
							const ended = await budgetEnded(runtime, id, context);
							const model = modelName(lens.route[attempt]!);
							return [key, { status: "done", model, ...(ended === undefined ? {} : { budgetEnded: ended }) }];
						}
						const reason = typeof settled.detail === "string" ? settled.detail : (settled.reason ?? "unanswered");
						const failover =
							settled.reason === "no_model" || (settled.reason === "model_error" && isFailoverError(reason));
						if (!failover) return [key, { status: "unanswered", reason }];
						const next = lens.route[attempt + 1];
						if (next === undefined) {
							const tried = lens.route.slice(0, attempt + 1).map(modelName);
							return [key, { status: "exhausted", tried, reason }];
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
				}),
			);
			const result = Object.fromEntries(outcomes);
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
	 * `runChecks` needs for the static tools. A failed open closes `storage`.
	 */
	static async open(
		storage: Storage,
		models: ReviewModels,
		options: { readonly retry?: boolean; readonly checkout?: string } = {},
		context: Context = backgroundContext,
	): Promise<ReviewHarness> {
		const settings = options.retry === false ? { settings: { retry: { enabled: false } } } : {};
		const registry = createReviewRegistry();
		const { checkout } = options;
		if (checkout !== undefined) registry.install(checksExtension);
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
	options: { readonly retry?: boolean; readonly checkout?: string } = {},
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

// The options as the plan shapes them: each tier routed as the plan resolved it, and each lens on a tier the plan refuses
// left out, with a `failed` record of why in place of the host's records of lenses, which the lens step owns.
function planned(options: ReviewOptions): ReviewOptions {
	const checks = (options.checks ?? []).filter((check) => !check.name.startsWith("lens."));
	const { plan } = options;
	if (plan === undefined) return { ...options, checks };
	const config = { ...options.config, models: plan.routes() };
	const manifest = checksOfTier(config, options.tier ?? config.stages["pull-request"] ?? "full");
	const named = new Set(manifest.filter((name) => name.startsWith("lens.")).map((name) => name.slice("lens.".length)));
	const level = defaultScrutinyLevel;
	const refused = new Map<string, CheckRecord>();
	for (const { lens } of Lens.select(
		options.lenses.filter((lens) => named.has(lens.name)),
		config,
		options.changeset.revision.paths(),
	)) {
		const { refusal: reason, lineage } = plan.judge(lens.name, level);
		if (reason === undefined || refused.has(lens.name)) continue;
		const name = `lens.${lens.name}`;
		refused.set(lens.name, { name, status: "failed", level, reason, ...(lineage === undefined ? {} : { lineage }) });
	}
	return {
		...options,
		config,
		lenses: options.lenses.filter((lens) => !refused.has(lens.name)),
		checks: [...checks, ...refused.values()],
	};
}

// Each lens that finished, by name, to the model it finished on, so its lineage names the model that ran.
function ranOn(lenses: readonly LensRun[], result: LensResult | undefined): Map<string, string> {
	return new Map(
		lenses.flatMap((lens) => {
			const outcome = result?.[lens.key];
			return outcome?.status === "done" && outcome.model !== undefined ? [[lens.name, outcome.model] as const] : [];
		}),
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
	 * Run again a lens task of this head and selection that left a lens failed, rather than attach to it. Without it a
	 * repeat review attaches to the finished task and reports the same failure, so it spends no tokens unasked.
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
// task out of the review index, so the next call starts a task rather than attach to this one.
async function refuseIfBlocked(
	harness: Harness,
	taskId: TaskId,
	lenses: readonly string[],
	forget: (index: ReviewIndexState) => void,
	context: Context,
): Promise<void> {
	harness.resume();
	const blocked = (await harness.inspect(context)).tasks.find(
		(each) => each.record.id === taskId && each.state.kind === "blocked",
	);
	if (blocked === undefined) return;
	await harness.abortTask(taskId, context);
	const root = await harness.root(context);
	await root.commit(async (tx) => forget(await tx.doc(ReviewIndex, root.id)), context);
	throw new ReviewError(
		"notInstalled",
		"the harness has no melian.lenses extension; pass the harness of openReviewHarness",
		{
			lenses,
		},
	);
}

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
	const { [key]: _, ...rest } = value;
	return rest;
}

// The lenses a review runs, each by `name@version` and the route it resolved. Problem: a selection of names alone let a
// review under another plan, such as one with --model or a changed preference file, attach to a lens task that ran on
// the old route, and the verdict then claimed a lineage the lenses never ran under. Solution: the route is part of
// the selection, so another route runs the lenses again.
function selectionOf(lenses: readonly LensRun[]): string[] {
	return lenses.map((lens) => `${lens.key} on ${lens.route.map(modelName).join(", ")}`).sort();
}

// One lens task per head and selection. A repeat call, such as a rerun after a crash, attaches to the task the first
// call created, which the harness resumes, rather than running every lens a second time. `undefined` when the task did
// not complete.
async function runLenses(
	harness: Harness,
	input: LensTaskInput,
	rerun: boolean,
	context: Context,
	refused: (key: string, model: string) => boolean = () => false,
): Promise<LensResult | undefined> {
	const root = await harness.root(context);
	const revision = revisionKey(input.revision);
	const selection = selectionOf(input.lenses);
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
		// The replacement run reports afresh, so the replaced run's sightings leave the revision in the same commit.
		if (known?.task !== undefined) {
			const sources = input.lenses.map((lens) => ({ check: `lens.${lens.name}`, version: lens.version }));
			await clearSightings(tx, root.id, revision, sources);
		}
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
		forget,
		context,
	);
	const { outcome } = (await harness.waitForTask(taskId, context)).state;
	return outcome.status === "completed" ? outcome.result : undefined;
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
	lenses: readonly LensRun[],
	context: Context,
): Promise<TaskId<AdjudicationResult>> {
	const root = await harness.root(context);
	const key = JSON.stringify(input);
	const selection = selectionOf(lenses);
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

// `note` says which hand-offs the lens's instructions left out for size, on a record of a lens that ran.
function lensCheck(lens: LensRun, result: LensResult | undefined, note: string | undefined): CheckRecord {
	const name = `lens.${lens.name}`;
	const { level } = lens;
	if (result === undefined) return { name, status: "failed", level, reason: "the lens task did not complete" };
	const outcome = result[lens.key];
	if (outcome?.status === "done") {
		const { budgetEnded } = outcome;
		const noted = note === undefined ? {} : { reason: note };
		if (budgetEnded === undefined) return { name, status: "ran", level, ...noted };
		// A budget's end is reduced coverage, so it leaves the review not reviewed unless the level counts it. An `ended`
		// record's reason is why it did not run, so the note goes only on one counted as run.
		if (lens.budget.ended === "count") return { name, status: "ran", level, budgetEnded, ...noted };
		return { name, status: "ended", level, budgetEnded };
	}
	if (outcome?.status === "exhausted") {
		const error = `tried ${outcome.tried.join(", ")}; the last said: ${outcome.reason}`;
		return { name, status: "failed", level, reason: "every model of its tier failed", error };
	}
	return { name, status: "failed", level, reason: "the lens did not finish", error: outcome?.reason ?? "no outcome" };
}

// Records for the lenses and decision questions the tier names; the lens step owns `lens.*`, so a record of that name
// from elsewhere, such as a check runner that skips lenses, gives way. Every other check's record comes from
// `supplied`; adjudication calls one with none a check that never started. The producers are the sources whose findings
// the review counts.
function account(
	checks: readonly string[],
	ran: readonly LensRun[],
	result: LensResult | undefined,
	notes: ReadonlyMap<string, string>,
	options: Pick<ReviewOptions, "config" | "lenses" | "checks">,
): { readonly manifest: Manifest; readonly producers: FindingSource[] } {
	const { config } = options;
	// The lens step owns `lens.*`, so the host's records of lenses never reach here; a plan's record of a lens it refused
	// does, for a lens that never ran.
	const supplied = (options.checks ?? []).filter((check) => !ran.some((lens) => check.name === `lens.${lens.name}`));
	const manifest = new Manifest(
		checks,
		[...supplied, ...ran.map((lens) => lensCheck(lens, result, notes.get(lens.key)))],
		config.checks.allowSkip,
	);
	const recorded = new Set(manifest.records().map((check) => check.name));
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
		} else if (name.startsWith("decisions.") && config.decisions.provider === undefined) {
			manifest.record({ name, status: "skipped", reason: "no decision provider is configured" });
		}
	}
	// The design lets the fast tier run without decision questions when no provider is configured.
	if (config.decisions.provider === undefined) {
		for (const name of checks.filter((each) => each.startsWith("decisions."))) manifest.allowSkip(name);
	}
	const versions = new Map(supplied.map((check) => [check.name, check.version]));
	const others = [...new Set([...checks, ...supplied.map((check) => check.name)])].filter(
		(name) => !name.startsWith("lens."),
	);
	const producers: FindingSource[] = [
		...ran.map((lens) => ({ check: `lens.${lens.name}`, version: lens.version })),
		...others.map((check) => {
			const version = versions.get(check);
			return version === undefined ? { check } : { check, version };
		}),
	];
	return { manifest, producers };
}

/**
 * Reviews a changeset: selects the lenses its paths and configuration call for, runs each as a conversation owned by
 * one lens task, then adjudicates in a task of its own and records the verdict on the root conversation under the
 * head. Returns the findings the selected lenses sighted at the head and the verdict. Each lens starts on its tier's
 * first configured model that has credentials, moves to the next when a provider failure outlasts pi-ai's retries or
 * authentication fails, and becomes a check named `lens.<name>` beside `options.checks`.
 *
 * Throws core's `ModelRoutingError` for a tier with no model, and {@link ReviewError}: `noAvailableModel` when no model
 * of a tier has credentials, `notInstalled` when the harness lacks {@link lensExtension}, `adjudicationFailed` when no
 * verdict was recorded, `allModelsFailed` when every model of a lens's route failed, naming them, and `lensFailed` when
 * a lens did not finish for another reason. The last two carry the findings reported so far and the `not-reviewed`
 * verdict already recorded.
 */
export async function reviewChangeset(request: ReviewOptions): Promise<Review> {
	const options = planned(request);
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
	// A lens selected through a file's old path covers its head path for this review, so it can report what it moved.
	const covering = selected.map((selection) => {
		const { files } = selection;
		const moved = changeset.revision.files
			.filter((file) => file.oldPath !== undefined && files.includes(file.oldPath) && !files.includes(file.path))
			.map((file) => file.path);
		return { ...selection, moved, covers: [...files, ...moved] };
	});
	const lenses: LensRun[] = [];
	const notes = new Map<string, string>();
	for (const { lens, coverage: configured, files, moved, covers } of covering) {
		const coverage = moved.length === 0 ? configured : { ...configured, moved };
		// A neighbour takes defects off this lens only in the files it reviews too; this lens keeps them in the rest,
		// rather than leave them unreviewed where the neighbour's paths do not reach.
		const neighbours = [...new Set(covering.map((other) => other.lens.name))].flatMap((name): LensNeighbour[] => {
			if (name === lens.name) return [];
			const theirs = new Set(covering.flatMap((other) => (other.lens.name === name ? other.covers : [])));
			// A neighbour over a renamed file's head path covers its old path too, as one over the old path covers the head.
			for (const file of changeset.revision.files)
				if (file.oldPath !== undefined && theirs.has(file.path)) theirs.add(file.oldPath);
			const shared = covers.filter((file) => theirs.has(file));
			if (shared.length === 0) return [];
			return [{ name, files: shared.length === covers.length ? "every" : shared }];
		});
		const oversized = lens.oversizedHandoffs(neighbours);
		if (oversized.length > 0) {
			const named = oversized.map((name) => `\`${name}\``).join(", ");
			const limit = `${lensLimits.handoffFiles} files or ${lensLimits.handoffBytes / 1024} KiB`;
			notes.set(
				`${lens.name}@${lens.version}`,
				`kept the defects it hands to ${named}, whose files here would list past ${limit}`,
			);
		}
		// Every lens may report an injection attempt, so the policy section never names a rule the hook refuses.
		const rules = lens.rules.some((rule) => rule.id === injectionAttemptRule.id)
			? lens.rules
			: [...lens.rules, injectionAttemptRule];
		// Every lens runs at its default level until triage chooses one per review.
		const level = defaultScrutinyLevel;
		const settings = lens.level(level);
		lenses.push({
			key: `${lens.name}@${lens.version}`,
			name: lens.name,
			version: lens.version,
			level,
			route: await chooseRoute(lens.name, settings.tier, config, models),
			instructions: Lens.from({ ...lens.toJSON(), rules }).renderInstructions(
				standards,
				level,
				neighbours,
				(listing) => quoteUntrusted("listing", listing, nonce),
			),
			tools: lens.tools,
			severities: lens.severities,
			rules,
			budget: settings.budget,
			coverage,
			prompt: prompt.render(files),
		});
	}
	const { repoRoot, revision } = changeset;
	const { base, head } = revision;
	const reviewed = revisionKey(revision);
	const state: ReviewState = {
		repoRoot,
		nonce,
		base: revision.base,
		head,
		files: reviewFiles(revision.files),
	};
	const lensResult =
		lenses.length === 0
			? {}
			: await runLenses(
					harness,
					{ root, revision: state, lenses },
					options.rerun === true,
					context,
					(key, model) => {
						const lens = lenses.find((each) => each.key === key);
						return lens !== undefined && request.plan?.judge(lens.name, lens.level, model).refusal !== undefined;
					},
				);
	// Only the lenses this review ran count: one that configuration has since disabled or retiered leaves nothing behind.
	const { manifest: accounted, producers } = account(manifest, lenses, lensResult, notes, options);
	const input = adjudicationInput({
		root,
		repoRoot,
		base,
		head,
		policy: options.policy,
		config,
		manifest,
		checks: request.plan?.mark(accounted.records(), ranOn(lenses, lensResult)) ?? accounted.records(),
		findingsVersion: await findingsVersion(harness, root, reviewed, context),
		allowSkip: accounted.skippable(),
		producers,
		origin: options.origin ?? { kind: "range" },
		lenses: lenses.map((lens) => lens.key),
		plan: request.plan,
	});
	const adjudication = await startAdjudication(harness, input, lenses, context);
	const forget = (index: ReviewIndexState) => {
		const entry = index.reviews[reviewed];
		if (entry?.adjudication?.task !== adjudication) return;
		index.reviews = { ...index.reviews, [reviewed]: omit(entry, "adjudication") };
	};
	await refuseIfBlocked(harness, adjudication, [], forget, context);
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
	const exhausted = lenses.flatMap((lens) => {
		const result = lensResult?.[lens.key];
		return result?.status === "exhausted" ? [{ lens: lens.name, ...result }] : [];
	});
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
	const failed = lenses.filter((lens) => lensResult?.[lens.key]?.status !== "done").map((lens) => lens.name);
	if (failed.length > 0) {
		throw new ReviewError("lensFailed", `lenses did not finish: ${failed.join(", ")}`, {
			lenses: failed,
			findings,
			verdict,
		});
	}
	return { findings, verdict };
}
