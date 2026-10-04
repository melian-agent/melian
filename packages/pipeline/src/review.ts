import {
	type Changeset,
	type CheckRecord,
	checksOfTier,
	defaultScrutinyLevel,
	type Finding,
	type FindingSource,
	type Lens,
	type LensBudget,
	type LensCoverage,
	type LensRule,
	type LensTier,
	type LensToolName,
	lensLevel,
	type MelianConfig,
	type ModelReference,
	type RepositorySource,
	renderLensInstructions,
	resolveModelForTier,
	type ScrutinyLevel,
	type Severity,
	type StandardsSection,
	selectLenses,
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
import { findingsVersion, readFindings, recordRevision, revisionKey } from "./findings.ts";
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
	| { readonly status: "done"; readonly budgetEnded?: StoredBudgetEnd }
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
						limits: {
							...(budget.tokens === undefined ? {} : { tokens: budget.tokens }),
							...(budget.tools === undefined ? {} : { tools: budget.tools }),
						},
						coverage: {
							scope: lens.coverage.scope,
							paths: [...lens.coverage.paths],
							nearer: [...lens.coverage.nearer],
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
						const content = attempt === 0 ? lens.prompt : continuePrompt;
						const request = { type: "input", content, requestId: `lens:${key}:${attempt}` } as const;
						const settled = await (await child.submit(request, context)).wait(context);
						if (settled.status === "done") {
							const ended = await budgetEnded(runtime, id, context);
							return [key, { status: "done", ...(ended === undefined ? {} : { budgetEnded: ended }) }];
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
 * the head enters inside `quoteUntrusted` boundaries carrying `nonce`: the file list as one listing, and each file's
 * diff as its own block whose first line is the file's path and status, so a changed line cannot pose as another
 * file's header. Paths are escaped with core's `visibleText`, so a newline in one cannot forge a line. `only` limits
 * the prompt to the files a lens covers, matching a renamed file by its old path or its new one.
 */
export function renderChangePrompt(changeset: Changeset, nonce: string, only?: readonly string[]): string {
	const { base, head } = changeset.revision;
	const files = changeset.revision.files.filter(
		(file) =>
			only === undefined || only.includes(file.path) || (file.oldPath !== undefined && only.includes(file.oldPath)),
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
		forget,
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

function lensCheck(lens: LensRun, result: LensResult | undefined): CheckRecord {
	const name = `lens.${lens.name}`;
	const { level } = lens;
	if (result === undefined) return { name, status: "failed", level, reason: "the lens task did not complete" };
	const outcome = result[lens.key];
	if (outcome?.status === "done") {
		const { budgetEnded } = outcome;
		if (budgetEnded === undefined) return { name, status: "ran", level };
		// A budget's end is reduced coverage, so it leaves the review not reviewed unless the level counts it.
		return { name, status: lens.budget.ended === "count" ? "ran" : "ended", level, budgetEnded };
	}
	if (outcome?.status === "exhausted") {
		const error = `tried ${outcome.tried.join(", ")}; the last said: ${outcome.reason}`;
		return { name, status: "failed", level, reason: "every model of its tier failed", error };
	}
	return { name, status: "failed", level, reason: "the lens did not finish", error: outcome?.reason ?? "no outcome" };
}

// What a review accounts for: a record for every check its manifest names, which may leave out a record only for a
// check another step runs, and the skips that still let it pass.
interface Accounting {
	readonly checks: CheckRecord[];
	readonly allowSkip: string[];
	readonly producers: FindingSource[];
}

// Records for the lenses and decision questions the manifest names; the lens step owns `lens.*`, so a record of that
// name from elsewhere, such as a check runner that skips lenses, gives way. Every other check's record comes from
// `supplied`; adjudication calls one with none a check that never started.
function account(
	manifest: readonly string[],
	ran: readonly LensRun[],
	result: LensResult | undefined,
	options: Pick<ReviewOptions, "config" | "lenses" | "checks">,
): Accounting {
	const { config } = options;
	const supplied = (options.checks ?? []).filter((check) => !check.name.startsWith("lens."));
	const checks: CheckRecord[] = [...supplied, ...ran.map((lens) => lensCheck(lens, result))];
	const allowSkip: string[] = [...config.checks.allowSkip];
	const recorded = new Set(checks.map((check) => check.name));
	for (const name of manifest) {
		if (recorded.has(name)) continue;
		if (name.startsWith("lens.")) {
			const lens = name.slice("lens.".length);
			const settings = Object.hasOwn(config.lenses, lens) ? config.lenses[lens] : undefined;
			if (!options.lenses.some((each) => each.name === lens)) {
				checks.push({ name, status: "failed", reason: `no lens is named ${lens}` });
			} else if (settings?.enabled === false) {
				checks.push({ name, status: "skipped", reason: `lenses.${lens}.enabled is false` });
			} else {
				// Nothing it covers changed, so there was nothing for it to review: a change of excluded paths alone passes
				// on its deterministic checks.
				checks.push({ name, status: "skipped", reason: "no paths" });
				allowSkip.push(name);
			}
		} else if (name.startsWith("decisions.") && config.decisions.provider === undefined) {
			checks.push({ name, status: "skipped", reason: "no decision provider is configured" });
		}
	}
	// The design lets the fast tier run without decision questions when no provider is configured.
	if (config.decisions.provider === undefined) {
		allowSkip.push(...manifest.filter((name) => name.startsWith("decisions.")));
	}
	const versions = new Map(supplied.map((check) => [check.name, check.version]));
	const others = [...new Set([...manifest, ...supplied.map((check) => check.name)])].filter(
		(name) => !name.startsWith("lens."),
	);
	const producers: FindingSource[] = [
		...ran.map((lens) => ({ check: `lens.${lens.name}`, version: lens.version })),
		...others.map((check) => {
			const version = versions.get(check);
			return version === undefined ? { check } : { check, version };
		}),
	];
	return { checks, allowSkip, producers };
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
export async function reviewChangeset(options: ReviewOptions): Promise<Review> {
	const { harness, changeset, config, standards, models } = options;
	const context = options.context ?? backgroundContext;
	const root = (await harness.root(context)).id;
	// A file's old path too, so a move out of a lens's paths still runs the lens on what left them.
	const paths = changeset.revision.files.flatMap((file) =>
		file.oldPath === undefined ? [file.path] : [file.oldPath, file.path],
	);
	const manifest = checksOfTier(config, options.tier ?? config.stages["pull-request"] ?? "full");
	const named = new Set(manifest.filter((name) => name.startsWith("lens.")).map((name) => name.slice("lens.".length)));
	const selected = selectLenses(
		options.lenses.filter((lens) => named.has(lens.name)),
		config,
		paths,
	);
	const nonce = reviewNonce();
	const running = selected.map(({ lens }) => lens.name);
	const lenses: LensRun[] = [];
	for (const { lens, coverage, files } of selected) {
		// Every lens may report an injection attempt, so the policy section never names a rule the hook refuses.
		const rules = lens.rules.some((rule) => rule.id === injectionAttemptRule.id)
			? lens.rules
			: [...lens.rules, injectionAttemptRule];
		// Every lens runs at its default level until triage chooses one per review.
		const level = defaultScrutinyLevel;
		const settings = lensLevel(lens, level);
		lenses.push({
			key: `${lens.name}@${lens.version}`,
			name: lens.name,
			version: lens.version,
			level,
			route: await chooseRoute(lens.name, settings.tier, config, models),
			instructions: renderLensInstructions({ ...lens, rules }, standards, level, running),
			tools: lens.tools,
			severities: lens.severities,
			rules,
			budget: settings.budget,
			coverage,
			prompt: renderChangePrompt(changeset, nonce, files),
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
			: await runLenses(harness, { root, revision: state, lenses }, options.rerun === true, context);
	// Only the lenses this review ran count: one that configuration has since disabled or retiered leaves nothing behind.
	const { checks, allowSkip, producers } = account(manifest, lenses, lensResult, options);
	const input = adjudicationInput({
		root,
		repoRoot,
		base,
		head,
		policy: options.policy,
		config,
		manifest,
		checks,
		findingsVersion: await findingsVersion(harness, root, reviewed, context),
		allowSkip,
		producers,
		origin: options.origin ?? { kind: "range" },
		lenses: lenses.map((lens) => lens.key),
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
