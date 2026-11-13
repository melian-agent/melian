import { randomUUID } from "node:crypto";

/** Who holds a lease: one run, in one clone or host. */
export interface LeaseHolder {
	readonly clone: string;
	readonly run: string;
}

/** A lease as its store keeps it. */
export type StoredLease = {
	holder: { clone: string; run: string };
	takenAt: string;
	expiresAt: string;
	incarnation: string;
	generation: number;
};

/** A lease that cannot be read, or a holder a store could not read back. */
export class LeaseError extends Error {
	readonly code = "invalidLease";

	constructor(message: string) {
		super(message);
		this.name = "LeaseError";
	}
}

const nameLimit = 200;

function name(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= nameLimit;
}

function time(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * The right to write one changeset across processes and hosts, as [the coordination
 * decision](../../../docs/decisions/2026-11-08-how-melian-coordinates.md) sets: a holder, when it was taken, when it
 * expires, an incarnation, and a fencing generation that rises every time it is taken. The incarnation is minted when
 * the lease record is first created and kept by every later taking, so generations compare only within one record. A
 * record disposed and created again starts afresh, under a new incarnation. Taking it is a compare-and-set on the store
 * that holds it. A write records the incarnation and generation it was made under, and the store refuses one its latest
 * lease does not admit, so a holder that outlived its expiry cannot overwrite the writer that took the lease after it.
 */
export class Lease {
	readonly holder: LeaseHolder;
	readonly takenAt: string;
	readonly expiresAt: string;
	readonly incarnation: string;
	readonly generation: number;

	private constructor(
		holder: LeaseHolder,
		takenAt: string,
		expiresAt: string,
		incarnation: string,
		generation: number,
	) {
		this.holder = holder;
		this.takenAt = takenAt;
		this.expiresAt = expiresAt;
		this.incarnation = incarnation;
		this.generation = generation;
	}

	/**
	 * Takes the lease after `previous`, one generation higher in its incarnation, for `durationMs` from `now`. With no
	 * previous lease the record is new, and gets a new incarnation at generation 1.
	 */
	static take(previous: Lease | undefined, holder: LeaseHolder, now: number, durationMs: number): Lease {
		if (!name(holder.clone) || !name(holder.run))
			throw new LeaseError(`a lease's holder must name a clone and a run of 1 to ${nameLimit} characters each`);
		return new Lease(
			{ clone: holder.clone, run: holder.run },
			new Date(now).toISOString(),
			new Date(now + durationMs).toISOString(),
			previous?.incarnation ?? randomUUID(),
			(previous?.generation ?? 0) + 1,
		);
	}

	/** Reads a lease its store kept, refusing anything else. */
	static parse(value: unknown): Lease {
		if (typeof value !== "object" || value === null) throw new LeaseError("a lease is not an object");
		const { holder, takenAt, expiresAt, incarnation, generation } = value as Record<string, unknown>;
		const { clone, run } = (typeof holder === "object" && holder !== null ? holder : {}) as Record<string, unknown>;
		if (!name(clone) || !name(run)) throw new LeaseError("a lease's holder does not name a clone and a run");
		if (!time(takenAt) || !time(expiresAt)) throw new LeaseError("a lease's times are not times");
		if (!name(incarnation)) throw new LeaseError("a lease's incarnation is not a short string");
		if (!Number.isSafeInteger(generation) || (generation as number) < 1)
			throw new LeaseError("a lease's generation is not a count");
		return new Lease({ clone, run }, takenAt, expiresAt, incarnation, generation as number);
	}

	live(now: number): boolean {
		return Date.parse(this.expiresAt) > now;
	}

	heldBy(holder: LeaseHolder): boolean {
		return this.holder.clone === holder.clone && this.holder.run === holder.run;
	}

	/** The same lease, held for `durationMs` from `now`. */
	renewed(now: number, durationMs: number): Lease {
		return new Lease(
			this.holder,
			this.takenAt,
			new Date(now + durationMs).toISOString(),
			this.incarnation,
			this.generation,
		);
	}

	/** The same lease, expired at `now`; its generation stays, so the next taking rises past it. */
	released(now: number): Lease {
		return new Lease(this.holder, this.takenAt, new Date(now).toISOString(), this.incarnation, this.generation);
	}

	/** Whether a write made under `incarnation` and `generation` may land: only one made under this lease's own. */
	admits(incarnation: string, generation: number): boolean {
		return incarnation === this.incarnation && generation === this.generation;
	}

	toJSON(): StoredLease {
		return {
			holder: { clone: this.holder.clone, run: this.holder.run },
			takenAt: this.takenAt,
			expiresAt: this.expiresAt,
			incarnation: this.incarnation,
			generation: this.generation,
		};
	}
}
