/** Who holds a changeset on the state branch: the run, the clone it runs in, when it took the lease, and how often. */
export interface Lease {
	readonly run: string;
	readonly holder: string;
	readonly heartbeat: string;
	readonly attempts: number;
}

/** Why the state branch cannot be used: it could not be fetched or pushed, or it holds what this build cannot read. */
export class StateBranchError extends Error {
	readonly code: "fetchFailed" | "pushFailed" | "invalidBranch";

	constructor(code: StateBranchError["code"], message: string) {
		super(message);
		this.name = "StateBranchError";
		this.code = code;
	}
}

const version = 1;
const lengthLimit = 200;

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > lengthLimit)
		throw invalid(`its ${field} is not a short string`);
	return value;
}

function invalid(reason: string): StateBranchError {
	return new StateBranchError("invalidBranch", `the state branch's index.json cannot be read: ${reason}`);
}

function lease(value: unknown): Lease {
	if (typeof value !== "object" || value === null) throw invalid("a lease is not an object");
	const { run, holder, heartbeat, attempts } = value as Record<string, unknown>;
	if (!Number.isSafeInteger(attempts) || (attempts as number) < 1) throw invalid("a lease's attempts is not a count");
	if (Number.isNaN(Date.parse(text(heartbeat, "heartbeat")))) throw invalid("a lease's heartbeat is not a time");
	return {
		run: text(run, "run"),
		holder: text(holder, "holder"),
		heartbeat: heartbeat as string,
		attempts: attempts as number,
	};
}

/** The state branch's `index.json`: one record per changeset another run may be working on. */
export class StateIndex {
	readonly #leases: ReadonlyMap<string, Lease>;

	private constructor(leases: ReadonlyMap<string, Lease>) {
		this.#leases = leases;
	}

	static empty(): StateIndex {
		return new StateIndex(new Map());
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
		const { version: found, changesets } = value as Record<string, unknown>;
		if (found !== version)
			throw invalid(`its version is ${JSON.stringify(found)}, and this build of Melian reads version ${version}`);
		if (typeof changesets !== "object" || changesets === null || Array.isArray(changesets))
			throw invalid("its changesets are not an object");
		const leases = new Map<string, Lease>();
		for (const [id, record] of Object.entries(changesets)) {
			if (typeof record !== "object" || record === null) throw invalid(`the record of ${id} is not an object`);
			leases.set(id, lease((record as Record<string, unknown>).lease));
		}
		return new StateIndex(leases);
	}

	lease(changeset: string): Lease | undefined {
		return this.#leases.get(changeset);
	}

	leased(changeset: string, held: Lease): StateIndex {
		return new StateIndex(new Map([...this.#leases, [changeset, held]]));
	}

	released(changeset: string): StateIndex {
		const leases = new Map(this.#leases);
		leases.delete(changeset);
		return new StateIndex(leases);
	}

	toJSON(): { version: number; changesets: Record<string, { lease: Lease }> } {
		const changesets: Record<string, { lease: Lease }> = {};
		for (const [id, held] of [...this.#leases].sort(([a], [b]) => a.localeCompare(b)))
			changesets[id] = { lease: held };
		return { version, changesets };
	}
}
