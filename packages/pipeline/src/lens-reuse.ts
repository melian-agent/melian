/** A lens run as the copy rule reads it: its key, its request's key, and the run it escalates to. */
export type ReusableRun<Run> = {
	readonly key: string;
	readonly request?: string;
	readonly escalation?: { readonly next?: Run };
};

/** A run's stored outcome as the copy rule reads it. */
export type ReusableOutcome = {
	readonly status: string;
	readonly escalation?: { readonly to?: string };
	readonly reused?: number;
	readonly imported?: string;
};

/**
 * A lens's runs copied from an earlier task: that task, the nonce its conversations were rendered under, and the outcome
 * of each run it copies, by key. A lens imported from another host's records names the record of its first run instead,
 * since no conversation of this host's holds it.
 */
export type LensCopy<Outcome> =
	| { readonly task: number; readonly nonce: string; readonly outcomes: Record<string, Outcome> }
	| { readonly record: string; readonly outcomes: Record<string, Outcome> };

/**
 * The lenses of `lenses` a new lens task copies from `previous`, a completed task of the same revision, keyed by each
 * lens's first run. A lens is copied only when an earlier run has its request's key and `stands` says that run, and
 * the run it escalated to, may stand for it. A quick run's key holds its next run's, so a change to either reruns both.
 * Each copied outcome names the task that asked it, and the copy the nonce that task rendered it under, which a copy of
 * a copy keeps.
 */
export function lensCopies<Run extends ReusableRun<Run>, Outcome extends ReusableOutcome>(
	previous: {
		readonly task: number;
		readonly nonce: string;
		readonly lenses: readonly Run[];
		readonly result: Record<string, Outcome>;
		readonly reused?: Readonly<Record<string, { readonly nonce: string } | { readonly record: string }>>;
	},
	lenses: readonly Run[],
	stands: (run: Run, outcome: Outcome | undefined) => boolean,
): Record<string, LensCopy<Outcome & { readonly reused: number }>> {
	const copies: Record<string, LensCopy<Outcome & { readonly reused: number }>> = {};
	for (const first of lenses) {
		if (first.request === undefined) continue;
		const earlier = previous.lenses.find((run) => run.request === first.request);
		if (earlier === undefined) continue;
		const outcome = previous.result[earlier.key];
		if (!stands(earlier, outcome)) continue;
		const runs: [Run, Outcome][] = [[earlier, outcome!]];
		const to = outcome!.escalation?.to;
		if (to !== undefined) {
			const next = earlier.escalation?.next;
			if (next === undefined || next.key !== to || !stands(next, previous.result[to])) continue;
			runs.push([next, previous.result[to]!]);
		}
		const outcomes = Object.fromEntries(
			runs.map(([run, each]) => [run.key, { ...each, reused: each.reused ?? previous.task }]),
		);
		// A copy of an imported lens stays an import, since the earlier task held no conversation of it either.
		const copied = previous.reused?.[earlier.key];
		copies[first.key] =
			copied !== undefined && "record" in copied
				? { record: copied.record, outcomes }
				: { task: previous.task, nonce: copied?.nonce ?? previous.nonce, outcomes };
	}
	return copies;
}
