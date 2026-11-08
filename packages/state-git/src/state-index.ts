import { Lease, LeaseError, type StoredLease } from "@melian-agent/core";

/**
 * Why the state branch cannot be used: it could not be fetched or pushed, it holds what this build cannot read, or this
 * clone's copy holds what Pi's storage never writes.
 */
export class StateBranchError extends Error {
	readonly code: "fetchFailed" | "pushFailed" | "invalidBranch" | "invalidCopy" | "invalidKey" | "invalidHolder";

	constructor(code: StateBranchError["code"], message: string) {
		super(message);
		this.name = "StateBranchError";
		this.code = code;
	}
}

const version = 1;

function invalid(reason: string): StateBranchError {
	return new StateBranchError("invalidBranch", `the state branch's index.json cannot be read: ${reason}`);
}

// One changeset's record: its lease, taken or released, and the generation its latest write was made under.
type ChangesetRecord = { readonly lease: Lease; readonly written: number | undefined };

/**
 * The state branch's `index.json`: each changeset's lease, which a release expires but keeps, so the next taking's
 * generation rises past it, and the generation of the changeset's latest write.
 */
export class StateIndex {
	readonly #records: ReadonlyMap<string, ChangesetRecord>;
	/** What the writers' key commits to, so a clone holding another key refuses rather than write under it. */
	readonly key: string | undefined;

	private constructor(records: ReadonlyMap<string, ChangesetRecord>, key: string | undefined) {
		this.#records = records;
		this.key = key;
	}

	static empty(): StateIndex {
		return new StateIndex(new Map(), undefined);
	}

	/** Reads the index a branch holds, refusing one this build does not know rather than overwriting it. */
	static parse(json: string): StateIndex {
		let value: unknown;
		try {
			value = JSON.parse(json);
		} catch {
			throw invalid("it is not JSON");
		}
		if (typeof value !== "object" || value === null) throw invalid("it is not an object");
		const { version: found, key, changesets } = value as Record<string, unknown>;
		if (found !== version)
			throw invalid(`its version is ${JSON.stringify(found)}, and this build of Melian reads version ${version}`);
		if (typeof changesets !== "object" || changesets === null || Array.isArray(changesets))
			throw invalid("its changesets are not an object");
		if (key !== undefined && (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)))
			throw invalid("its key is not a commitment");
		const records = new Map<string, ChangesetRecord>();
		for (const [id, record] of Object.entries(changesets)) {
			if (typeof record !== "object" || record === null) throw invalid(`the record of ${id} is not an object`);
			const { lease: stored, written } = record as Record<string, unknown>;
			let lease: Lease;
			try {
				lease = Lease.parse(stored);
			} catch (error) {
				if (error instanceof LeaseError) throw invalid(`the lease of ${id}: ${error.message}`);
				throw error;
			}
			if (
				written !== undefined &&
				(!Number.isSafeInteger(written) || (written as number) < 1 || (written as number) > lease.generation)
			)
				throw invalid(`the written generation of ${id} is not one its lease has reached`);
			records.set(id, { lease, written: written as number | undefined });
		}
		return new StateIndex(records, key);
	}

	keyed(key: string): StateIndex {
		return new StateIndex(this.#records, key);
	}

	lease(changeset: string): Lease | undefined {
		return this.#records.get(changeset)?.lease;
	}

	/** The generation the changeset's latest write was made under. */
	written(changeset: string): number | undefined {
		return this.#records.get(changeset)?.written;
	}

	leased(changeset: string, lease: Lease): StateIndex {
		return this.#with(changeset, { lease, written: this.written(changeset) });
	}

	/** Records a write of the changeset under its current lease's generation. */
	wrote(changeset: string): StateIndex {
		const record = this.#records.get(changeset)!;
		return this.#with(changeset, { lease: record.lease, written: record.lease.generation });
	}

	/** Expires the changeset's lease at `now`, keeping its generation. */
	released(changeset: string, now: number): StateIndex {
		const record = this.#records.get(changeset)!;
		return this.#with(changeset, { lease: record.lease.released(now), written: record.written });
	}

	#with(changeset: string, record: ChangesetRecord): StateIndex {
		return new StateIndex(new Map([...this.#records, [changeset, record]]), this.key);
	}

	toJSON(): {
		version: number;
		key?: string;
		changesets: Record<string, { lease: StoredLease; written?: number }>;
	} {
		const changesets: Record<string, { lease: StoredLease; written?: number }> = {};
		for (const [id, { lease, written }] of [...this.#records].sort(([a], [b]) => a.localeCompare(b)))
			changesets[id] = { lease: lease.toJSON(), ...(written === undefined ? {} : { written }) };
		return { version, ...(this.key === undefined ? {} : { key: this.key }), changesets };
	}
}
