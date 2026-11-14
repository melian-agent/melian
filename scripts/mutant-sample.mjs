import { MutationInventory, survivorClasses } from "../packages/core/src/mutation-inventory.ts";

export { survivorClasses };

// `suites` is a SuiteExports read from the checkout; a suite claim stands only in a package's ./testing export.
export function sampleMutants(inventory, suites) {
	if (inventory.melianMutants === 2) return MutationInventory.parse(inventory).sample(suites);
	if (inventory.omitted !== 0 || inventory.total !== inventory.mutants.length)
		throw new Error("sampling requires a complete inventory with no omitted mutants");
	for (const row of inventory.mutants) {
		if (!["killed", "new-test", "equivalent", "suite"].includes(row.claim))
			throw new Error("each mutant needs a claim: killed, new-test, equivalent or suite");
		if (typeof row.evidence !== "string" || row.evidence.trim().length === 0)
			throw new Error("each claim needs evidence: a named test, or a reason for an equivalent or suite claim");
		if (!Array.isArray(row.survivorClasses) || row.survivorClasses.some((name) => !survivorClasses.includes(name)))
			throw new Error("survivorClasses must list known checklist class names");
		if (!Number.isSafeInteger(row.endLine) || !Number.isSafeInteger(row.endColumn))
			throw new Error("each claim needs endLine and endColumn from a fresh inventory");
	}
	return MutationInventory.parse(inventory).sample(suites);
}
