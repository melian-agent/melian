import {
	Adjudication,
	type ChangedFile,
	type CheckRecord,
	type CheckStatus,
	ConfigError,
	LensError,
	type MelianConfig,
	type MutationSkipCause,
	type PreExistingCap,
	type PublicationDetails,
	type RepositorySource,
	type Resolution,
	type ReviewPlan,
	Revision,
	type ScrutinyLevel,
	type Severity,
	type StoredPlan,
	type StoredVerdict,
	Verdict,
	type Walkthrough,
} from "@melian-agent/core";
import { configsFor } from "./configurations.ts";
import { findingsVersion, type Producer, readFindings, revisionKey, seenBefore } from "./findings.ts";
import { type Context, type ConversationId, type DocumentReader, defineDoc, defineTask } from "./harness.ts";
import type { StoredBudgetEnd } from "./lens-tools.ts";
import { ReviewIndex } from "./review-index.ts";
import { TaskTiming } from "./task-timing.ts";

// Type aliases with mutable arrays, not core's interfaces: a document's value must satisfy Pi's JsonObject.
type StoredAlias = string[] | { rules: string[]; distinct?: boolean };
type StoredCheck = {
	name: string;
	status: CheckStatus;
	reason?: string;
	cause?: MutationSkipCause;
	error?: string;
	version?: string;
	level?: ScrutinyLevel;
	budgetEnded?: StoredBudgetEnd;
	lineage?: {
		model: string;
		wanted?: string;
		by: string;
		moved?: { by: string; from: string; to: string };
		outside: boolean;
	};
};

/**
 * Where a review's revision came from. A `pull-request` review names the repository and pull request as its provider
 * reported them, and the base branch's tip and head commit the provider reported when the review fetched it. Any other
 * review is a `range`, even one naming the refs Melian fetched for a pull request.
 */
export type ReviewOrigin =
	| { readonly kind: "range" }
	| {
			readonly kind: "pull-request";
			readonly repository: { readonly owner: string; readonly name: string };
			readonly pullRequest: number;
			readonly base: string;
			readonly head: string;
	  };

/**
 * What a verdict was decided from, recorded beside it: its {@link ReviewOrigin}, where policy came from (`worktree`,
 * `revision:<sha>`, or `config` when the review named no source), the tier's checks, each lens that ran as
 * `name@version@level`, the level of the run whose record stands for it, and the review plan, as `ReviewPlan.from`
 * reads it, when the review had one. Publishing reads it to refuse a verdict that must never reach a pull request; a
 * summary reads the plan the review ran under, even after a crash, rather than resolve another.
 */
export type VerdictProvenance = ReviewOrigin & {
	readonly policy: string;
	readonly manifest: readonly string[];
	readonly lenses: readonly string[];
	readonly plan?: StoredPlan;
	readonly verifierVersion?: string;
};

type StoredProvenance = {
	kind: "range" | "pull-request";
	repository?: { owner: string; name: string };
	pullRequest?: number;
	base?: string;
	head?: string;
	policy: string;
	manifest: string[];
	lenses: string[];
	plan?: StoredPlan;
	verifierVersion?: string;
};

// The adjudication task that recorded a verdict, and the findings version it read before deciding. Absent for a verdict
// recorded before Melian kept it.
type StoredDecision = { task: number; findingsVersion: number };

// Each revision's verdict, keyed by `revisionKey` of its base and head, on the changeset's root conversation, with what
// it was decided from and the task that decided it under the same key.
type StoredVerdictState = {
	verdicts: Record<string, StoredVerdict>;
	provenance?: Record<string, StoredProvenance>;
	decisions?: Record<string, StoredDecision>;
	details?: Record<string, PublicationDetails>;
	walkthroughs?: Record<string, Walkthrough>;
	walkthroughNotes?: Record<string, string>;
	// Finished or replaced summariser attempts since the last success; pending tasks spend no attempt.
	walkthroughAttempts?: Record<string, number>;
};

class VerdictState {
	readonly stored: StoredVerdictState;

	constructor(stored: StoredVerdictState) {
		this.stored = stored;
	}

	static upgrade(value: unknown, from: number): StoredVerdictState {
		if (from < 1)
			throw new Error(`the verdict document needs migrating from version ${from}, which Melian cannot do`);
		const state = value as StoredVerdictState;
		const walkthroughs = { ...state.walkthroughs };
		const walkthroughNotes = { ...state.walkthroughNotes };
		for (const [revision, walkthrough] of Object.entries(walkthroughs)) {
			if (walkthrough.note !== undefined) {
				walkthroughNotes[revision] = "No walkthrough available. The summariser returned no summary.";
				delete walkthroughs[revision];
			}
		}
		const verdicts = Object.fromEntries(
			Object.entries(state.verdicts).map(([revision, verdict]) => [revision, Verdict.upgrade(verdict)]),
		);
		return new VerdictState({
			...state,
			verdicts,
			...(state.walkthroughs === undefined ? {} : { walkthroughs }),
			...(Object.keys(walkthroughNotes).length === 0 ? {} : { walkthroughNotes }),
		}).toJSON();
	}

	toJSON(): StoredVerdictState {
		return this.stored;
	}
}

export const VerdictDocument = defineDoc<StoredVerdictState>({
	kind: "melian.verdicts",
	version: 9,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => new VerdictState({ verdicts: {} }).toJSON(),
	// Version 9 lets a check that did not complete be `provisional`, a mutation run that reused an earlier head's results;
	// a version 8 verdict has none and reads unchanged.
	// Version 8 lets a finding hold what its guardrail matched and which file and entry decided its resolution; a
	// version 7 finding holds neither and reads unchanged.
	// Version 7 lets a verdict list its important pre-existing findings and a finding hold an original severity; a
	// version 6 verdict has neither and reads unchanged. Older records keep head-only keys and leave per-lens standards absent.
	migrate: (value, from) => VerdictState.upgrade(value, from),
});

// What the adjudication task decides from. Everything is fixed when the review creates it, so a rerun decides alike.
export type AdjudicationTaskInput = {
	root: ConversationId;
	repoRoot: string;
	base: string;
	head: string;
	// Where per-path configuration is read from; without it, `config` applies to every path.
	policy?: RepositorySource;
	// `configsFor`'s fingerprint of the policy the findings resolved under when the review created the task: each
	// path's layers and each lens's declared default, which `config` does not hold. A working tree's policy can change
	// under one source, so a repeat review after such a change starts a new task. Absent without a policy source, and
	// from a task an older Melian created.
	resolutionPolicy?: string;
	// `preExisting` is absent from an input an older Melian stored, and every cap is then advisory.
	config: {
		resolution: Record<Severity, Resolution> & { preExisting?: Record<Severity, PreExistingCap> };
		ruleAliases: Record<string, StoredAlias>;
	};
	// Every check the review's tier names. One with no record in `checks` makes the verdict not reviewed.
	manifest: string[];
	checks: StoredCheck[];
	// The findings document's version of this revision when the review read it: a dismissal or a new sighting changes
	// it, so a repeat review after one starts a new task rather than return the verdict from before.
	findingsVersion: number;
	allowSkip: string[];
	// The producers whose sightings at the revision count, derived from the manifest: each lens the review ran, by check and
	// version with the level of the run whose record stands for it, and every other check of the manifest, by name and
	// the tool version its record names. A lens that configuration has since disabled or retiered, or a quick run that
	// escalated, left sightings at this revision that are not this review's. One an older Melian recorded names a lens's
	// version alone, and still reads its own sightings.
	producers: { check: string; version?: string; ids?: string[] }[];
	// Recorded with the verdict, so publishing can refuse one that came from a range or from the working tree.
	provenance: StoredProvenance;
	verificationRan?: boolean;
	// What the review ran, recorded in the commit that records the verdict.
	details?: PublicationDetails;
	// The changed files the findings name, with each hunk's ranges, so lens reports one hunk caused merge. Absent from a
	// version 1 input, which merges by snippet alone.
	files?: ChangedFile[];
};

// `superseded` when a later review of the revision created another adjudication task before this one recorded.
export type AdjudicationResult = "recorded" | "superseded";

// Adjudicates the findings the root conversation holds at the revision under review and records the verdict in
// `VerdictDocument` under that revision. It reads, decides, and writes in one phase that ends in one commit, so a
// rerun after a crash writes the same verdict again. It records nothing once the review index names another task for
// the revision, so a crashed task that resumes late cannot overwrite a newer review's verdict.
export const AdjudicationTask = defineTask<
	AdjudicationTaskInput,
	{ phase: "adjudicate"; legacyTiming?: true },
	AdjudicationResult
>({
	name: "melian.adjudication",
	// Version 2 added `files`, and version 3 marks a task created before stage timing. A version 1 input holds no files,
	// so its task decides by snippet, as it did.
	version: 3,
	initial: () => ({ phase: "adjudicate" }),
	migrate: (input, checkpoint) => ({
		input: input as unknown as AdjudicationTaskInput,
		checkpoint: { ...(checkpoint as { phase: "adjudicate" }), legacyTiming: true },
	}),
	phases: {
		adjudicate: async (task, runtime, context) => {
			const timing = await TaskTiming.start(runtime, task.state.checkpoint.legacyTiming, context);
			const { root, repoRoot, base, head, policy, config, manifest, checks, allowSkip, producers } = task.input;
			const revision = revisionKey({ base, head });
			// Read before the findings, so a write that lands between the two reads makes the verdict look older, never
			// newer, than what it was decided from.
			const seen = await findingsVersion(runtime, root, revision, context);
			const findings = await readFindings(runtime, root, revision, context, { producers });
			const carried = await seenBefore(runtime, root, revision, context);
			let verdict: Verdict;
			try {
				const policies = policy === undefined ? undefined : await configsFor(repoRoot, policy, findings);
				// The input names the policy the review read. A working tree can change before this phase runs, as after a
				// dismissal a crash cut short, and a verdict decided under another policy must not sit under this input.
				const { resolutionPolicy } = task.input;
				if (
					policies !== undefined &&
					resolutionPolicy !== undefined &&
					![policies.fingerprint, policies.legacyFingerprint].includes(resolutionPolicy)
				) {
					throw new ConfigError(
						"invalidValue",
						repoRoot,
						"the resolution policy changed since the review read it, so its verdict would be decided under another",
					);
				}
				verdict = new Adjudication({
					findings,
					manifest,
					checks,
					config: policies ?? (() => config),
					allowSkip,
					verificationRan: task.input.verificationRan,
					seenBefore: carried,
					// A version 1 input holds no files, so no hunk merges it and the snippet rule decides alone.
					revision: Revision.from({ base, head, files: task.input.files ?? [] }),
				}).adjudicate();
			} catch (error) {
				// A policy that cannot be read is the task's outcome rather than a fault. It may not fail the same way next
				// time, as when a shallow clone fetches the base later, so the next review starts a new task.
				// A lens file is policy too: its declared resolution is read with the finding's configuration.
				if (!(error instanceof ConfigError) && !(error instanceof LensError)) throw error;
				const failure = { message: error.message };
				await runtime.commit(async (tx) => {
					await timing.end(tx);
					return { status: "terminal", outcome: { status: "failed", error: failure } };
				}, context);
				return;
			}
			await runtime.commit(async (tx) => {
				await timing.end(tx);
				const current = (await tx.doc(ReviewIndex, root)).reviews[revision]?.adjudication?.task;
				// An entry without an adjudication task was replaced by a review that has not created one yet.
				if (current !== runtime.taskId) {
					return { status: "terminal", outcome: { status: "completed", result: "superseded" } };
				}
				const document = await tx.doc(VerdictDocument, root);
				document.verdicts[revision] = structuredClone(verdict.toJSON());
				document.provenance = { ...document.provenance, [revision]: structuredClone(task.input.provenance) };
				if (task.input.details !== undefined)
					document.details = { ...document.details, [revision]: structuredClone(task.input.details) };
				document.decisions = { ...document.decisions, [revision]: { task: runtime.taskId, findingsVersion: seen } };
				return { status: "terminal", outcome: { status: "completed", result: "recorded" } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		const timing = await TaskTiming.read(runtime, context);
		await runtime.commit(async (tx) => {
			await timing.end(tx);
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

export function adjudicationInput(options: {
	root: ConversationId;
	repoRoot: string;
	base: string;
	head: string;
	policy: RepositorySource | undefined;
	resolutionPolicy?: string | undefined;
	config: Pick<MelianConfig, "resolution" | "ruleAliases">;
	manifest: readonly string[];
	checks: readonly CheckRecord[];
	findingsVersion: number;
	allowSkip: readonly string[];
	producers: readonly Producer[];
	origin: ReviewOrigin;
	lenses: readonly string[];
	plan?: ReviewPlan | undefined;
	verifierVersion?: string;
	verificationRan?: boolean;
	files?: readonly ChangedFile[];
}): AdjudicationTaskInput {
	const { root, repoRoot, base, head, policy, config, manifest, checks, findingsVersion, allowSkip, producers } =
		options;
	const { origin } = options;
	const provenance: StoredProvenance = {
		...(options.verifierVersion === undefined ? {} : { verifierVersion: options.verifierVersion }),
		kind: origin.kind,
		...(origin.kind === "pull-request"
			? {
					repository: { ...origin.repository },
					pullRequest: origin.pullRequest,
					base: origin.base,
					head: origin.head,
				}
			: {}),
		policy: policy === undefined ? "config" : policy.kind === "worktree" ? "worktree" : `revision:${policy.commit}`,
		manifest: [...manifest],
		lenses: [...options.lenses].sort(),
		...(options.plan === undefined ? {} : { plan: options.plan.toJSON() }),
	};
	return {
		root,
		repoRoot,
		base,
		head,
		...(policy === undefined ? {} : { policy: { ...policy } }),
		...(options.resolutionPolicy === undefined ? {} : { resolutionPolicy: options.resolutionPolicy }),
		config: {
			resolution: structuredClone(config.resolution),
			ruleAliases: structuredClone(config.ruleAliases) as Record<string, StoredAlias>,
		},
		manifest: [...manifest],
		checks: checks.map((check) => structuredClone(check)),
		findingsVersion,
		allowSkip: [...allowSkip],
		producers: producers.map(({ ids, ...source }) => ({
			...source,
			...(ids === undefined ? {} : { ids: [...ids] }),
		})),
		provenance,
		...(options.verificationRan === undefined ? {} : { verificationRan: options.verificationRan }),
		...(options.files === undefined ? {} : { files: structuredClone([...options.files]) }),
	};
}

/**
 * What the verdict recorded for `revision` was decided from, or `undefined` when that revision has none, or its
 * verdict was recorded before Melian kept provenance.
 */
export async function readProvenance(
	reader: Pick<DocumentReader, "snapshot">,
	rootConversationId: ConversationId,
	revision: string,
	context: Context,
): Promise<VerdictProvenance | undefined> {
	const document = await reader.snapshot(VerdictDocument, rootConversationId, context);
	const stored = document?.provenance;
	if (stored === undefined || !Object.hasOwn(stored, revision)) return undefined;
	return structuredClone(stored[revision]) as VerdictProvenance;
}

/**
 * The adjudication task that recorded the verdict for `revision` and the findings version it decided from, or
 * `undefined` when that revision has no verdict, or its verdict was recorded before Melian kept them.
 */
export async function readDecision(
	reader: Pick<DocumentReader, "snapshot">,
	rootConversationId: ConversationId,
	revision: string,
	context: Context,
): Promise<StoredDecision | undefined> {
	const decisions = (await reader.snapshot(VerdictDocument, rootConversationId, context))?.decisions;
	return decisions === undefined || !Object.hasOwn(decisions, revision) ? undefined : { ...decisions[revision]! };
}

/**
 * The verdict recorded for `revision` on the changeset's root conversation, or `undefined` when that revision has none.
 * `revision` is the {@link revisionKey} of the base and head reviewed, so a pull request retargeted onto another base
 * has a verdict of its own. A copy, so changing it cannot reach the harness's cached document.
 */
export async function readVerdict(
	reader: Pick<DocumentReader, "snapshot">,
	rootConversationId: ConversationId,
	revision: string,
	context: Context,
): Promise<Verdict | undefined> {
	const document = await reader.snapshot(VerdictDocument, rootConversationId, context);
	if (document === undefined || !Object.hasOwn(document.verdicts, revision)) return undefined;
	return Verdict.from(structuredClone(document.verdicts[revision]!));
}
