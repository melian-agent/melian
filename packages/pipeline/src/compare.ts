import {
	Comparison,
	type ComparisonEntry,
	type ExternalImport,
	Revision,
	type StoredComparison,
	type StoredComparisonAdjudication,
	type StoredVerdict,
} from "@melian-agent/core";
import { VerdictDocument } from "./adjudication.ts";
import { FindingsDocument } from "./findings.ts";
import {
	backgroundContext,
	type Context,
	type ConversationId,
	createRegistry,
	defineDoc,
	type Harness,
	type JsonObject,
	openHarness,
	ROOT_CONVERSATION_ID,
	type Storage,
	type TaskId,
	type Tx,
} from "./harness.ts";
import { modelsOf, type ReviewModels } from "./models.ts";
import { ReviewIndex } from "./review-index.ts";
import { legacyKey, Round, RoundReader, RoundsDocument, RoundWriter } from "./rounds.ts";

type ComparisonState = {
	legacy: Record<string, boolean>;
	comparisons: Record<string, StoredComparison>;
	unattributed: Record<string, StoredComparison>;
};

class StoredComparisons {
	readonly state: ComparisonState;

	private constructor(state: ComparisonState) {
		this.state = state;
	}

	static from(state: ComparisonState): StoredComparisons {
		return new StoredComparisons(structuredClone(state));
	}

	static upgrade(value: JsonObject): ComparisonState {
		return { legacy: {}, comparisons: {}, unattributed: value.comparisons as Record<string, StoredComparison> };
	}

	attribute(rounds: readonly Round[], changeset: string): void {
		for (const [key, stored] of Object.entries(this.state.unattributed)) {
			if (
				!this.state.legacy[key] &&
				rounds.some((round) => Revision.key(round.stored) === key && round.stored.mintedAt !== undefined)
			)
				continue;
			this.state.comparisons[`${changeset}.${legacyKey(key)}`] = stored;
			delete this.state.unattributed[key];
			delete this.state.legacy[key];
		}
	}

	entries(rounds: readonly Round[], changeset: string): ComparisonEntry[] {
		return [
			...Object.entries(this.state.comparisons)
				.sort(
					([left], [right]) =>
						rounds.findIndex((round) => round.id === left) - rounds.findIndex((round) => round.id === right),
				)
				.map(([id, stored]) => {
					const comparison = Comparison.from(stored);
					const verdict = rounds.find((round) => round.id === id)?.verdict();
					if (verdict !== undefined) comparison.compare(verdict);
					return { changeset, round: id, comparison, ...(verdict === undefined ? {} : { verdict }) };
				}),
			...Object.entries(this.state.unattributed).map(([key, stored]) => ({
				changeset,
				unattributed: key,
				comparison: Comparison.from(stored),
			})),
		];
	}
}

export const ComparisonDocument = defineDoc<ComparisonState>({
	kind: "melian.comparisons",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ legacy: {}, comparisons: {}, unattributed: {} }),
	// Attribution needs the sibling rounds document, which Pi's migration callback cannot read.
	migrate: (value) => StoredComparisons.upgrade(value),
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

type ComparedRevision = {
	readonly base: string;
	readonly head: string;
	readonly target?: string;
	readonly round?: string;
};

/**
 * A durable harness over one changeset's storage that reads and records its comparisons with external reviewers. It
 * installs no task, so a review or publication a crash interrupted does not resume in it, and it never asks a model.
 * Close it when done, which closes the storage.
 */
export class CompareHarness {
	/** Pi's harness. */
	readonly harness: Harness;

	readonly changeset: string;
	private readonly storage: Storage;

	private constructor(harness: Harness, changeset: string, storage: Storage) {
		this.harness = harness;
		this.changeset = changeset;
		this.storage = storage;
	}

	/** Opens one over `storage`. `models` may hold no credentials. A failed open closes `storage`. */
	static async open(
		storage: Storage,
		models: ReviewModels,
		changeset: string,
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
		return new CompareHarness(harness, changeset, storage);
	}

	/** Whether the selected round is decided, or the requested unattributed comparison exists. */
	async reviewed(revision: ComparedRevision, context: Context = backgroundContext): Promise<boolean> {
		if (revision.round === "unattributed") return (await this.read(revision, context)) !== undefined;
		const root = await this.harness.root(context);
		return root.commit(async (tx) => {
			try {
				await this.selected(tx, root.id, revision);
				return true;
			} catch (error) {
				if (error instanceof CompareError && error.code === "notReviewed") return false;
				throw error;
			}
		}, context);
	}

	/** The comparison recorded for the selected round or unattributed revision, or undefined when absent. */
	async read(revision: ComparedRevision, context: Context = backgroundContext): Promise<Comparison | undefined> {
		const root = await this.harness.root(context);
		const rounds = await new RoundReader(this.storage).read(this.changeset, context);
		const state =
			(await this.harness.snapshot(ComparisonDocument, root.id, context)) ?? ComparisonDocument.definition.initial();
		const stored = StoredComparisons.from(state);
		stored.attribute(rounds, this.changeset);
		if (revision.round === "unattributed") {
			const previous = stored.state.unattributed[Revision.key(revision)];
			return previous === undefined ? undefined : Comparison.from(previous);
		}
		const stateOfRounds = await this.harness.snapshot(RoundsDocument, root.id, context);
		const id =
			revision.round ??
			`${this.changeset}.${stateOfRounds?.current[Revision.key(revision)] ?? legacyKey(Revision.key(revision))}`;
		return stored.state.comparisons[id] === undefined ? undefined : Comparison.from(stored.state.comparisons[id]);
	}

	/** Reads every comparison beside its round's verdict, without writing. */
	async all(changeset: string, context: Context = backgroundContext): Promise<ComparisonEntry[]> {
		return (await ComparisonReader.open(this.storage).read(this.changeset, context)).map((entry) => ({
			...entry,
			changeset,
		}));
	}

	/**
	 * Adds what each source read to the comparison of `revision`, as of `at`, and matches it against Melian's stored
	 * review of the revision, in one commit. Each source's import replaces what it last imported, so the import is replay
	 * safe.
	 * Throws {@link CompareError} `notReviewed` when Melian has no review of the revision.
	 */
	importFindings(
		revision: ComparedRevision,
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
		revision: ComparedRevision,
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
		revision: ComparedRevision,
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
	async adjudicate(
		revision: ComparedRevision,
		id: string,
		judgement: StoredComparisonAdjudication,
		context: Context = backgroundContext,
	): Promise<Comparison> {
		return this.update(
			revision,
			(comparison, entries) => {
				const previous = entries
					.map((entry) => entry.comparison.adjudication(id)?.current)
					.filter((each) => each !== undefined)
					.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
				comparison.adjudicate(id, {
					...judgement,
					golden: judgement.golden ?? previous?.golden,
					rule: judgement.rule ?? previous?.rule,
				});
				comparison.record(judgement.at, revision.target);
			},
			context,
		);
	}

	/** Closes the harness and its storage. Idempotent. */
	close(context: Context = backgroundContext): Promise<void> {
		return this.harness.close(context);
	}

	private async currentVerdict(tx: Tx, root: ConversationId, key: string): Promise<StoredVerdict | undefined> {
		const document = await tx.doc(VerdictDocument, root);
		if (!Object.hasOwn(document.verdicts, key)) return undefined;
		const deciding = (await tx.doc(ReviewIndex, root)).reviews[key]?.adjudication;
		const now = (await tx.doc(FindingsDocument, root)).versions[key] ?? 0;
		const decision = document.decisions?.[key];
		if (deciding === undefined) {
			if (decision !== undefined && decision.findingsVersion !== now) return undefined;
		} else {
			const task = await tx.task(deciding.task as TaskId);
			if (task?.state.status !== "terminal") return undefined;
			const { outcome } = task.state;
			if (outcome.status !== "completed" || outcome.result !== "recorded") return undefined;
			const decided = decision ?? {
				task: deciding.task,
				findingsVersion: (JSON.parse(deciding.input) as { findingsVersion: number }).findingsVersion,
			};
			if (decided.task !== deciding.task || decided.findingsVersion !== now) return undefined;
		}
		// Pi's commit view cannot be structured-cloned or retained after the commit settles.
		return JSON.parse(JSON.stringify(document.verdicts[key]!)) as StoredVerdict;
	}

	private async selected(tx: Tx, root: ConversationId, revision: ComparedRevision): Promise<Round> {
		const key = Revision.key(revision);
		const state = await tx.doc(RoundsDocument, root);
		const local =
			revision.round === undefined
				? (state.current[key] ?? legacyKey(key))
				: revision.round.slice(this.changeset.length + 1);
		const live = await tx.doc(VerdictDocument, root);
		const stored =
			state.items[local] ??
			(!state.recorded[key] && local === legacyKey(key)
				? { base: revision.base, head: revision.head, tasks: [], verdict: live.verdicts[key] }
				: undefined);
		if (
			(revision.round !== undefined && !revision.round.startsWith(`${this.changeset}.`)) ||
			stored === undefined ||
			stored.verdict === undefined
		)
			throw new CompareError(
				"notReviewed",
				`Melian has no decided round ${revision.round ?? key} to compare against; run melian review again`,
			);
		if (
			(state.current[Revision.key(stored)] ?? legacyKey(Revision.key(stored))) === local &&
			(await this.currentVerdict(tx, root, Revision.key(stored))) === undefined
		)
			throw new CompareError(
				"notReviewed",
				`Melian has no current, decided review of ${Revision.key(stored)} to compare against; run melian review again`,
			);
		return new Round(`${this.changeset}.${local}`, JSON.parse(JSON.stringify(stored)));
	}

	private async update(
		revision: ComparedRevision,
		change: (comparison: Comparison, entries: ComparisonEntry[]) => void,
		context: Context,
	): Promise<Comparison> {
		const root = await this.harness.root(context);
		return root.commit(async (tx) => {
			const round = revision.round === "unattributed" ? undefined : await this.selected(tx, root.id, revision);
			const document = await tx.doc(ComparisonDocument, root.id);
			const state = await new RoundWriter(tx, root.id).preserve(Revision.key(round?.stored ?? revision));
			const rounds = Object.entries(state.items).map(
				([key, stored]) => new Round(`${this.changeset}.${key}`, JSON.parse(JSON.stringify(stored))),
			);
			const stored = StoredComparisons.from(JSON.parse(JSON.stringify(document)));
			stored.attribute(rounds, this.changeset);
			const comparisons = round === undefined ? stored.state.unattributed : stored.state.comparisons;
			const key = round?.id ?? Revision.key(revision);
			const previous = comparisons[key];
			if (round === undefined && previous === undefined)
				throw new CompareError("notReviewed", `Melian has no unattributed comparison for ${key}`);
			const comparison = previous === undefined ? Comparison.of(round!.stored) : Comparison.from(previous);
			const verdict = round?.verdict();
			if (verdict !== undefined) comparison.compare(verdict);
			change(comparison, stored.entries(rounds, this.changeset));
			if (verdict !== undefined) comparison.compare(verdict);
			comparisons[key] = comparison.toJSON();
			document.comparisons = stored.state.comparisons;
			document.unattributed = stored.state.unattributed;
			document.legacy = stored.state.legacy;
			return comparison;
		}, context);
	}
}

/** Reads stored comparison documents without opening a harness or committing durable state. */
export class ComparisonReader {
	private readonly storage: Storage;

	private constructor(storage: Storage) {
		this.storage = storage;
	}

	/** A reader over `storage`, which the caller keeps and closes. */
	static open(storage: Storage): ComparisonReader {
		return new ComparisonReader(storage);
	}

	/** Reads the root's comparisons and verdicts through storage's detached read API. The caller owns storage. */
	async read(changeset: string, context: Context = backgroundContext): Promise<ComparisonEntry[]> {
		// Pi's Storage API has no multi-document read transaction or generation token.
		let generation = await this.roundsGeneration(context);
		for (;;) {
			const scope = { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } as const;
			const record = await this.storage.findDocument(
				{ kind: ComparisonDocument.definition.kind, scope },
				"current",
				context,
			);
			if (record === undefined) return [];
			const stored = await this.storage.document(record.id, "current", context);
			if (stored === undefined) return [];
			if (stored.version > ComparisonDocument.definition.version)
				throw new CompareError("unreadable", `comparison document has newer version ${stored.version}`);
			const state =
				stored.version === ComparisonDocument.definition.version
					? (stored.value as ComparisonState)
					: ComparisonDocument.definition.migrate!(stored.value, stored.version);
			const comparisons = StoredComparisons.from(state);
			const rounds = await new RoundReader(this.storage).read(changeset, context);
			const latest = await this.roundsGeneration(context);
			const changed = generation !== latest;
			generation = latest;
			if (changed) continue;
			comparisons.attribute(rounds, changeset);
			return comparisons.entries(rounds, changeset);
		}
	}

	private async roundsGeneration(context: Context): Promise<string | undefined> {
		const record = await this.storage.findDocument(
			{
				kind: RoundsDocument.definition.kind,
				scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
			},
			"current",
			context,
		);
		if (record === undefined) return undefined;
		return JSON.stringify(await this.storage.document(record.id, "current", context));
	}
}
