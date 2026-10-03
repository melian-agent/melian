import {
	adjudicate,
	type CheckRecord,
	type CheckStatus,
	ConfigError,
	type ConfigFor,
	type Finding,
	type FindingSource,
	loadConfig,
	type MelianConfig,
	type RepositorySource,
	type Resolution,
	type Severity,
	type Verdict,
	type VerdictStatus,
} from "@melian-agent/core";
import { readFindings } from "./findings.ts";
import { type Context, type ConversationId, type DocumentReader, defineDoc, defineTask } from "./harness.ts";

// Type aliases with mutable arrays, not core's interfaces: a document's value must satisfy Pi's JsonObject.
type StoredCheck = { name: string; status: CheckStatus; reason?: string; error?: string };

type StoredVerdict = {
	status: VerdictStatus;
	blocking: boolean;
	findings: Record<Resolution, Finding[]>;
	dismissed: Finding[];
	notRun: StoredCheck[];
};

/** Each revision's verdict, keyed by head commit, on the changeset's root conversation. */
export const VerdictDocument = defineDoc<{ verdicts: Record<string, StoredVerdict> }>({
	kind: "melian.verdicts",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ verdicts: {} }),
});

/** What the adjudication task decides from. Everything is fixed when the review creates it, so a rerun decides alike. */
export type AdjudicationTaskInput = {
	root: ConversationId;
	repoRoot: string;
	head: string;
	/** Where per-path configuration is read from; without it, `config` applies to every path. */
	policy?: RepositorySource;
	config: { resolution: Record<Severity, Resolution>; ruleAliases: Record<string, string[]> };
	checks: StoredCheck[];
	/**
	 * The producers whose sightings at `head` count: the lenses this review selected, by check and version. A lens that
	 * configuration has since disabled or retiered left sightings at this head that are not this review's.
	 */
	producers: { check: string; version?: string }[];
};

async function configsFor(repoRoot: string, policy: RepositorySource, paths: readonly string[]): Promise<ConfigFor> {
	const loaded = new Map<string, MelianConfig>();
	for (const path of new Set(paths)) loaded.set(path, (await loadConfig(repoRoot, policy, path)).config);
	return (path) => loaded.get(path)!;
}

/**
 * Adjudicates the findings the root conversation holds at the head under review and records the verdict in
 * {@link VerdictDocument} under that head. It reads, decides, and writes in one phase that ends in one commit, so a
 * rerun after a crash writes the same verdict again.
 */
export const AdjudicationTask = defineTask<AdjudicationTaskInput, { phase: "adjudicate" }, null>({
	name: "melian.adjudication",
	version: 1,
	initial: () => ({ phase: "adjudicate" }),
	phases: {
		adjudicate: async (task, runtime, context) => {
			const { root, repoRoot, head, policy, config, checks, producers } = task.input;
			const findings = await readFindings(runtime, root, head, context, { producers });
			let verdict: Verdict;
			try {
				const paths = findings.map((finding) => finding.properties.path);
				const configFor = policy === undefined ? () => config : await configsFor(repoRoot, policy, paths);
				verdict = adjudicate({ findings, checks, config: configFor });
			} catch (error) {
				// A policy that cannot be read fails the same way on every rerun, so it is the task's outcome.
				if (!(error instanceof ConfigError)) throw error;
				const failure = { message: error.message };
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "failed", error: failure } }),
					context,
				);
				return;
			}
			await runtime.commit(async (tx) => {
				(await tx.doc(VerdictDocument, root)).verdicts[head] = structuredClone(verdict) as StoredVerdict;
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/** The input of an adjudication task for one review. */
export function adjudicationInput(options: {
	root: ConversationId;
	repoRoot: string;
	head: string;
	policy: RepositorySource | undefined;
	config: Pick<MelianConfig, "resolution" | "ruleAliases">;
	checks: readonly CheckRecord[];
	producers: readonly FindingSource[];
}): AdjudicationTaskInput {
	const { root, repoRoot, head, policy, config, checks, producers } = options;
	return {
		root,
		repoRoot,
		head,
		...(policy === undefined ? {} : { policy: { ...policy } }),
		config: {
			resolution: { ...config.resolution },
			ruleAliases: Object.fromEntries(
				Object.entries(config.ruleAliases).map(([rule, others]) => [rule, [...others]]),
			),
		},
		checks: checks.map((check) => structuredClone(check)),
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
