import { describe, expect, it } from "vitest";
import {
	MutationInventory,
	MutationInventoryError,
	type MutationInventoryInput,
	survivorClasses,
} from "../src/mutation-inventory.ts";

const identity = (index = 0, extra = {}) => ({
	file: "src/a.ts",
	line: index + 1,
	column: 0,
	endLine: index + 1,
	endColumn: 1,
	mutatorName: "ConditionalExpression",
	replacement: "true",
	...extra,
});
const row = (index = 0, extra = {}) => ({
	...identity(index),
	status: "generated" as const,
	claim: "killed" as const,
	evidence: { test: { file: "test/value.test.ts", path: ["value", "guard"] } },
	survivorClasses: ["compound-condition" as const],
	...extra,
});
const fields = (mutants = [row()], extra = {}) => ({
	range: { base: "a".repeat(40), head: "b".repeat(40), target: "https://github.com/example/repo/pull/1" },
	adapters: [
		{ name: "typescript", version: "1", toolVersion: "stryker-instrumenter@10.0.0", source: "checkout" as const },
	],
	installation: "c".repeat(64),
	mutants,
	total: mutants.length,
	omitted: 0,
	unmutated: [{ file: "src/link.ts", reason: "symlink" }],
	...extra,
});
const legacy = (mutants = [row()], extra = {}) => ({
	mutants: mutants.map(({ status: _status, evidence: _evidence, ...mutant }) => ({
		...mutant,
		evidence: "value.test.ts > guard",
	})),
	total: mutants.length,
	omitted: 0,
	unmutated: [],
	...extra,
});
const lines = (inventory: MutationInventory) => inventory.sample().selected.map((mutant) => mutant.line);

function codeOf(input: unknown) {
	try {
		MutationInventory.parse(input);
	} catch (error) {
		expect(error).toBeInstanceOf(MutationInventoryError);
		return (error as MutationInventoryError).code;
	}
	throw new Error("expected inventory refusal");
}

describe("MutationInventory", () => {
	it.each([
		"/tmp/a.ts",
		"../a.ts",
		"src/../a.ts",
		"src\\a.ts",
		"./src/a.ts",
		"src//a.ts",
		"src/a.ts/",
		"C:/a.ts",
		"c:a.ts",
		"src/a\0.ts",
		"src/\ud800.ts",
	])("refuses noncanonical production and test paths: %j", (file) => {
		expect(() => MutationInventory.create(fields([row(0, { file })]))).toThrow(MutationInventoryError);
		expect(() =>
			MutationInventory.create(fields([row(0, { evidence: { test: { file, path: ["guard"] } } })])),
		).toThrow(MutationInventoryError);
	});

	it("requires adapter provenance for nonempty inventories and accepts empty enumeration", () => {
		expect(() => MutationInventory.create(fields([row()], { adapters: [] }))).toThrow("adapter");
		expect(MutationInventory.create(fields([], { adapters: [] })).toJSON().adapters).toEqual([]);
	});

	it.each(["../outside.ts", "/tmp/outside.ts"])("refuses unsafe set-aside file paths: %j", (file) => {
		expect(() => MutationInventory.create(fields([], { unmutated: [{ file, reason: "symlink" }] }))).toThrow(
			MutationInventoryError,
		);
	});

	it("preserves canonical Unicode and colon-containing paths", () => {
		const file = "src/A:naïve.ts";
		const input = fields([row(0, { file, evidence: { test: { file: "1:test.ts", path: ["guard"] } } })]);
		const stored = MutationInventory.create(input).toJSON();
		expect(stored.mutants[0].file).toBe(file);
		expect(stored.mutants[0].evidence).toEqual(input.mutants[0].evidence);
	});

	it("preserves historical path spellings during legacy sampling", () => {
		const input = legacy([row(0, { file: "./src/a.ts" })]);
		expect(MutationInventory.parse(input).sample().selected[0].file).toBe("./src/a.ts");
	});

	it.each([
		{ installation: "a" },
		{ installation: "g".repeat(64) },
		{ range: { ...fields().range, base: "a".repeat(39) } },
		{ range: { ...fields().range, base: "a".repeat(41) } },
		{ range: { ...fields().range, head: "a".repeat(63) } },
		{ range: { ...fields().range, head: "a".repeat(65) } },
		{ range: { ...fields().range, head: "g".repeat(40) } },
	])("refuses malformed provenance %j", (extra) => {
		expect(() => MutationInventory.create(fields([row()], extra))).toThrow(MutationInventoryError);
	});

	it("accepts both commit hash lengths and owns verification outputs", () => {
		const inventory = MutationInventory.create(
			fields([row()], { range: { base: "a".repeat(64), head: "b".repeat(64) } }),
		);
		const expected = inventory.toJSON();
		const output = inventory.forVerification();
		output.mutants[0].file = "changed.ts";
		expect(inventory.toJSON()).toEqual(expected);
	});

	it.each([undefined, null, "other"])("requires an adapter installation source: %s", (source) => {
		expect(() =>
			MutationInventory.create(fields([row()], { adapters: [{ ...fields().adapters[0], source }] })),
		).toThrow(MutationInventoryError);
	});

	it("accepts distinct adapters while preserving every identity", () => {
		const adapters = [
			fields().adapters[0],
			{ name: "rust", version: "2", toolVersion: "cargo-mutants@1", source: "melian" as const },
		];
		expect(MutationInventory.create(fields([row()], { adapters })).toJSON().adapters).toEqual(adapters);
	});

	it.each([null, { ...fields(), mutants: null }, { ...fields(), mutants: [null] }])(
		"refuses malformed factory inputs before deriving ids: %j",
		(input) => {
			expect(() => MutationInventory.create(input as unknown as MutationInventoryInput)).toThrow(
				MutationInventoryError,
			);
		},
	);

	it("samples a rare mutator even when every row shares one survivor class", () => {
		const rows = Array.from({ length: 30 }, (_, index) => row(index));
		rows.push(row(30, { mutatorName: "ArrayDeclaration" }));
		expect(
			new Set(
				MutationInventory.create(fields(rows))
					.sample()
					.selected.map((mutant) => mutant.mutatorName),
			),
		).toEqual(new Set(["ConditionalExpression", "ArrayDeclaration"]));
	});

	it("refuses an unclassified legacy row even when evidence and classes are present", () => {
		const input = legacy();
		const inventory = MutationInventory.parse({ ...input, mutants: [{ ...input.mutants[0], claim: undefined }] });
		try {
			inventory.sample();
			expect.fail("unclassified claim was sampled");
		} catch (error) {
			expect(error).toBeInstanceOf(MutationInventoryError);
			expect((error as MutationInventoryError).code).toBe("unclassifiedClaim");
		}
	});

	it("pins the seven-field identity hash and includes end coordinates", () => {
		const stored = MutationInventory.create(fields()).toJSON();
		expect(stored.mutants[0].id).toBe("b4909d8c461235c8a78ce0dfbb445781394b1abfaf0b19858345fc019a01dbe8");
		const other = MutationInventory.create(fields([row(0, { endColumn: 5 })])).toJSON();
		expect(other.mutants[0].id).not.toBe(stored.mutants[0].id);
		expect(MutationInventory.parse(stored).toJSON()).toEqual(stored);
	});

	it("owns its inputs and outputs, including nested test paths", () => {
		const input = fields();
		const inventory = MutationInventory.create(input);
		const expected = inventory.toJSON();
		input.mutants[0].evidence.test.path.push("changed");
		const parsedInput = inventory.toJSON();
		const parsed = MutationInventory.parse(parsedInput);
		parsedInput.mutants[0].file = "changed.ts";
		const output = parsed.toJSON();
		output.mutants[0].file = "changed-again.ts";
		const sample = parsed.sample();
		sample.selected[0].survivorClasses?.push("numeric-bound");
		expect(inventory.toJSON()).toEqual(expected);
		expect(parsed.toJSON()).toEqual(expected);
	});

	it("keeps unclassified enumeration rows, ignored policy reasons and set-aside files", () => {
		const input = fields([
			row(0, { claim: undefined, evidence: undefined, survivorClasses: undefined }),
			row(1, { status: "ignored", ignoredBy: "config", statusReason: "policy" }),
			row(2, { status: "ignored", ignoredBy: "comment", statusReason: "policy" }),
		]);
		const inventory = MutationInventory.create(input);
		expect(inventory.toJSON()).toEqual({
			melianMutants: 2,
			...input,
			mutants: input.mutants.map((mutant, index) => ({ ...mutant, id: inventory.toJSON().mutants[index].id })),
		});
		expect(() => inventory.sample()).toThrow("claim");
	});

	it("accepts a listed inventory with omissions, but never samples or verifies it", () => {
		const inventory = MutationInventory.create(fields([row()], { total: 2, omitted: 1 }));
		expect(() => inventory.sample()).toThrow("complete inventory");
		expect(() => inventory.forVerification()).toThrow("complete inventory");
	});

	it.each([undefined, 1])("accepts legacy version %s for sampling and refuses it for verification", (version) => {
		const input = legacy(
			Array.from({ length: 12 }, (_, index) => row(index)),
			{ melianMutants: version },
		);
		const inventory = MutationInventory.parse(input);
		expect(lines(inventory)).toEqual([7, 12, 11, 9]);
		expect(inventory.toJSON()).toEqual(input);
		expect(() => inventory.forVerification()).toThrow(/enumerate again/);
		try {
			inventory.forVerification();
		} catch (error) {
			expect((error as MutationInventoryError).code).toBe("legacyInventory");
		}
	});

	it("returns structural claims for future verification and refuses missing classifications", () => {
		const input = fields([
			row(),
			row(1, { claim: "new-test" }),
			row(2, { claim: "equivalent", evidence: { reason: "unreachable branch" } }),
		]);
		const inventory = MutationInventory.create(input);
		expect(inventory.forVerification()).toEqual(inventory.toJSON());
		expect(() =>
			MutationInventory.create(fields([row(0, { claim: undefined, evidence: undefined })])).forVerification(),
		).toThrow("claim");
	});

	it("rejects duplicate identities, inconsistent ids and unsupported versions", () => {
		expect(() => MutationInventory.create(fields([row(), row()]))).toThrow("duplicate");
		const stored = MutationInventory.create(fields()).toJSON();
		expect(codeOf({ ...stored, mutants: [{ ...stored.mutants[0], id: "0".repeat(64) }] })).toBe("invalidIdentity");
		expect(codeOf({ ...stored, melianMutants: 3 })).toBe("unsupportedVersion");
		expect(codeOf({ ...stored, mutants: [{ ...stored.mutants[0], id: undefined }] })).toBe("invalidInventory");
	});

	it.each([
		{ line: 0 },
		{ column: -1 },
		{ endLine: 0 },
		{ endColumn: -1 },
		{ line: 1.5 },
		{ column: Number.MAX_SAFE_INTEGER + 1 },
		{ endLine: undefined },
		{ endColumn: undefined },
		{ endLine: NaN },
		{ endColumn: Infinity },
		{ line: 2 },
		{ column: 2 },
	])("refuses invalid coordinates %j", (extra) => {
		expect(() => MutationInventory.create(fields([row(0, extra)]))).toThrow(MutationInventoryError);
	});

	it("accepts coordinate bounds and multiline spans", () => {
		expect(MutationInventory.create(fields([row(0, { column: 0, endColumn: 0 })])).toJSON().mutants[0].column).toBe(
			0,
		);
		expect(
			MutationInventory.create(fields([row(0, { column: 10, endLine: 2, endColumn: 0 })])).toJSON().mutants[0]
				.endLine,
		).toBe(2);
		expect(
			MutationInventory.create(fields([row(0, { endColumn: Number.MAX_SAFE_INTEGER })])).toJSON().mutants[0]
				.endColumn,
		).toBe(Number.MAX_SAFE_INTEGER);
	});

	it.each([
		{ total: -1 },
		{ omitted: -1 },
		{ omitted: undefined },
		{ total: 0 },
		{ total: 2 },
		{ total: 1.5 },
		{ omitted: Number.MAX_SAFE_INTEGER + 1 },
	])("refuses invalid legacy counts %j", (extra) => {
		expect(() => MutationInventory.parse(legacy([row()], extra))).toThrow(MutationInventoryError);
	});

	it.each([
		{ claim: "unknown" },
		{ claim: "" },
		{ evidence: "test > case" },
		{ evidence: { reason: "reason for a killed claim" } },
		{ evidence: { test: { file: "test.ts", path: [] } } },
		{ evidence: { test: { file: "test.ts", path: [" "] } } },
		{ evidence: { test: { file: "", path: ["case"] } } },
		{ evidence: undefined },
		{ survivorClasses: ["unknown"] },
		{ survivorClasses: undefined },
		{ claim: "equivalent", evidence: { reason: " " } },
		{ claim: "equivalent", evidence: { test: { file: "test.ts", path: ["case"] } } },
		{ status: "ignored" },
		{ status: "generated", ignoredBy: "config" },
		{ status: "ignored", ignoredBy: "other" },
		{ status: "survived" },
	])("refuses invalid v2 row metadata %j", (extra) => {
		expect(() => MutationInventory.create(fields([row(0, extra)]))).toThrow(MutationInventoryError);
	});

	it.each([undefined, null, "", " ", false, {}])("refuses missing legacy evidence %j", (evidence) => {
		const input = legacy();
		expect(() =>
			MutationInventory.parse({ ...input, mutants: [{ ...input.mutants[0], evidence }] }).sample(),
		).toThrow(MutationInventoryError);
	});

	it("refuses evidence without a claim, missing legacy classes, and duplicate adapters", () => {
		expect(() => MutationInventory.create(fields([row(0, { claim: undefined })]))).toThrow("evidence");
		const input = legacy();
		expect(() =>
			MutationInventory.parse({ ...input, mutants: [{ ...input.mutants[0], survivorClasses: undefined }] }).sample(),
		).toThrow("survivorClasses");
		expect(() =>
			MutationInventory.create(fields([row()], { adapters: [fields().adapters[0], fields().adapters[0]] })),
		).toThrow("duplicate adapter");
	});

	it.each([null, 1, "inventory", [], { melianMutants: 2 }])(
		"refuses malformed documents %j with a typed error",
		(input) => {
			expect(codeOf(input)).toBe("invalidInventory");
		},
	);

	it("reserves verification records for the implementation that can validate whole batches", () => {
		const input = MutationInventory.create(fields()).toJSON();
		expect(codeOf({ ...input, mutants: [{ ...input.mutants[0], verification: { outcome: "killed" } }] })).toBe(
			"invalidInventory",
		);
	});

	it("allows empty replacements and claims with no recurring class", () => {
		const inventory = MutationInventory.create(fields([row(0, { replacement: "", survivorClasses: [] })]));
		expect(inventory.sample().selected[0].replacement).toBe("");
		expect(inventory.sample().selected[0].survivorClasses).toEqual([]);
	});

	it("keeps test component identity without flattening ambiguous names", () => {
		const input = fields([
			row(0, { evidence: { test: { file: "test.ts", path: ["suite", "works"] } } }),
			row(1, { evidence: { test: { file: "test.ts", path: ["suite works"] } } }),
		]);
		expect(
			MutationInventory.create(input)
				.forVerification()
				.mutants.map((mutant) => mutant.evidence),
		).toEqual(input.mutants.map((mutant) => mutant.evidence));
	});

	it("renders ids, ignored provenance, escaped text, omissions and unmutated files", () => {
		const inventory = MutationInventory.create(
			fields(
				[row(0, { status: "ignored", ignoredBy: "comment", statusReason: "config\ntext", replacement: "a\tb" })],
				{ total: 2, omitted: 1 },
			),
		);
		const stored = inventory.toJSON();
		expect(inventory.renderTable()).toBe(
			[
				"ID\tFILE\tLINE\tCOLUMN\tEND_LINE\tEND_COLUMN\tMUTATOR\tREPLACEMENT\tPOLICY",
				`${stored.mutants[0].id}\t"src/a.ts"\t1\t0\t1\t1\tConditionalExpression\t"a\\tb"\t{"status":"ignored","ignoredBy":"comment","statusReason":"config\\ntext"}`,
				'UNMUTATED\t"src/link.ts"\t"symlink"',
				"",
				"1 of 2 mutants; 1 omitted",
			].join("\n"),
		);
	});
});

describe("inventory sampling", () => {
	it("matches the old script's exact hash, ordering and grouping contract", () => {
		const rows = Array.from({ length: 12 }, (_, index) => row(index));
		expect(lines(MutationInventory.create(fields(rows)))).toEqual([7, 12, 11, 9]);
		expect(MutationInventory.create(fields([...rows].reverse())).sample()).toEqual(
			MutationInventory.create(fields(rows)).sample(),
		);
		expect(MutationInventory.parse(legacy()).sample()).toEqual({
			selected: [
				{ ...legacy().mutants[0], sampleHash: "b4909d8c461235c8a78ce0dfbb445781394b1abfaf0b19858345fc019a01dbe8" },
			],
			total: 1,
			unmutated: [],
		});
	});

	it.each([
		[1, 1],
		[2, 2],
		[5, 2],
		[6, 2],
		[7, 3],
		[12, 4],
		[26, 6],
	])("rounds the remaining fifth up for %i rows to %i probes", (count, probes) => {
		expect(
			MutationInventory.create(fields(Array.from({ length: count }, (_, index) => row(index)))).sample().selected,
		).toHaveLength(probes);
	});

	it("covers each represented class, mutator and file", () => {
		const rows = survivorClasses.map((name, index) => row(index, { survivorClasses: [name] }));
		rows.push(row(20, { file: "src/rare.ts", mutatorName: "ArrayDeclaration" }));
		const selected = MutationInventory.create(fields(rows)).sample().selected;
		expect(new Set(selected.flatMap((mutant) => mutant.survivorClasses ?? []))).toEqual(new Set(survivorClasses));
		expect(new Set(selected.map((mutant) => mutant.file))).toEqual(new Set(["src/a.ts", "src/rare.ts"]));
		expect(new Set(selected.map((mutant) => mutant.mutatorName))).toEqual(
			new Set(["ConditionalExpression", "ArrayDeclaration"]),
		);
	});

	it.each(["new-test", "equivalent"])("includes every %s claim before sampling killed claims", (claim) => {
		const rows = Array.from({ length: 6 }, (_, index) => row(index));
		rows[0] = row(0, claim === "equivalent" ? { claim, evidence: { reason: "same behaviour" } } : { claim });
		expect(lines(MutationInventory.create(fields(rows)))).toEqual([2, 1]);
	});

	it("rounds independently for each file and handles empty inventories", () => {
		const rows = ["src/a.ts", "src/b.ts"].flatMap((file) =>
			Array.from({ length: 7 }, (_, index) => row(index, { file })),
		);
		const selected = MutationInventory.create(fields(rows)).sample().selected;
		expect(selected.filter((mutant) => mutant.file === "src/a.ts")).toHaveLength(3);
		expect(selected.filter((mutant) => mutant.file === "src/b.ts")).toHaveLength(3);
		expect(MutationInventory.create(fields([])).sample()).toEqual({
			selected: [],
			total: 0,
			unmutated: fields().unmutated,
		});
	});
});
