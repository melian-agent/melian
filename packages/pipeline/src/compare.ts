import {
	Comparison,
	type ComparisonEntry,
	type ExternalImport,
	type StoredComparison,
	type StoredComparisonAdjudication,
	type StoredVerdict,
	Verdict,
} from "@melian-agent/core";
import { VerdictDocument } from "./adjudication.ts";
import { revisionKey } from "./findings.ts";
import {
	backgroundContext,
	type Context,
	createRegistry,
	defineDoc,
	type Harness,
	openHarness,
	type Storage,
} from "./harness.ts";
import { modelsOf, type ReviewModels } from "./models.ts";

// Each revision's comparison, keyed by `revisionKey` of the stored review it compares against, on the changeset's root
// conversation beside the findings. It keeps its latest value, as the review index does: a comparison is the
// maintainer's record of other reviewers, and a fork that forgot it would lose the hand matches.
export const ComparisonDocument = defineDoc<{ comparisons: Record<string, StoredComparison> }>({
	kind: "melian.comparisons",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ comparisons: {} }),
});

/** Why a comparison could not be read or recorded. */
export type CompareErrorCode = "notReviewed" | "unreadable";

/** A comparison could not be read or recorded: Melian has no review of the revision, or a reviewer's file is unreadable. */
export class CompareError extends Error {
	readonly code: CompareErrorCode;

	constructor(code: CompareErrorCode, message: string, options: { cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "CompareError";
		this.code = code;
	}
}

/** What one importer read, and the source the comparison records it under. */
export interface ImportedSource {
	readonly source: string;
	readonly imported: ExternalImport;
}

type Revision = { readonly base: string; readonly head: string; readonly target?: string };

/**
 * A durable harness over one changeset's storage that reads and records its comparisons with external reviewers. It
 * installs no task, so a review or publication a crash interrupted does not resume in it, and it never asks a model.
 * Close it when done, which closes the storage.
 */
export class CompareHarness {
	/** Pi's harness. */
	readonly harness: Harness;

	private constructor(harness: Harness) {
		this.harness = harness;
	}

	/** Opens one over `storage`. `models` may hold no credentials. A failed open closes `storage`. */
	static async open(
		storage: Storage,
		models: ReviewModels,
		context: Context = backgroundContext,
	): Promise<CompareHarness> {
		const harness = await openHarness(
			storage,
			{ models: modelsOf(models), registry: createRegistry() },
			context,
		).catch(async (error: unknown) => {
			// Pi closes the storage only once it has built a harness; an open refused before that leaves it to us.
			await storage.close(backgroundContext).catch(() => undefined);
			throw error;
		});
		return new CompareHarness(harness);
	}

	/** Whether Melian has a stored review of `revision` to compare against. */
	async reviewed(revision: Revision, context: Context = backgroundContext): Promise<boolean> {
		const root = await this.harness.root(context);
		const document = await this.harness.snapshot(VerdictDocument, root.id, context);
		return document !== undefined && Object.hasOwn(document.verdicts, revisionKey(revision));
	}

	/** The comparison recorded for `revision`, or `undefined` when there is none. */
	async read(revision: Revision, context: Context = backgroundContext): Promise<Comparison | undefined> {
		const root = await this.harness.root(context);
		const comparisons = (await this.harness.snapshot(ComparisonDocument, root.id, context))?.comparisons;
		const key = revisionKey(revision);
		return comparisons === undefined || !Object.hasOwn(comparisons, key)
			? undefined
			: Comparison.from(comparisons[key]!);
	}

	/** Reads every comparison beside its stored verdict, refreshing matches without writing. */
	async all(changeset: string, context: Context = backgroundContext): Promise<ComparisonEntry[]> {
		const root = await this.harness.root(context);
		const comparisons = (await this.harness.snapshot(ComparisonDocument, root.id, context))?.comparisons ?? {};
		const verdicts = (await this.harness.snapshot(VerdictDocument, root.id, context))?.verdicts ?? {};
		return Object.entries(comparisons).map(([key, stored]) => {
			const comparison = Comparison.from(stored);
			const verdict = Object.hasOwn(verdicts, key)
				? Verdict.from(JSON.parse(JSON.stringify(verdicts[key])) as StoredVerdict)
				: undefined;
			if (verdict !== undefined) comparison.compare(verdict);
			return { changeset, comparison, ...(verdict === undefined ? {} : { verdict }) };
		});
	}

	/**
	 * Adds what each source read to the comparison of `revision`, as of `at`, and matches it against Melian's stored
	 * review of the revision, in one commit. Each source's import replaces what it last imported, so the import is replay
	 * safe.
	 * Throws {@link CompareError} `notReviewed` when Melian has no review of the revision.
	 */
	importFindings(
		revision: Revision,
		sources: readonly ImportedSource[],
		at: string,
		context: Context = backgroundContext,
	): Promise<Comparison> {
		return this.update(
			revision,
			(comparison) => {
				comparison.record(at, revision.target);
				for (const { source, imported } of sources) comparison.import(source, imported, at);
			},
			context,
		);
	}

	/**
	 * Matches an external finding with a Melian finding by hand, as `by` at `at`. Throws core's `ComparisonError` for an
	 * ID the comparison does not hold, and {@link CompareError} `notReviewed` when Melian has no review of the revision.
	 */
	match(
		revision: Revision,
		pair: { readonly external: string; readonly melian: string },
		hand: { readonly by: string; readonly at: string },
		context: Context = backgroundContext,
	): Promise<Comparison> {
		return this.update(
			revision,
			(comparison) => comparison.match(pair.external, pair.melian, hand.by, hand.at),
			context,
		);
	}

	/** Records that an external finding and a Melian finding are not one defect, as {@link CompareHarness.match} does. */
	unmatch(
		revision: Revision,
		pair: { readonly external: string; readonly melian: string },
		hand: { readonly by: string; readonly at: string },
		context: Context = backgroundContext,
	): Promise<Comparison> {
		return this.update(
			revision,
			(comparison) => comparison.unmatch(pair.external, pair.melian, hand.by, hand.at),
			context,
		);
	}

	/** Records a local comparison judgement in one commit; never changes the verdict or lifecycle. */
	adjudicate(
		revision: Revision,
		id: string,
		judgement: StoredComparisonAdjudication,
		context: Context = backgroundContext,
	): Promise<Comparison> {
		return this.update(
			revision,
			(comparison) => {
				comparison.adjudicate(id, judgement);
				comparison.record(judgement.at, revision.target);
			},
			context,
		);
	}

	/** Closes the harness and its storage. Idempotent. */
	close(context: Context = backgroundContext): Promise<void> {
		return this.harness.close(context);
	}

	// Reads the stored review and the comparison in one commit, so a review that records another verdict a moment before
	// is the one compared against; matches against the review after `change`, so a hand match names a finding it holds.
	private async update(
		revision: Revision,
		change: (comparison: Comparison) => void,
		context: Context,
	): Promise<Comparison> {
		const root = await this.harness.root(context);
		const key = revisionKey(revision);
		return root.commit(async (tx) => {
			const verdicts = (await tx.doc(VerdictDocument, root.id)).verdicts;
			if (!Object.hasOwn(verdicts, key)) {
				throw new CompareError("notReviewed", `Melian has no review of ${key} to compare against`);
			}
			// A copy through JSON: the stored verdict is the commit's own view, which structuredClone refuses.
			const verdict = Verdict.from(JSON.parse(JSON.stringify(verdicts[key]!)) as StoredVerdict);
			const document = await tx.doc(ComparisonDocument, root.id);
			const stored = document.comparisons[key];
			const comparison = stored === undefined ? Comparison.of(revision) : Comparison.from(stored);
			comparison.compare(verdict);
			change(comparison);
			comparison.compare(verdict);
			document.comparisons = { ...document.comparisons, [key]: comparison.toJSON() };
			return comparison;
		}, context);
	}
}
