import { existsSync } from "node:fs";
import { type AlsoReportedAs, type Finding, Verdict } from "@melian-agent/core";
import {
	type AdjudicationResult,
	AdjudicationTask,
	type AdjudicationTaskInput,
	readVerdict,
	VerdictDocument,
} from "./adjudication.ts";
import { DismissError } from "./errors.ts";
import { type Dismissal, dismissFinding, FindingsDocument, revisionKey } from "./findings.ts";
import {
	backgroundContext,
	type Context,
	createRegistry,
	defineExtension,
	type Harness,
	openHarness,
	type Storage,
	type TaskId,
} from "./harness.ts";
import { modelsOf, type ReviewModels } from "./models.ts";
import { attachable, ReviewIndex, undecided } from "./review-index.ts";

// The adjudication task alone, so a dismissal decides the verdict again without resuming a review a crash interrupted.
const adjudicationExtension = defineExtension({ name: "melian.adjudication", tasks: [AdjudicationTask] });

/**
 * A durable harness that records dismissals over one changeset's storage. It holds only the adjudication task, so a
 * review or publication a crash interrupted does not resume in it. Pass its `harness` to {@link recordDismissal}, and
 * close it when done, which closes the storage.
 */
export class DismissHarness {
	/** Pi's harness, which {@link recordDismissal} takes. */
	readonly harness: Harness;

	private constructor(harness: Harness) {
		this.harness = harness;
	}

	/** Opens one over `storage`. Adjudication asks no model, so `models` may hold no credentials. A failed open closes `storage`. */
	static async open(
		storage: Storage,
		models: ReviewModels,
		context: Context = backgroundContext,
	): Promise<DismissHarness> {
		const registry = createRegistry();
		registry.install(adjudicationExtension);
		const harness = await openHarness(storage, { models: modelsOf(models), registry }, context).catch(
			async (error: unknown) => {
				// Pi closes the storage only once it has built a harness; an open refused before that leaves it to us.
				await storage.close(backgroundContext).catch(() => undefined);
				throw error;
			},
		);
		return new DismissHarness(harness);
	}

	/** Closes the harness and its storage. Idempotent. */
	close(context: Context = backgroundContext): Promise<void> {
		return this.harness.close(context);
	}
}

/** What {@link recordDismissal} dismisses. */
export interface DismissalOptions {
	/** A harness over the changeset's storage that defines the adjudication task, such as a {@link DismissHarness}'s. */
	readonly harness: Harness;
	/** The base and head of the stored review the finding belongs to. */
	readonly revision: { readonly base: string; readonly head: string };
	/** The finding's ID, as the stored verdict names it. */
	readonly id: string;
	readonly dismissal: Dismissal;
	/**
	 * Dismiss the report `id` names alone, leaving every other report adjudication merged with it live. By default the
	 * finding is dismissed as the verdict shows it, with every report merged into it.
	 */
	readonly only?: boolean;
	/**
	 * The checkout the verdict's per-path policy is read from, in place of the one the review ran in, which may have
	 * been a worktree since removed.
	 */
	readonly repoRoot: string;
	readonly context?: Context;
}

/** What {@link recordDismissal} recorded, and the verdict decided again with it. */
export interface RecordedDismissal {
	/** The dismissed finding as the new verdict holds it, or the dismissed finding that speaks for it after a merge. */
	readonly finding: Finding;
	/** The reports adjudication had merged into the finding, dismissed with it: none with `only`. */
	readonly also: readonly AlsoReportedAs[];
	/** The dismissal this one replaced, when the finding was dismissed already with another reason or dismisser. */
	readonly replaced?: Dismissal;
	readonly verdict: Verdict;
}

/**
 * Dismisses a finding of a stored review and decides the review's verdict again. The dismissal is lifecycle status on
 * the changeset's findings document, so it holds across reruns and new heads until the finding's trigger changes
 * materially. Adjudication, which alone writes resolution, then reads it: the commit that records the dismissal also
 * creates an adjudication task over the review's own input, with the findings version the dismissal moved to, and
 * names it in the review index, so a later review of the revision attaches to it rather than deciding a third time.
 *
 * Throws core's `FindingError` `invalidDismissal` for a dismissal it refuses, and {@link DismissError}: `notReviewed`
 * when no verdict is stored for the revision, `unknownFinding` when the verdict holds no finding with the ID,
 * `notInstalled` when the harness does not define the adjudication task, and `adjudicationFailed` when the dismissal
 * was recorded but the verdict could not be decided again.
 */
export async function recordDismissal(options: DismissalOptions): Promise<RecordedDismissal> {
	const { harness, id, dismissal, repoRoot } = options;
	const context = options.context ?? backgroundContext;
	const revision = revisionKey(options.revision);
	const where = { revision, finding: id };
	const root = await harness.root(context);
	const again = "run melian review again";
	const { replaced, also, task } = await root.commit(async (tx) => {
		// Read in the commit, so a review that recorded another verdict a moment before decides what the ID names.
		const stored = (await tx.doc(VerdictDocument, root.id)).verdicts[revision];
		if (stored === undefined) throw new DismissError("notReviewed", `Melian has no review of ${revision}`, where);
		const found = Verdict.from(stored).defect(id);
		if (found === undefined) {
			throw new DismissError("unknownFinding", `the review of ${revision} has no finding ${id}`, where);
		}
		// The finding as the verdict shows it: its own report and every report adjudication merged into it, so dismissing
		// one defect never leaves another check's report of it live, unless the caller asked for the one report alone.
		const reports = found.dismiss(options.only ? id : undefined);
		const [own] = reports;
		const members = options.only ? [] : found.members;
		const index = await tx.doc(ReviewIndex, root.id);
		const entry = index.reviews[revision];
		const known = entry?.adjudication;
		if (entry === undefined || known === undefined) {
			throw new DismissError("notReviewed", `Melian has no adjudication of ${revision} to repeat; ${again}`, where);
		}
		const recorded = (await tx.doc(FindingsDocument, root.id)).items;
		const dismissed = [...new Set(reports)].filter((report) => Object.hasOwn(recorded, report));
		let replaced: Dismissal | undefined;
		for (const report of dismissed) {
			const before = await dismissFinding(tx, root.id, report, dismissal);
			if (report === own) replaced = before;
		}
		// The review's own input with the findings version the dismissal moved to, keeping its key order, so a later
		// review that computes the same input attaches to this task. The review's checkout stays while it exists, since
		// another worktree may hold another melian.yaml.
		const previous = JSON.parse(known.input) as AdjudicationTaskInput;
		const findingsVersion = (await tx.doc(FindingsDocument, root.id)).versions[revision] ?? 0;
		const checkout = existsSync(previous.repoRoot) ? previous.repoRoot : repoRoot;
		const input: AdjudicationTaskInput = { ...previous, repoRoot: checkout, findingsVersion };
		const key = JSON.stringify(input);
		// Copies: the stored verdict is the commit's own view, unusable once the commit settles.
		const also = members.filter((other) => dismissed.includes(other.id)).map((other) => ({ ...other }));
		// The same dismissal again, as after a dismiss a crash cut short, waits for the adjudication it started, unless
		// that ended without deciding, failed included, as a review would rerun it.
		if (known.input === key && (await attachable(tx, known.task, [...undecided, "failed"]))) {
			return { replaced, also, task: known.task as TaskId<AdjudicationResult> };
		}
		const task = await tx.createTask(AdjudicationTask, input, { ownership: { kind: "conversation" } });
		index.reviews = { ...index.reviews, [revision]: { ...entry, adjudication: { task, input: key } } };
		return { replaced, also, task };
	}, context);
	harness.resume();
	const blocked = (await harness.inspect(context)).tasks.some(
		(each) => each.record.id === (task as TaskId) && each.state.kind === "blocked",
	);
	if (blocked) {
		await harness.abortTask(task, context);
		throw new DismissError(
			"notInstalled",
			`the dismissal is recorded, but the harness cannot adjudicate; open it with DismissHarness, then ${again}`,
			where,
		);
	}
	let { outcome } = (await harness.waitForTask(task, context)).state;
	// A review of the revision that started after the dismissal's commit replaced its adjudication with one of its own,
	// which reads the dismissal; its verdict is the one to report.
	if (outcome.status === "completed" && outcome.result === "superseded") {
		const newer = (await harness.snapshot(ReviewIndex, root.id, context))?.reviews[revision]?.adjudication?.task;
		if (newer !== undefined && newer !== (task as number)) {
			({ outcome } = (await harness.waitForTask(newer as TaskId<AdjudicationResult>, context)).state);
		}
	}
	const verdict = await readVerdict(harness, root.id, revision, context);
	const finding = verdict?.defect(id)?.speaker;
	if (
		outcome.status !== "completed" ||
		outcome.result !== "recorded" ||
		finding?.properties.status !== "dismissed" ||
		verdict === undefined
	) {
		const why = outcome.status === "failed" ? `: ${outcome.error.message}` : "";
		throw new DismissError(
			"adjudicationFailed",
			`the dismissal is recorded, but the verdict was not decided again${why}; ${again}`,
			where,
		);
	}
	return { finding, also, ...(replaced === undefined ? {} : { replaced }), verdict };
}
