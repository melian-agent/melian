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
	defineExtension,
	defineTask,
	type Harness,
	type Models,
	openHarness,
	type Registry,
	type Storage,
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
import { injectionAttemptRule, quoteUntrusted, reviewNonce } from "./untrusted.ts";

/** One lens as the lens task runs it: everything resolved, nothing left to look up. */
interface LensRun {
	readonly key: string;
	readonly name: string;
	readonly version: string;
	readonly model: ModelReference;
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

type LensOutcome = { readonly status: "done" } | { readonly status: "unanswered"; readonly reason: string };

type LensCheckpoint = { phase: "spawn" } | { phase: "review"; children: Record<string, ConversationId> };

// Spawns every lens conversation in one commit, so a crash leaves all of them or none; then runs them in parallel.
// The orchestrating conversation's model is never asked which lenses to run.
const LensTask = defineTask<LensTaskInput, LensCheckpoint, Record<string, LensOutcome>>({
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
						model: lens.model,
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
				return { status: "running", checkpoint: { phase: "review", children } };
			}, context);
		},
		review: async (task, runtime, context) => {
			const { children } = task.state.checkpoint as Extract<LensCheckpoint, { phase: "review" }>;
			const outcomes = await Promise.all(
				Object.entries(children).map(async ([key, id]): Promise<[string, LensOutcome]> => {
					const child = (await runtime.conversation(id, context))!;
					const lens = task.input.lenses.find((each) => each.key === key)!;
					const request = { type: "input", content: lens.prompt, requestId: `lens:${key}` } as const;
					const settled = await (await child.submit(request, context)).wait(context);
					if (settled.status === "done") return [key, { status: "done" }];
					return [key, { status: "unanswered", reason: settled.reason ?? "unanswered" }];
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

/** Opens a harness over `storage` that can run reviews: {@link lensExtension} installed, models from `models`. */
export function openReviewHarness(
	storage: Storage,
	models: Models,
	context: Context = backgroundContext,
): Promise<Harness> {
	return openHarness(storage, { models, registry: createReviewRegistry() }, context);
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
		const hunks = file.binary
			? ["(binary)"]
			: file.hunks.map(
					(hunk) =>
						`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.header ? ` ${hunk.header}` : ""}\n${hunk.text}`,
				);
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

async function chooseModel(lens: Lens, config: MelianConfig, models: Models): Promise<ModelReference> {
	const route = resolveModelForTier(lens.tier, config.models);
	for (const candidate of [route.model, ...route.fallbacks]) {
		if (models.getModel(candidate.provider, candidate.modelId) === undefined) continue;
		if ((await models.checkAuth(candidate.provider)) !== undefined) return candidate;
	}
	const tried = [route.model, ...route.fallbacks].map((each) => `${each.provider}/${each.modelId}`).join(", ");
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
	readonly models: Models;
	readonly context?: Context;
}

/**
 * Reviews a changeset: selects the lenses its paths and configuration call for, runs each as a conversation owned by
 * one lens task, and returns the root conversation's findings document. Each lens runs on its tier's first configured
 * model that has credentials.
 *
 * Throws core's `ModelRoutingError` for a tier with no model, and {@link ReviewError}: `noAvailableModel` when no model
 * of a tier has credentials, `notInstalled` when the harness lacks {@link lensExtension}, and `lensFailed` when a lens
 * did not finish, carrying the findings reported so far.
 */
export async function reviewChangeset(options: ReviewOptions): Promise<readonly Finding[]> {
	const { harness, changeset, config, standards, models } = options;
	const context = options.context ?? backgroundContext;
	const root = await harness.root(context);
	const paths = changeset.revision.files.map((file) => file.path);
	const selected = selectLenses(options.lenses, config, paths);
	if (selected.length === 0) return readFindings(harness, root.id, changeset.revision.head, context);
	const nonce = reviewNonce();
	const lenses: LensRun[] = [];
	for (const [index, { lens, coverage, files }] of selected.entries()) {
		lenses.push({
			key: `${index}-${lens.name}-${lens.version}`,
			name: lens.name,
			version: lens.version,
			model: await chooseModel(lens, config, models),
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
		resolution: { ...config.resolution },
	};
	const taskId = await root.commit(async (tx) => {
		await recordRevision(tx, root.id, revision.head);
		return tx.createTask(
			LensTask,
			{ root: root.id, revision: state, lenses },
			{ ownership: { kind: "conversation" } },
		);
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
	const findings = await readFindings(harness, root.id, changeset.revision.head, context);
	const outcome = settled.state.outcome;
	const failed =
		outcome.status === "completed"
			? lenses.filter((lens) => outcome.result[lens.key]?.status !== "done").map((lens) => lens.name)
			: lenses.map((lens) => lens.name);
	if (failed.length > 0) {
		throw new ReviewError("lensFailed", `lenses did not finish: ${failed.join(", ")}`, { lenses: failed, findings });
	}
	return findings;
}
