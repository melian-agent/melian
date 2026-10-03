import {
	adjudicate,
	type CheckRecord,
	type CheckStatus,
	ConfigError,
	type ConfigFor,
	type FindingSource,
	loadConfig,
	type MelianConfig,
	type RepositorySource,
	type Resolution,
	type ResolvedFinding,
	type Severity,
	type Verdict,
	type VerdictStatus,
} from "@melian-agent/core";
import { readFindings } from "./findings.ts";
import { type Context, type ConversationId, type DocumentReader, defineDoc, defineTask } from "./harness.ts";
import { ReviewIndex } from "./review-index.ts";

// Type aliases with mutable arrays, not core's interfaces: a document's value must satisfy Pi's JsonObject.
type StoredAlias = string[] | { rules: string[]; distinct?: boolean };
type StoredCheck = { name: string; status: CheckStatus; reason?: string; error?: string; version?: string };

type StoredVerdict = {
	status: VerdictStatus;
	blocking: boolean;
	findings: Record<Resolution, ResolvedFinding[]>;
	dismissed: ResolvedFinding[];
	notRun: StoredCheck[];
};

// Each revision's verdict, keyed by head commit, on the changeset's root conversation.
export const VerdictDocument = defineDoc<{ verdicts: Record<string, StoredVerdict> }>({
	kind: "melian.verdicts",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ verdicts: {} }),
});

// What the adjudication task decides from. Everything is fixed when the review creates it, so a rerun decides alike.
export type AdjudicationTaskInput = {
	root: ConversationId;
	repoRoot: string;
	head: string;
	// Where per-path configuration is read from; without it, `config` applies to every path.
	policy?: RepositorySource;
	config: { resolution: Record<Severity, Resolution>; ruleAliases: Record<string, StoredAlias> };
	// Every check the review's tier names. One with no record in `checks` makes the verdict not reviewed.
	manifest: string[];
	checks: StoredCheck[];
	allowSkip: string[];
	// The producers whose sightings at `head` count, derived from the manifest: each lens the review ran, by check and
	// version, and every other check of the manifest, by name and the tool version its record names. A lens that
	// configuration has since disabled or retiered left sightings at this head that are not this review's.
	producers: { check: string; version?: string }[];
};

async function configsFor(repoRoot: string, policy: RepositorySource, paths: readonly string[]): Promise<ConfigFor> {
	const loaded = new Map<string, MelianConfig>();
	for (const path of new Set(paths)) loaded.set(path, (await loadConfig(repoRoot, policy, path)).config);
	return (path) => loaded.get(path)!;
}

// `superseded` when a later review of the head created another adjudication task before this one recorded.
export type AdjudicationResult = "recorded" | "superseded";

// Adjudicates the findings the root conversation holds at the head under review and records the verdict in
// `VerdictDocument` under that head. It reads, decides, and writes in one phase that ends in one commit, so a
// rerun after a crash writes the same verdict again. It records nothing once the review index names another task for
// the head, so a crashed task that resumes late cannot overwrite a newer review's verdict.
export const AdjudicationTask = defineTask<AdjudicationTaskInput, { phase: "adjudicate" }, AdjudicationResult>({
	name: "melian.adjudication",
	version: 1,
	initial: () => ({ phase: "adjudicate" }),
	phases: {
		adjudicate: async (task, runtime, context) => {
			const { root, repoRoot, head, policy, config, manifest, checks, allowSkip, producers } = task.input;
			const findings = await readFindings(runtime, root, head, context, { producers });
			let verdict: Verdict;
			try {
				const paths = findings.map((finding) => finding.properties.path);
				const configFor = policy === undefined ? () => config : await configsFor(repoRoot, policy, paths);
				verdict = adjudicate({ findings, manifest, checks, config: configFor, allowSkip });
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
				const current = (await tx.doc(ReviewIndex, root)).reviews[head]?.adjudication?.task;
				// An entry without an adjudication task was replaced by a review that has not created one yet.
				if (current !== runtime.taskId) {
					return { status: "terminal", outcome: { status: "completed", result: "superseded" } };
				}
				(await tx.doc(VerdictDocument, root)).verdicts[head] = structuredClone(verdict) as StoredVerdict;
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
	head: string;
	policy: RepositorySource | undefined;
	config: Pick<MelianConfig, "resolution" | "ruleAliases">;
	manifest: readonly string[];
	checks: readonly CheckRecord[];
	allowSkip: readonly string[];
	producers: readonly FindingSource[];
}): AdjudicationTaskInput {
	const { root, repoRoot, head, policy, config, manifest, checks, allowSkip, producers } = options;
	return {
		root,
		repoRoot,
		head,
		...(policy === undefined ? {} : { policy: { ...policy } }),
		config: {
			resolution: { ...config.resolution },
			ruleAliases: structuredClone(config.ruleAliases) as Record<string, StoredAlias>,
		},
		manifest: [...manifest],
		checks: checks.map((check) => structuredClone(check)),
		allowSkip: [...allowSkip],
		producers: producers.map((source) => ({ ...source })),
	};
}

/**
 * The verdict recorded for `revision`, a head commit, on the changeset's root conversation, or `undefined` when that
 * revision has none. A copy, so changing it cannot reach the harness's cached document.
 */
export async function readVerdict(
	reader: Pick<DocumentReader, "snapshot">,
	rootConversationId: ConversationId,
	revision: string,
	context: Context,
): Promise<Verdict | undefined> {
	const document = await reader.snapshot(VerdictDocument, rootConversationId, context);
	if (document === undefined || !Object.hasOwn(document.verdicts, revision)) return undefined;
	return structuredClone(document.verdicts[revision]);
}
