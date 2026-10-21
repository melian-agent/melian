import { createHash } from "node:crypto";

export const survivorClasses = [
	"optional-chain",
	"seeded-default",
	"nullish-logical",
	"compound-condition",
	"some-every",
	"numeric-bound",
	"dropped-value",
	"negative-test",
];

export function sampleMutants(inventory) {
	if (inventory.omitted !== 0 || inventory.total !== inventory.mutants.length)
		throw new Error("sampling requires a complete inventory with no omitted mutants");
	for (const row of inventory.mutants) {
		if (!["killed", "new-test", "equivalent"].includes(row.claim))
			throw new Error("each mutant needs a claim: killed, new-test or equivalent");
		if (typeof row.evidence !== "string" || row.evidence.trim().length === 0)
			throw new Error("each claim needs evidence: a named test or an equivalence reason");
		if (!Array.isArray(row.survivorClasses) || row.survivorClasses.some((name) => !survivorClasses.includes(name)))
			throw new Error("survivorClasses must list known checklist class names");
		if (!Number.isSafeInteger(row.endLine) || !Number.isSafeInteger(row.endColumn))
			throw new Error("each claim needs endLine and endColumn from a fresh inventory");
	}
	const ranked = inventory.mutants
		.map((mutant) => ({
			mutant,
			hash: createHash("sha256")
				.update(
					JSON.stringify([
						mutant.file,
						mutant.line,
						mutant.column,
						mutant.endLine,
						mutant.endColumn,
						mutant.mutatorName,
						mutant.replacement,
					]),
				)
				.digest("hex"),
		}))
		.sort((a, b) => a.hash.localeCompare(b.hash));
	const selected = new Set(ranked.filter((row) => row.mutant.claim !== "killed"));
	const classGroups = Map.groupBy(
		ranked.flatMap((row) => row.mutant.survivorClasses.map((name) => ({ name, row }))),
		(member) => member.name,
	);
	const groups = [
		...Map.groupBy(ranked, (row) => row.mutant.file).values(),
		...Map.groupBy(ranked, (row) => row.mutant.mutatorName).values(),
		...[...classGroups.values()].map((group) => group.map((member) => member.row)),
	];
	for (const group of groups) if (group.every((row) => !selected.has(row))) selected.add(group[0]);
	const remaining = Map.groupBy(
		ranked.filter((row) => !selected.has(row)),
		(row) => row.mutant.file,
	);
	for (const group of remaining.values())
		for (const row of group.slice(0, Math.ceil(group.length / 5))) selected.add(row);
	return {
		selected: ranked.filter((row) => selected.has(row)).map((row) => ({ ...row.mutant, sampleHash: row.hash })),
		total: inventory.total,
		unmutated: inventory.unmutated,
	};
}
