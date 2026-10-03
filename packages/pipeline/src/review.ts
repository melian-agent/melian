import {
	type Changeset,
	type Finding,
	type Lens,
	type LensCoverage,
	type LensRule,
	type LensToolName,
	type MelianConfig,
	type ModelReference,
	renderLensInstructions,
	resolveModelForTier,
	type Severity,
	type StandardsSection,
	selectLenses,
	visibleText,
} from "@melian-agent/core";
import { ReviewError } from "./errors.ts";
import { readFindings, recordRevision } from "./findings.ts";
import {
	backgroundContext,
	type Context,
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	type Harness,
	isFailoverError,
	openHarness,
	type Registry,
	type Storage,
	type TaskId,
} from "./harness.ts";
import {
	injectionPolicySection,
	LensDocument,
	lensPolicyHook,
	lensReadTools,
	type ReviewState,
	reportFinding,
	reviewFiles,
} from "./lens-tools.ts";
import { modelsOf, type ReviewModels } from "./models.ts";
import { injectionAttemptRule, quoteUntrusted, reviewNonce } from "./untrusted.ts";

/** One lens as the lens task runs it: everything resolved, nothing left to look up. */
interface LensRun {
	readonly key: string;
	readonly name: string;
	readonly version: string;
	/** The tier's models that were known with credentials when the review started, in routing order. */
	readonly route: readonly ModelReference[];
	readonly instructions: string;
	readonly tools: readonly LensToolName[];
	readonly severities: readonly Severity[];
	readonly rules: readonly LensRule[];
	readonly budget: number;
	readonly coverage: LensCoverage;
	/** The change as this lens sees it: only the files it covers. */
	readonly prompt: string;
}

interface LensTaskInput {
	readonly root: ConversationId;
	readonly revision: ReviewState;
	readonly lenses: readonly LensRun[];
}

type LensOutcome =
	| { readonly status: "done" }
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

// Which lens task reviewed each head, and with which lenses, by `name@version`. Kept on the root conversation, so a
// later call for the same head and lenses finds the task, whether it finished, is running, or crashed.
const ReviewIndex = defineDoc<{ reviews: Record<string, { task: number; lenses: string[] }> }>({
	kind: "melian.reviews",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ reviews: {} }),
});

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
						budget: lens.budget,
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
						if (settled.status === "done") return [key, { status: "done" }];
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
 * The extension a review harness needs: the lens task, the lens tools, `report_finding`, and the hook that holds each
 * lens to its policy. {@link openReviewHarness} installs it; a host building its own registry installs it there.
 */
export const lensExtension = defineExtension({
	name: "melian.lenses",
	tools: [...Object.values(lensReadTools), reportFinding],
	sections: [injectionPolicySection],
	hooks: [lensPolicyHook],
	tasks: [LensTask],
});

/** A registry holding {@link lensExtension}. */
export function createReviewRegistry(): Registry {
	const registry = createRegistry();
	registry.install(lensExtension);
	return registry;
}

/**
 * Opens a harness over `storage` that can run reviews: {@link lensExtension} installed, models from `models`. Pass
 * `retry: false` to fail a model request at once rather than retry it with backoff, as tests and scripted evals do.
 */
export function openReviewHarness(
	storage: Storage,
	models: ReviewModels,
	options: { readonly retry?: boolean } = {},
	context: Context = backgroundContext,
): Promise<Harness> {
	const settings = options.retry === false ? { settings: { retry: { enabled: false } } } : {};
	return openHarness(storage, { models: modelsOf(models), registry: createReviewRegistry(), ...settings }, context);
}

const maxPromptBytes = 200 * 1024;

/**
 * The input a lens receives: the revision, the files it changes, and its zero-context diff, bounded. Everything from
 * the head enters inside `quoteUntrusted` boundaries carrying `nonce`: the file list as one listing, and each file's
 * diff as its own block whose first line is the file's path and status, so a changed line cannot pose as another
 * file's header. Paths are escaped with core's `visibleText`, so a newline in one cannot forge a line. `only` limits
 * the prompt to the files a lens covers.
 */
export function renderChangePrompt(changeset: Changeset, nonce: string, only?: readonly string[]): string {
	const { base, head } = changeset.revision;
	const files = changeset.revision.files.filter((file) => only === undefined || only.includes(file.path));
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
async function chooseRoute(lens: Lens, config: MelianConfig, review: ReviewModels): Promise<ModelReference[]> {
	const models = modelsOf(review);
	const route = resolveModelForTier(lens.tier, config.models);
	const available: ModelReference[] = [];
	for (const candidate of [route.model, ...route.fallbacks]) {
		if (models.getModel(candidate.provider, candidate.modelId) === undefined) continue;
		if ((await models.checkAuth(candidate.provider)) !== undefined) available.push(candidate);
	}
	if (available.length > 0) return available;
	const tried = [route.model, ...route.fallbacks].map(modelName).join(", ");
	throw new ReviewError(
		"noAvailableModel",
		`lens ${lens.name} needs a ${lens.tier} model, and none of ${tried} is known with credentials; log in with pi or set the provider's API key`,
		{ lenses: [lens.name] },
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
	readonly context?: Context;
}

/**
 * Reviews a changeset: selects the lenses its paths and configuration call for, runs each as a conversation owned by
 * one lens task, and returns the findings sighted at the head under review. Each lens starts on its tier's first
 * configured model that has credentials, and moves to the next when a provider failure outlasts pi-ai's retries or
 * authentication fails.
 *
 * Throws core's `ModelRoutingError` for a tier with no model, and {@link ReviewError}: `noAvailableModel` when no model
 * of a tier has credentials, `notInstalled` when the harness lacks {@link lensExtension}, `allModelsFailed` when every
 * model of a lens's route failed, naming them, and `lensFailed` when a lens did not finish for another reason. Both
 * carry the findings reported so far.
 */
export async function reviewChangeset(options: ReviewOptions): Promise<readonly Finding[]> {
	const { harness, changeset, config, standards, models } = options;
	const context = options.context ?? backgroundContext;
	const root = await harness.root(context);
	const paths = changeset.revision.files.map((file) => file.path);
	const selected = selectLenses(options.lenses, config, paths);
	if (selected.length === 0) return [];
	const nonce = reviewNonce();
	const lenses: LensRun[] = [];
	for (const { lens, coverage, files } of selected) {
		lenses.push({
			key: `${lens.name}@${lens.version}`,
			name: lens.name,
			version: lens.version,
			route: await chooseRoute(lens, config, models),
			instructions: renderLensInstructions(lens, standards),
			tools: lens.tools,
			severities: lens.severities,
			// Every lens may report an injection attempt, so the policy section never names a rule the hook refuses.
			rules: lens.rules.some((rule) => rule.id === injectionAttemptRule.id)
				? lens.rules
				: [...lens.rules, injectionAttemptRule],
			budget: lens.budget.findings,
			coverage,
			prompt: renderChangePrompt(changeset, nonce, files),
		});
	}
	const { repoRoot, revision } = changeset;
	const state: ReviewState = {
		repoRoot,
		nonce,
		base: revision.base,
		head: revision.head,
		files: reviewFiles(revision.files),
	};
	const selection = lenses.map((lens) => lens.key).sort();
	// One lens task per head and selection. A repeat call, such as a rerun after a crash, attaches to the task the first
	// call created, which the harness resumes, rather than running every lens a second time.
	const taskId = await root.commit(async (tx) => {
		const index = await tx.doc(ReviewIndex, root.id);
		const known = index.reviews[revision.head];
		if (known !== undefined && known.lenses.join("\n") === selection.join("\n"))
			return known.task as TaskId<LensResult>;
		await recordRevision(tx, root.id, revision.head);
		const created = await tx.createTask(
			LensTask,
			{ root: root.id, revision: state, lenses },
			{ ownership: { kind: "conversation" } },
		);
		index.reviews[revision.head] = { task: created, lenses: selection };
		return created;
	}, context);
	harness.resume();
	const blocked = (await harness.inspect(context)).tasks.find(
		(each) => each.record.id === taskId && each.state.kind === "blocked",
	);
	if (blocked !== undefined) {
		await harness.abortTask(taskId, context);
		throw new ReviewError(
			"notInstalled",
			"the harness has no melian.lenses extension; open it with openReviewHarness",
			{
				lenses: lenses.map((lens) => lens.name),
			},
		);
	}
	const settled = await harness.waitForTask(taskId, context);
	// Only the lenses this review ran: one that configuration has since disabled or retiered leaves nothing behind.
	const producers = lenses.map((lens) => ({ check: `lens.${lens.name}`, version: lens.version }));
	const findings = await readFindings(harness, root.id, changeset.revision.head, context, { producers });
	const outcome = settled.state.outcome;
	const exhausted = lenses.flatMap((lens) => {
		const result = outcome.status === "completed" ? outcome.result[lens.key] : undefined;
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
		});
	}
	const failed =
		outcome.status === "completed"
			? lenses.filter((lens) => outcome.result[lens.key]?.status !== "done").map((lens) => lens.name)
			: lenses.map((lens) => lens.name);
	if (failed.length > 0) {
		throw new ReviewError("lensFailed", `lenses did not finish: ${failed.join(", ")}`, { lenses: failed, findings });
	}
	return findings;
}
