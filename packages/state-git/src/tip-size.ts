// This module imports nothing, so a workflow script on plain Node can read a size with the store's own limits and words.

// The most bytes of records and cells a tip may hold, since a call holds them all in memory. Provisional until a read
// that does not hold the whole tip replaces it.
export const tipLimit = 256 * 1024 * 1024;

// The most entries a tip may hold, since a call holds every one, and the most bytes their listing may run to, a KiB a
// line on average, so the listing stays bounded before it is counted.
export const entryLimit = 65_536;
export const listingLimit = entryLimit * 1024;

const mib = 1024 * 1024;
const remedy =
	"The daily prune removes the records of pull requests merged or closed over 30 days ago; if it has run, open work fills the tip.";

type Counted = { readonly entries: number; readonly recordBytes: number; readonly listingBytes: number };

function grouped(value: number): string {
	return String(value).replace(/\B(?=(\d{3})+$)/g, ",");
}

function whole(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * How much the tip of `melian/state` holds against each of the store's three limits: its entries, the bytes of its
 * records and cells, and the bytes of its `git ls-tree -r -z` listing. A listing that runs past its limit is stopped
 * there, so such a tip counts neither entries nor bytes.
 */
export class TipSize {
	/** The three counts, or undefined when the listing ran past its limit. */
	readonly counted: Counted | undefined;

	private constructor(counted: Counted | undefined) {
		this.counted = counted;
	}

	static of(counted: Counted): TipSize {
		return new TipSize({
			entries: counted.entries,
			recordBytes: counted.recordBytes,
			listingBytes: counted.listingBytes,
		});
	}

	/** The size of a tip whose listing ran past its limit. */
	static unlisted(): TipSize {
		return new TipSize(undefined);
	}

	/** The size {@link TipSize.toJSON} wrote, refusing anything else: another field, or a count that is no whole number. */
	static parse(value: unknown): TipSize {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error("a tip size is a JSON object");
		const keys = Object.keys(value).sort().join(",");
		const fields = value as Record<string, unknown>;
		if (keys === "listingPastLimit" && fields.listingPastLimit === true) return TipSize.unlisted();
		if (
			keys !== "entries,listingBytes,recordBytes" ||
			!whole(fields.entries) ||
			!whole(fields.recordBytes) ||
			!whole(fields.listingBytes)
		)
			throw new Error("a tip size holds entries, recordBytes and listingBytes, each a whole number");
		return TipSize.of({
			entries: fields.entries,
			recordBytes: fields.recordBytes,
			listingBytes: fields.listingBytes,
		});
	}

	toJSON(): Counted | { readonly listingPastLimit: true } {
		return this.counted ?? { listingPastLimit: true };
	}

	/** One line giving each count beside its limit, as `melian doctor` prints it. */
	line(): string {
		const counted = this.counted;
		if (counted === undefined)
			return `melian/state: listing more than ${listingLimit / mib} MiB of ${listingLimit / mib} MiB, so its entries and bytes are not counted`;
		return `melian/state: ${grouped(counted.entries)} of ${grouped(entryLimit)} entries, ${Math.floor(counted.recordBytes / mib)} MiB of ${tipLimit / mib} MiB, listing ${Math.floor(counted.listingBytes / mib)} MiB of ${listingLimit / mib} MiB`;
	}

	/** A warning naming each count past half its limit, or past the limit itself, or undefined when none is. */
	warning(): string | undefined {
		const counted = this.counted;
		const clauses =
			counted === undefined
				? [`past its listing limit: more than ${grouped(listingLimit)} bytes`]
				: [
						clause("entry", counted.entries, entryLimit, ""),
						clause("record byte", counted.recordBytes, tipLimit, " bytes"),
						clause("listing", counted.listingBytes, listingLimit, " bytes"),
					].filter((each) => each !== undefined);
		return clauses.length === 0 ? undefined : `melian/state is ${clauses.join("; ")}. ${remedy}`;
	}
}

function clause(name: string, value: number, limit: number, unit: string): string | undefined {
	if (value * 2 <= limit) return undefined;
	return `past ${value > limit ? "" : "half "}its ${name} limit: ${grouped(value)} of ${grouped(limit)}${unit}`;
}
