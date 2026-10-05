import {
	Adjudication,
	type CheckRecord,
	type CheckStatus,
	ConfigError,
	type ConfigFor,
	configLookup,
	type Finding,
	type FindingSource,
	loadConfig,
	type MelianConfig,
	type PublicationDetails,
	type RepositorySource,
	type Resolution,
	type ScrutinyLevel,
	type Severity,
	type StoredVerdict,
	Verdict,
	type Walkthrough,
} from "@melian-agent/core";
import { findingsVersion, readFindings, revisionKey } from "./findings.ts";
import { type Context, type ConversationId, type DocumentReader, defineDoc, defineTask } from "./harness.ts";
import type { StoredBudgetEnd } from "./lens-tools.ts";
import { ReviewIndex } from "./review-index.ts";

// Type aliases with mutable arrays, not core's interfaces: a document's value must satisfy Pi's JsonObject.
type StoredAlias = string[] | { rules: string[]; distinct?: boolean };
type StoredCheck = {
	name: string;
	status: CheckStatus;
	reason?: string;
	error?: string;
	version?: string;
	level?: ScrutinyLevel;
	budgetEnded?: StoredBudgetEnd;
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
 * `revision:<sha>`, or `config` when the review named no source), the tier's checks, and each lens that ran as
 * `name@version`. Publishing reads it to refuse a verdict that must never reach a pull request.
 */
export type VerdictProvenance = ReviewOrigin & {
	readonly policy: string;
	readonly manifest: readonly string[];
	readonly lenses: readonly string[];
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
};

// The adjudication task that recorded a verdict, and the findings version it read before deciding. Absent for a verdict
// recorded before Melian kept it.
type StoredDecision = { task: number; findingsVersion: number };

// Each revision's verdict, keyed by `revisionKey` of its base and head, on the changeset's root conversation, with what
// it was decided from and the task that decided it under the same key.
export const VerdictDocument = defineDoc<{
	verdicts: Record<string, StoredVerdict>;
	provenance?: Record<string, StoredProvenance>;
	decisions?: Record<string, StoredDecision>;
	details?: Record<string, PublicationDetails>;
	walkthroughs?: Record<string, Walkthrough>;
	walkthroughNotes?: Record<string, string>;
}>({
	kind: "melian.verdicts",
	version: 5,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ verdicts: {} }),
	// Version 3 upgrades evidence; version 4 adds details and summaries; version 5 separates fallback notes.
	migrate: (value, from) => {
		if (from < 2)
			throw new Error(`the verdict document needs migrating from version ${from}, which Melian cannot do`);
		const state = value as {
			verdicts: Record<string, StoredVerdict>;
			walkthroughs?: Record<string, Walkthrough>;
			walkthroughNotes?: Record<string, string>;
		};
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
		return {
			...value,
			verdicts,
			...(state.walkthroughs === undefined ? {} : { walkthroughs }),
			...(Object.keys(walkthroughNotes).length === 0 ? {} : { walkthroughNotes }),
		};
	},
});

// What the adjudication task decides from. Everything is fixed when the review creates it, so a rerun decides alike.
export type AdjudicationTaskInput = {
	root: ConversationId;
	repoRoot: string;
	base: string;
	head: string;
	// Where per-path configuration is read from; without it, `config` applies to every path.
	policy?: RepositorySource;
	config: { resolution: Record<Severity, Resolution>; ruleAliases: Record<string, StoredAlias> };
	// Every check the review's tier names. One with no record in `checks` makes the verdict not reviewed.
	manifest: string[];
	checks: StoredCheck[];
	// The findings document's version of this revision when the review read it: a dismissal or a new sighting changes
	// it, so a repeat review after one starts a new task rather than return the verdict from before.
	findingsVersion: number;
	allowSkip: string[];
	// The producers whose sightings at the revision count, derived from the manifest: each lens the review ran, by check and
	// version, and every other check of the manifest, by name and the tool version its record names. A lens that
	// configuration has since disabled or retiered left sightings at this revision that are not this review's.
	producers: { check: string; version?: string }[];
	// Recorded with the verdict, so publishing can refuse one that came from a range or from the working tree.
	provenance: StoredProvenance;
};

const policyReview = "guardrail/policy-change-review";

// A policy-change-review finding resolves under the configuration that judged it, not its path's own, so a
// melian.yaml cannot resolve the review of a change to itself.
async function configsFor(
	repoRoot: string,
	policy: RepositorySource,
	findings: readonly Finding[],
): Promise<ConfigFor> {
	const lookup = configLookup(repoRoot, policy);
	const atPath = new Map<string, MelianConfig>();
	const judging = new Map<string, MelianConfig>();
	for (const { ruleId, properties } of findings) {
		const { path } = properties;
		if (!atPath.has(path)) atPath.set(path, (await loadConfig(repoRoot, policy, path)).config);
		if (ruleId === policyReview && !judging.has(path)) judging.set(path, await lookup.policyReview(path));
	}
	return (path, rule) => (rule === policyReview ? judging : atPath).get(path)!;
}

// `superseded` when a later review of the revision created another adjudication task before this one recorded.
export type AdjudicationResult = "recorded" | "superseded";

// Adjudicates the findings the root conversation holds at the revision under review and records the verdict in
// `VerdictDocument` under that revision. It reads, decides, and writes in one phase that ends in one commit, so a
// rerun after a crash writes the same verdict again. It records nothing once the review index names another task for
// the revision, so a crashed task that resumes late cannot overwrite a newer review's verdict.
export const AdjudicationTask = defineTask<AdjudicationTaskInput, { phase: "adjudicate" }, AdjudicationResult>({
	name: "melian.adjudication",
	version: 1,
	initial: () => ({ phase: "adjudicate" }),
	phases: {
		adjudicate: async (task, runtime, context) => {
			const { root, repoRoot, base, head, policy, config, manifest, checks, allowSkip, producers } = task.input;
			const revision = revisionKey({ base, head });
			// Read before the findings, so a write that lands between the two reads makes the verdict look older, never
			// newer, than what it was decided from.
			const seen = await findingsVersion(runtime, root, revision, context);
			const findings = await readFindings(runtime, root, revision, context, { producers });
			let verdict: Verdict;
			try {
				const configFor = policy === undefined ? () => config : await configsFor(repoRoot, policy, findings);
				verdict = new Adjudication({ findings, manifest, checks, config: configFor, allowSkip }).adjudicate();
			} catch (error) {
				// A policy that cannot be read is the task's outcome rather than a fault. It may not fail the same way next
				// time, as when a shallow clone fetches the base later, so the next review starts a new task.
				if (!(error instanceof ConfigError)) throw error;
				const failure = { message: error.message };
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "failed", error: failure } }),
					context,
				);
				return;
			}
			await runtime.commit(async (tx) => {
				const current = (await tx.doc(ReviewIndex, root)).reviews[revision]?.adjudication?.task;
				// An entry without an adjudication task was replaced by a review that has not created one yet.
				if (current !== runtime.taskId) {
					return { status: "terminal", outcome: { status: "completed", result: "superseded" } };
				}
				const document = await tx.doc(VerdictDocument, root);
				document.verdicts[revision] = structuredClone(verdict.toJSON());
				document.provenance = { ...document.provenance, [revision]: structuredClone(task.input.provenance) };
				document.decisions = { ...document.decisions, [revision]: { task: runtime.taskId, findingsVersion: seen } };
				return { status: "terminal", outcome: { status: "completed", result: "recorded" } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

export function adjudicationInput(options: {
	root: ConversationId;
	repoRoot: string;
	base: string;
	head: string;
	policy: RepositorySource | undefined;
	config: Pick<MelianConfig, "resolution" | "ruleAliases">;
	manifest: readonly string[];
	checks: readonly CheckRecord[];
	findingsVersion: number;
	allowSkip: readonly string[];
	producers: readonly FindingSource[];
	origin: ReviewOrigin;
	lenses: readonly string[];
}): AdjudicationTaskInput {
	const { root, repoRoot, base, head, policy, config, manifest, checks, findingsVersion, allowSkip, producers } =
		options;
	const { origin } = options;
	const provenance: StoredProvenance = {
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
	};
	return {
		root,
		repoRoot,
		base,
		head,
		...(policy === undefined ? {} : { policy: { ...policy } }),
		config: {
			resolution: { ...config.resolution },
			ruleAliases: structuredClone(config.ruleAliases) as Record<string, StoredAlias>,
		},
		manifest: [...manifest],
		checks: checks.map((check) => structuredClone(check)),
		findingsVersion,
		allowSkip: [...allowSkip],
		producers: producers.map((source) => ({ ...source })),
		provenance,
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
