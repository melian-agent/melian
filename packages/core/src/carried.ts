/** The prefix the coverage ledger's carry stores a copied lens sighting's check under, as `carried/lens.correctness`. */
export const carriedCheckPrefix = "carried/";

/**
 * The check a producer reports for: a carried lens sighting's lens, since the carry copies the lens's own claim, and
 * every other check as it is.
 */
export function reportingCheck(check: string): string {
	return check.startsWith(carriedCheckPrefix) ? check.slice(carriedCheckPrefix.length) : check;
}
