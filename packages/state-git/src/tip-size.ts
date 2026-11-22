// This module imports nothing, so a workflow script on plain Node can read a size with the store's own limits and words.

// The most bytes of records and cells a tip may hold, since a call holds them all in memory. Provisional until a read
// that does not hold the whole tip replaces it.
export const tipLimit = 256 * 1024 * 1024;

// The most entries a tip may hold, since a call holds every one, and the most bytes their listing may run to, a KiB a
// line on average, so the listing stays bounded before it is counted.
export const entryLimit = 65_536;
export const listingLimit = entryLimit * 1024;

const mib = 1024 * 1024;
// Names no prune until pull request C of issue 617 adds one, so the warning never names a remedy that does not exist.
const remedy =
	"Nothing removes records from melian/state yet; https://github.com/melian-agent/melian/issues/617 adds the prune.";

type Counted = { readonly entries: number; readonly recordBytes: number; readonly listingBytes: number };
// A tip past the entry limit, which a read refuses before it reads a blob, so its record bytes are not counted.
type PastEntryLimit = { readonly entries: number; readonly listingBytes: number };

function grouped(value: number): string {
	return String(value).replace(/\B(?=(\d{3})+$)/g, ",");
}

function whole(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

// Whole MiB rounded down, or "over" the limit past it, so a count past its limit never prints as at it.
function mibOf(value: number, limit: number): string {
	return value > limit ? `over ${limit / mib}` : `${Math.floor(value / mib)}`;
}

/**
 * How much the tip of `melian/state` holds against each of the store's three limits: its entries, the bytes of its
 * records and cells, and the bytes of its `git ls-tree -r -z` listing. A listing that runs past its limit is stopped
 * there, so such a tip counts neither entries nor bytes; a tip past its entry limit counts no record bytes, since a read
 * refuses it before it reads a blob.
 */
export class TipSize {
	/** The counts, without record bytes past the entry limit, or undefined when the listing ran past its limit. */
	readonly counted: Counted | PastEntryLimit | undefined;

	private constructor(counted: Counted | PastEntryLimit | undefined) {
		this.counted = counted;
	}

	static of(counted: Counted): TipSize {
		return new TipSize({
			entries: counted.entries,
			recordBytes: counted.recordBytes,
			listingBytes: counted.listingBytes,
		});
	}

	/** The size of a tip past its entry limit, whose record bytes a read never reaches and so are not counted. */
	static pastEntryLimit(counted: PastEntryLimit): TipSize {
		if (!whole(counted.entries) || counted.entries <= entryLimit || !whole(counted.listingBytes))
			throw new Error(
				"a tip past its entry limit holds more than 65,536 entries and a whole number of listing bytes",
			);
		return new TipSize({ entries: counted.entries, listingBytes: counted.listingBytes });
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
		if (keys === "entries,listingBytes")
			return TipSize.pastEntryLimit({
				entries: fields.entries as number,
				listingBytes: fields.listingBytes as number,
			});
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

	toJSON(): Counted | PastEntryLimit | { readonly listingPastLimit: true } {
		return this.counted ?? { listingPastLimit: true };
	}

	/** One line giving each count beside its limit, as `melian doctor` prints it. */
	line(): string {
		const counted = this.counted;
		if (counted === undefined)
			return `melian/state: listing more than ${listingLimit / mib} MiB of ${listingLimit / mib} MiB, so its entries and bytes are not counted`;
		const records =
			"recordBytes" in counted
				? `${mibOf(counted.recordBytes, tipLimit)} MiB of ${tipLimit / mib} MiB`
				: "record bytes not counted past the entry limit";
		return `melian/state: ${grouped(counted.entries)} of ${grouped(entryLimit)} entries, ${records}, listing ${mibOf(counted.listingBytes, listingLimit)} MiB of ${listingLimit / mib} MiB`;
	}

	/** A warning naming each count past half its limit, or past the limit itself, or undefined when none is. */
	warning(): string | undefined {
		const counted = this.counted;
		if (counted === undefined)
			return `melian/state's listing was too large to read, past ${grouped(listingLimit)} bytes, so the store is past its listing limit. ${remedy}`;
		const counts = "recordBytes" in counted;
		const clauses = [
			clause("entry", counted.entries, entryLimit, ""),
			counts ? clause("record byte", counted.recordBytes, tipLimit, " bytes") : undefined,
			clause("listing", counted.listingBytes, listingLimit, " bytes"),
		].filter((each) => each !== undefined);
		if (clauses.length === 0) return undefined;
		const uncounted = counts ? "" : " Its record bytes are not counted past the entry limit.";
		return `melian/state is ${clauses.join("; ")}.${uncounted} ${remedy}`;
	}
}

function clause(name: string, value: number, limit: number, unit: string): string | undefined {
	if (value * 2 <= limit) return undefined;
	return `past ${value > limit ? "" : "half "}its ${name} limit: ${grouped(value)} of ${grouped(limit)}${unit}`;
}
