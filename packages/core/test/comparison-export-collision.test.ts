import { Comparison, ComparisonExport } from "@melian-agent/core";
import { expect, it } from "vitest";

const changeset = "range-1111111111111111";
const comparison = Comparison.of({ base: "a".repeat(40), head: "b".repeat(40) });
const key = `${comparison.base}..${comparison.head}`;
const entry = { changeset, comparison, unattributed: key };

it.each([1, 2])("keeps the revision-keyed JSON byte shape for %i identical entries from the same store", (count) => {
	expect(
		new ComparisonExport(
			Array.from({ length: count }, () => entry),
			"range",
		).renderJson(),
	).toBe(`${JSON.stringify({ comparisons: {}, unattributed: { [key]: comparison.toJSON() } }, null, 2)}\n`);
});
it("exports different unattributed revision keys from different stores without a collision", () => {
	const other = Comparison.of({ base: comparison.base, head: "c".repeat(40) });
	const otherKey = `${other.base}..${other.head}`;
	const record = new ComparisonExport(
		[entry, { changeset: "range-2222222222222222", comparison: other, unattributed: otherKey }],
		"#7",
	);
	expect(JSON.parse(record.renderJson())).toEqual({
		comparisons: {},
		unattributed: { [key]: comparison.toJSON(), [otherKey]: other.toJSON() },
	});
});
it("keeps attributed and raw unattributed entries in their existing separate JSON maps", () => {
	const round = "range-2222222222222222.r1";
	const attributed = { changeset: "range-2222222222222222", comparison, round };
	const otherRound = "range-3333333333333333.r1";
	const other = { changeset: "range-3333333333333333", comparison, round: otherRound };
	for (const entries of [
		[entry, attributed, other],
		[attributed, entry, other],
	]) {
		expect(JSON.parse(new ComparisonExport(entries, "#7").renderJson())).toEqual({
			comparisons: { [round]: comparison.toJSON(), [otherRound]: comparison.toJSON() },
			unattributed: { [key]: comparison.toJSON() },
		});
	}
});
