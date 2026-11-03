import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MutationInventory } from "../packages/core/src/mutation-inventory.ts";
import { sampleMutants, survivorClasses } from "./mutant-sample.mjs";

const classes = [
	"optional-chain",
	"seeded-default",
	"nullish-logical",
	"compound-condition",
	"some-every",
	"numeric-bound",
	"dropped-value",
	"negative-test",
];
const mutant = (index, extra = {}) => ({
	file: "src/a.ts",
	line: index + 1,
	column: 0,
	endLine: index + 1,
	endColumn: 1,
	mutatorName: "ConditionalExpression",
	replacement: "true",
	claim: "killed",
	evidence: "value.test.ts > guard",
	survivorClasses: ["compound-condition"],
	...extra,
});
const inventory = (mutants, extra = {}) => ({ mutants, total: mutants.length, omitted: 0, unmutated: [], ...extra });
const lines = (result) => result.selected.map((row) => row.line);

describe("mutant sampling", () => {
	it("samples structural version-2 evidence through the compatibility entry", () => {
		const row = mutant(0, { status: "generated", evidence: { test: { file: "value.test.ts", path: ["guard"] } } });
		const classified = MutationInventory.create({
			range: { base: "a".repeat(40), head: "b".repeat(40) },
			adapters: [{ name: "typescript", version: "1", toolVersion: "10.0.0", source: "melian" }],
			installation: "c".repeat(64),
			mutants: [row],
			total: 1,
			omitted: 0,
			unmutated: [],
		});
		expect(sampleMutants(classified.toJSON())).toEqual(classified.sample());
	});
	it("keeps the checklist class names in the sampling contract", () => {
		expect(survivorClasses).toEqual(classes);
		const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
		for (const name of classes) expect(agents).toContain(`\`${name}\``);
	});

	it("selects deterministically by full identity regardless of input order", () => {
		const rows = Array.from({ length: 12 }, (_, index) => mutant(index));
		const selected = sampleMutants(inventory(rows));
		expect(sampleMutants(inventory([...rows].reverse()))).toEqual(selected);
		expect(lines(selected)).toEqual([7, 12, 11, 9]);
		expect(sampleMutants(inventory([mutant(0)]))).toEqual({
			selected: [{ ...mutant(0), sampleHash: "b4909d8c461235c8a78ce0dfbb445781394b1abfaf0b19858345fc019a01dbe8" }],
			total: 1,
			unmutated: [],
		});
	});

	it("covers every recurring survivor class present in a mixed collection", () => {
		const rows = classes.map((name, index) => mutant(index, { survivorClasses: [name] }));
		const selected = sampleMutants(inventory(rows)).selected;
		expect(new Set(selected.flatMap((row) => row.survivorClasses))).toEqual(new Set(classes));
		expect(selected).toHaveLength(classes.length);
	});

	it("covers each mutator and file, even when a common group dominates", () => {
		const rows = Array.from({ length: 30 }, (_, index) => mutant(index));
		rows.push(mutant(30, { mutatorName: "ArrayDeclaration" }), mutant(31, { file: "src/rare.ts" }));
		const selected = sampleMutants(inventory(rows)).selected;
		expect(new Set(selected.map((row) => row.mutatorName))).toEqual(
			new Set(["ConditionalExpression", "ArrayDeclaration"]),
		);
		expect(new Set(selected.map((row) => row.file))).toEqual(new Set(["src/a.ts", "src/rare.ts"]));
	});

	it.each([
		[1, 1],
		[2, 2],
		[5, 2],
		[6, 2],
		[7, 3],
		[12, 4],
		[26, 6],
	])("rounds the remaining fifth up for %i claims: %i probes", (count, probes) => {
		expect(
			sampleMutants(inventory(Array.from({ length: count }, (_, index) => mutant(index)))).selected,
		).toHaveLength(probes);
	});

	it("rounds the remaining claims separately in each changed file", () => {
		const rows = ["src/a.ts", "src/b.ts"].flatMap((file) =>
			Array.from({ length: 7 }, (_, index) => mutant(index, { file })),
		);
		const selected = sampleMutants(inventory(rows)).selected;
		expect(selected.filter((row) => row.file === "src/a.ts")).toHaveLength(3);
		expect(selected.filter((row) => row.file === "src/b.ts")).toHaveLength(3);
	});

	it.each(["new-test", "equivalent"])("probes every %s claim before sampling existing kills", (claim) => {
		const rows = Array.from({ length: 6 }, (_, index) => mutant(index));
		rows[0] = mutant(0, { claim });
		const selected = sampleMutants(inventory(rows));
		expect(lines(selected)).toEqual([2, 1]);
		expect(selected.selected.find((row) => row.line === 1).claim).toBe(claim);
	});

	it("distinguishes two mutations at the same start with different end positions", () => {
		const selected = sampleMutants(inventory([mutant(0), mutant(0, { endColumn: 5 })])).selected;
		expect(selected).toHaveLength(2);
		expect(new Set(selected.map((row) => row.sampleHash)).size).toBe(2);
	});

	it("handles an empty inventory and preserves unmutated entries", () => {
		const unmutated = [{ file: "src/link.ts", reason: "symlink" }];
		expect(sampleMutants(inventory([], { unmutated }))).toEqual({ selected: [], total: 0, unmutated });
	});

	it("accepts a claim with no recurring class", () => {
		expect(sampleMutants(inventory([mutant(0, { survivorClasses: [] })])).selected).toHaveLength(1);
	});

	it.each([
		{ endLine: undefined },
		{ endColumn: undefined },
		{ endLine: 1.5 },
		{ endColumn: NaN },
		{ endColumn: Number.MAX_SAFE_INTEGER + 1 },
	])("requires complete end coordinates: %j", (extra) => {
		expect(() => sampleMutants(inventory([mutant(0, extra)]))).toThrow("endLine and endColumn");
	});

	it.each([{ omitted: 1 }, { omitted: -1 }, { omitted: undefined }, { total: 0 }, { total: 2 }])(
		"refuses an incomplete inventory: %j",
		(extra) => {
			expect(() => sampleMutants(inventory([mutant(0)], extra))).toThrow("complete inventory");
		},
	);

	it.each([undefined, "", "unknown"])("requires a classified claim: %s", (claim) => {
		expect(() => sampleMutants(inventory([mutant(0, { claim })]))).toThrow("claim");
	});

	it.each([undefined, null, 0, 1, false, "", " "])("requires evidence for each claim: %s", (evidence) => {
		expect(() => sampleMutants(inventory([mutant(0, { evidence })]))).toThrow("evidence");
	});

	it.each([undefined, null, "numeric-bound", {}, ["unknown"], ["numeric-bound", "unknown"]])(
		"requires known survivor classes: %j",
		(survivorClasses) => {
			expect(() => sampleMutants(inventory([mutant(0, { survivorClasses })]))).toThrow("survivorClasses");
		},
	);
});
