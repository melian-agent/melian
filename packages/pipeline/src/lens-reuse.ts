/** A lens run as the copy rule reads it: its key, its request's key, whether it probes, and the run it escalates to. */
export type ReusableRun = {
	readonly key: string;
	readonly request?: string;
	readonly probe?: unknown;
	readonly escalation?: { readonly next?: ReusableRun };
};

/** A run's stored outcome as the copy rule reads it. */
export type ReusableOutcome = {
	readonly status: string;
	readonly model?: string;
	readonly budgetEnded?: unknown;
	readonly capped?: number;
	readonly escalation?: { readonly to?: string };
	readonly reused?: number;
};

/** A lens's runs copied from an earlier task: that task, and the outcome of each run it copies, by key. */
export type LensCopy<Outcome> = { readonly task: number; readonly outcomes: Record<string, Outcome> };

// A run that ended as asked: answered, on a model the plan accepts, within its budgets, and not a probe. A probing run is
// never copied, so every finding it reports rests on a probe of its own review.
function finished(
	run: ReusableRun,
	outcome: ReusableOutcome | undefined,
	refused: (key: string, model: string) => boolean,
) {
	return (
		outcome !== undefined &&
		outcome.status === "done" &&
		outcome.budgetEnded === undefined &&
		outcome.capped === undefined &&
		!(outcome.model !== undefined && refused(run.key, outcome.model)) &&
		run.probe === undefined
	);
}

/**
 * The lenses of `lenses` a new lens task copies from `previous`, a completed task of the same revision, keyed by each
 * lens's first run. A lens is copied only when an earlier run has its request's key and it, and the run it escalated
 * to, finished as {@link finished} says. A quick run's key holds its next run's, so a change to either reruns both.
 * Each copied outcome names the task that asked it, which a copy of a copy keeps.
 */
export function lensCopies<Outcome extends ReusableOutcome>(
	previous: {
		readonly task: number;
		readonly lenses: readonly ReusableRun[];
		readonly result: Record<string, Outcome>;
	},
	lenses: readonly ReusableRun[],
	refused: (key: string, model: string) => boolean,
): Record<string, LensCopy<Outcome & { readonly reused: number }>> {
	const copies: Record<string, LensCopy<Outcome & { readonly reused: number }>> = {};
	for (const first of lenses) {
		if (first.request === undefined) continue;
		const earlier = previous.lenses.find((run) => run.request === first.request);
		if (earlier === undefined) continue;
		const outcome = previous.result[earlier.key];
		if (!finished(earlier, outcome, refused)) continue;
		const runs: [ReusableRun, Outcome][] = [[earlier, outcome!]];
		const to = outcome!.escalation?.to;
		if (to !== undefined) {
			const next = earlier.escalation?.next;
			if (next === undefined || next.key !== to || !finished(next, previous.result[to], refused)) continue;
			runs.push([next, previous.result[to]!]);
		}
		copies[first.key] = {
			task: previous.task,
			outcomes: Object.fromEntries(
				runs.map(([run, each]) => [run.key, { ...each, reused: each.reused ?? previous.task }]),
			),
		};
	}
	return copies;
}
