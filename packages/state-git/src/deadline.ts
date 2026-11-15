/** The time a store reads and waits by; tests pass their own to reach a deadline without waiting for it. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)) };

// The one time a call must end by. Every git command and every wait of the call takes only what is left of it.
export class Deadline {
	readonly #clock: Clock;
	readonly #end: number;

	private constructor(clock: Clock, end: number) {
		this.#clock = clock;
		this.#end = end;
	}

	static after(clock: Clock, ms: number): Deadline {
		return new Deadline(clock, clock.now() + ms);
	}

	left(): number {
		return this.#end - this.#clock.now();
	}

	// The earlier of this deadline and `ms` from now, for a step that must leave time for what follows it.
	within(ms: number): Deadline {
		return new Deadline(this.#clock, Math.min(this.#end, this.#clock.now() + ms));
	}

	async sleep(ms: number): Promise<void> {
		const left = this.left();
		if (left > 0) await this.#clock.sleep(Math.min(ms, left));
	}
}
