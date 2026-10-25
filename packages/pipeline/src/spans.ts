import { type Context, defineDocFamily, type Harness } from "./harness.ts";

/** One timed piece of a review's work that no durable task times. */
export type Span = { name: string; startedAt: number; endedAt: number; durationMs: number; parent?: string };

/** A review's spans, from the host process's start to its verdict. */
export type PrepareRecord = { startedAt: number; endedAt: number; spans: Span[] };

// Keyed by revision in the root conversation. The work it times runs again on every review, so the next review of the
// revision replaces the record rather than add to it.
export const PrepareDocument = defineDocFamily<PrepareRecord, null>({
	kind: "melian.prepare",
	family: true,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ startedAt: 0, endedAt: 0, spans: [] }),
});

/**
 * The orchestrator's own steps between durable tasks, held in memory until the review stores them with
 * {@link PrepareSpans.record}. One step is open at a time; a host ends it before waiting on a task, whose own timing
 * covers the wait.
 */
export class PrepareSpans {
	readonly startedAt: number;
	readonly #now: () => number;
	readonly #spans: Span[] = [];
	#open: { name: string; startedAt: number } | undefined;

	private constructor(startedAt: number, now: () => number) {
		this.startedAt = startedAt;
		this.#now = now;
		this.#open = undefined;
	}

	/** Opens the step `name` at `startedAt`, such as the host process's start. */
	static start(name: string, startedAt: number, now: () => number = Date.now): PrepareSpans {
		const spans = new PrepareSpans(startedAt, now);
		spans.#open = { name, startedAt };
		return spans;
	}

	/** Ends the open step and opens `name`. */
	step(name: string): void {
		this.end();
		this.#open = { name, startedAt: this.#now() };
	}

	/** Ends the open step, if any. */
	end(): void {
		if (this.#open === undefined) return;
		this.#push(this.#open.name, this.#open.startedAt);
		this.#open = undefined;
	}

	/** Times `work` as a span inside the open step, whether it settles or throws. */
	async time<T>(name: string, work: () => Promise<T>): Promise<T> {
		const parent = this.#open?.name;
		const startedAt = this.#now();
		try {
			return await work();
		} finally {
			this.#push(name, startedAt, parent);
		}
	}

	/** Ends the open step and stores the record for `revision`, replacing an earlier review's. */
	async record(harness: Harness, revision: string, context: Context): Promise<PrepareRecord> {
		// The record ends where its open step does: a second clock read could land a millisecond later.
		const open = this.#open !== undefined;
		this.end();
		const record: PrepareRecord = {
			startedAt: this.startedAt,
			endedAt: open ? this.#spans.at(-1)!.endedAt : this.#now(),
			spans: structuredClone(this.#spans),
		};
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			Object.assign(await tx.doc(PrepareDocument, root.id, revision, null), structuredClone(record));
		}, context);
		return record;
	}

	#push(name: string, startedAt: number, parent?: string): void {
		const endedAt = this.#now();
		this.#spans.push({
			name,
			startedAt,
			endedAt,
			durationMs: endedAt - startedAt,
			...(parent === undefined ? {} : { parent }),
		});
	}
}
