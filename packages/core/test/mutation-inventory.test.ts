import { describe, expect, it } from "vitest";
import {
	MutationInventory,
	MutationInventoryError,
	type MutationInventoryInput,
	type MutationInventoryRowInput,
	survivorClasses,
} from "../src/mutation-inventory.ts";

const terminalControls = [
	...Array.from({ length: 32 }, (_, index) => index),
	...Array.from({ length: 33 }, (_, index) => index + 0x7f),
	0x61c,
	0x200e,
	0x200f,
	0x2028,
	0x2029,
	...Array.from({ length: 5 }, (_, index) => index + 0x202a),
	...Array.from({ length: 4 }, (_, index) => index + 0x2066),
];

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
const fields = (mutants: MutationInventoryRowInput[] = [row()], extra = {}) => ({
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

	it("keeps unclassified config and comment rows as owned full-row v2 notes", () => {
		const input = fields([
			{ ...identity(0), status: "ignored", ignoredBy: "config", statusReason: "policy" },
			{ ...identity(1), status: "ignored", ignoredBy: "comment", statusReason: "head disable" },
		]);
		const inventory = MutationInventory.create(input);
		const stored = inventory.toJSON();
		expect(stored).toEqual({
			melianMutants: 2,
			...input,
			mutants: input.mutants.map((r, index) => ({ ...r, id: stored.mutants[index].id })),
		});
		const expected = {
			selected: [],
			total: 2,
			unmutated: stored.unmutated,
			ignored: { config: [stored.mutants[0]], comment: [stored.mutants[1]] },
		};
		expect(() => inventory.sample()).not.toThrow();
		expect(inventory.sample()).toEqual(expected);
		expect(() => inventory.forVerification()).not.toThrow();
		expect(inventory.forVerification()).toEqual(stored);
		expect(inventory.toJSON()).toEqual(stored);
		const sample = inventory.sample();
		expect(sample).toHaveProperty("ignored");
		if (sample.ignored === undefined) throw new Error("missing notes");
		sample.ignored.config[0].statusReason = "changed";
		sample.ignored.comment[0].statusReason = "changed";
		expect(inventory.sample()).toEqual(expected);
	});

	it.each(["killed", "new-test", "equivalent"] as const)(
		"excludes every classified ignored %s row from mandatory groups and remaining quotas",
		(claim) => {
			const generated = Array.from({ length: 12 }, (_, index) => row(index));
			generated.push(
				row(12, { file: "src/b.ts", mutatorName: "ArrayDeclaration", survivorClasses: ["some-every"] }),
			);
			const ignored = ["config", "comment"].flatMap((ignoredBy, index) => [
				row(30 + index, {
					status: "ignored",
					ignoredBy,
					claim,
					evidence: claim === "equivalent" ? { reason: "optional reason" } : row().evidence,
				}),
				row(40 + index, {
					status: "ignored",
					ignoredBy,
					claim,
					file: "src/ignored.ts",
					mutatorName: "IgnoredOnly",
					survivorClasses: ["negative-test"],
					evidence: claim === "equivalent" ? { reason: "optional reason" } : row().evidence,
				}),
			]);
			const inventory = MutationInventory.create(fields([...generated, ...ignored]));
			const stored = inventory.toJSON();
			const notes = {
				config: stored.mutants.filter((r) => r.ignoredBy === "config"),
				comment: stored.mutants.filter((r) => r.ignoredBy === "comment"),
			};
			const expected = {
				...MutationInventory.create(fields(generated)).sample(),
				total: stored.total,
				ignored: notes,
			};
			expect(inventory.sample()).toEqual(expected);
			const sample = inventory.sample();
			if (sample.ignored === undefined) throw new Error("missing notes");
			const config = sample.ignored.config;
			config[0].survivorClasses?.push("numeric-bound");
			if (config[0].evidence && "test" in config[0].evidence) config[0].evidence.test.path.push("changed");
			if (config[0].evidence && "reason" in config[0].evidence) config[0].evidence.reason = "changed";
			expect(inventory.sample()).toEqual(expected);
			expect(inventory.toJSON()).toEqual(stored);
		},
	);

	it.each([
		[5, 2],
		[6, 3],
	])("samples %i remaining generated rows with mixed ignored rows: %i probes", (remaining, probes) => {
		const generated = Array.from({ length: remaining + 1 }, (_, index) => row(index));
		const ignored = Array.from({ length: 9 }, (_, index) =>
			row(index + 50, {
				status: "ignored",
				ignoredBy: index % 2 === 0 ? "config" : "comment",
			}),
		);
		const inventory = MutationInventory.create(fields([...ignored, ...generated]));
		const sample = inventory.sample();
		expect(sample.selected).toHaveLength(probes);
		expect(sample.selected).toEqual(MutationInventory.create(fields(generated)).sample().selected);
		expect(sample.total).toBe(generated.length + ignored.length);
	});

	it("does not let ignored-only groups satisfy generated file, mutator or class groups", () => {
		const generated = [
			row(0),
			row(1, { file: "src/rare.ts" }),
			row(2, { mutatorName: "ArrayDeclaration" }),
			row(3, { survivorClasses: ["some-every"] }),
		];
		const ignored = generated.map((r, index) => ({
			...r,
			line: index + 40,
			endLine: index + 40,
			status: "ignored" as const,
			ignoredBy: "comment" as const,
			claim: "new-test" as const,
		}));
		expect(MutationInventory.create(fields([...ignored, ...generated])).sample().selected).toEqual(
			MutationInventory.create(fields(generated)).sample().selected,
		);
	});

	it("always includes empty ignored groups in v2 samples", () => {
		expect(MutationInventory.create(fields([], { adapters: [] })).sample()).toEqual({
			selected: [],
			total: 0,
			unmutated: fields().unmutated,
			ignored: { config: [], comment: [] },
		});
		expect(MutationInventory.create(fields()).sample()).toEqual({
			selected: [
				{
					...MutationInventory.create(fields()).toJSON().mutants[0],
					sampleHash: "b4909d8c461235c8a78ce0dfbb445781394b1abfaf0b19858345fc019a01dbe8",
				},
			],
			total: 1,
			unmutated: fields().unmutated,
			ignored: { config: [], comment: [] },
		});
	});

	it.each([undefined, 1])(
		"keeps exact v1 selection and output for ignored-like labels at version %s",
		(melianMutants) => {
			const input = legacy(
				Array.from({ length: 12 }, (_, index) => row(index)),
				{ melianMutants },
			);
			const labelled = {
				...input,
				mutants: input.mutants.map((r, index) => ({
					...r,
					status: index % 3 === 0 ? "ignored" : index % 3 === 1 ? "Ignored" : "generated",
					ignoredBy: "config",
				})),
			};
			const expected = MutationInventory.parse(input).sample();
			expect(MutationInventory.parse(labelled).sample()).toEqual({
				...expected,
				selected: expected.selected.map((r) => ({
					...r,
					status: labelled.mutants[r.line - 1].status,
					ignoredBy: "config",
				})),
			});
			expect(MutationInventory.parse(labelled).sample()).not.toHaveProperty("ignored");
			const unclassified = { ...labelled, mutants: labelled.mutants.map((r) => ({ ...r, claim: undefined })) };
			expect(() => MutationInventory.parse(unclassified).sample()).toThrow("claim");
		},
	);

	it.each([
		{ claim: undefined, evidence: undefined, survivorClasses: undefined },
		{ claim: "killed", evidence: undefined },
		{ claim: "new-test", evidence: undefined },
		{ claim: "equivalent", evidence: undefined },
		{ claim: "killed", evidence: { reason: "wrong kind" } },
		{ claim: "new-test", evidence: { reason: "wrong kind" } },
		{ claim: "equivalent", evidence: row().evidence },
		{ claim: "killed", survivorClasses: undefined },
	])("refuses generated classification gaps for sampling and future verification: %j", (extra) => {
		for (const method of ["sample", "forVerification"] as const)
			expect(() => MutationInventory.create(fields([row(0, extra)]))[method]()).toThrow(MutationInventoryError);
	});

	it.each([
		{ claim: "unknown" },
		{ claim: "" },
		{ evidence: null },
		{ survivorClasses: null },
		{ claim: "equivalent", evidence: { reason: " " } },
		{ evidence: { test: { file: "test/a.ts", path: [] } } },
		{ evidence: "legacy" },
		{ evidence: { reason: "wrong kind" } },
		{ claim: undefined },
		{ evidence: undefined },
		{ survivorClasses: undefined },
		{ survivorClasses: ["unknown"] },
		{ claim: "equivalent", evidence: row().evidence },
		{ claim: "new-test", evidence: { reason: "wrong kind" } },
		{ evidence: { test: { file: "../outside.ts", path: ["guard"] } } },
		{ ignoredBy: "other" },
	])("still refuses invalid supplied ignored claims and fields: %j", (extra) => {
		expect(() =>
			MutationInventory.create(fields([row(0, { status: "ignored", ignoredBy: "config", ...extra })])),
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
		const evidence = input.mutants[0].evidence;
		if (evidence === undefined || !("test" in evidence)) throw new Error("missing test evidence");
		evidence.test.path.push("changed");
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

	it.each(
		terminalControls.flatMap((code) =>
			["file", "replacement", "mutatorName", "statusReason", "unmutatedFile", "unmutatedReason"].map(
				(field) => [code, field] as const,
			),
		),
	)("escapes terminal control %i in table cell %s", (code, field) => {
		const control = String.fromCharCode(code);
		const value = `before${control}after`;
		const quoted = code < 32 ? JSON.stringify(value) : `"before\\u${code.toString(16).padStart(4, "0")}after"`;
		const input = legacy([row(0, field.startsWith("unmutated") ? {} : { [field]: value })], {
			unmutated: [
				{
					file: field === "unmutatedFile" ? value : "src/link.ts",
					reason: field === "unmutatedReason" ? value : "symlink",
				},
			],
		});
		// Legacy paths permit every control, including NUL; version 2 refuses NUL paths before rendering.
		const inventory = MutationInventory.parse(input);
		const hash = inventory.sample().selected[0].sampleHash;
		expect(inventory.renderTable(), field).toBe(
			[
				"ID\tFILE\tLINE\tCOLUMN\tEND_LINE\tEND_COLUMN\tMUTATOR\tREPLACEMENT\tPOLICY",
				[
					hash,
					field === "file" ? quoted : '"src/a.ts"',
					1,
					0,
					1,
					1,
					field === "mutatorName" ? quoted.slice(1, -1) : "ConditionalExpression",
					field === "replacement" ? quoted : '"true"',
					field === "statusReason" ? `{"statusReason":${quoted}}` : "{}",
				].join("\t"),
				`UNMUTATED\t${field === "unmutatedFile" ? quoted : '"src/link.ts"'}\t${field === "unmutatedReason" ? quoted : '"symlink"'}`,
				"",
				"1 of 1 mutants; 0 omitted",
			].join("\n"),
		);
		expect(inventory.toJSON()).toEqual(input);
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
			ignored: { config: [], comment: [] },
		});
	});
});

describe("an inventory that owes claims in some files", () => {
	const unclaimed = (index: number, file: string) => ({ ...identity(index), file, status: "generated" as const });
	const owing = (extra = {}) =>
		fields([row(0), row(1), unclaimed(2, "src/b.ts")], { claimsIn: ["src/a.ts"], ...extra });

	it("samples only the rows in those files, and needs no claim outside them", () => {
		const inventory = MutationInventory.create(owing());
		expect(inventory.toJSON().claimsIn).toEqual(["src/a.ts"]);
		expect(inventory.sample()).toEqual({
			...MutationInventory.create(fields([row(0), row(1)])).sample(),
			total: 3,
		});
		expect(inventory.forVerification().mutants).toHaveLength(3);
		expect(inventory.renderTable().split("\n").at(-1)).toBe('claims owed in "src/a.ts"');
	});

	it("refuses an unclaimed row outside them when no files are named", () => {
		expect(() => MutationInventory.create(owing({ claimsIn: undefined })).sample()).toThrow(
			expect.objectContaining({ code: "unclassifiedClaim" }),
		);
	});

	it("refuses an unclaimed row inside them", () => {
		expect(() => MutationInventory.create(owing({ claimsIn: ["src/a.ts", "src/b.ts"] })).sample()).toThrow(
			expect.objectContaining({ code: "unclassifiedClaim" }),
		);
	});

	it("refuses an inventory short of the enumerated total", () => {
		const short = MutationInventory.create(owing({ total: 4, omitted: 1 }));
		expect(() => short.sample()).toThrow(expect.objectContaining({ code: "incompleteInventory" }));
		expect(() => short.forVerification()).toThrow(expect.objectContaining({ code: "incompleteInventory" }));
	});

	it("samples a legacy inventory's owed rows alone", () => {
		const { claim: _claim, evidence: _evidence, survivorClasses: _classes, ...bare } = legacy([row(2)]).mutants[0]!;
		const mixed = legacy([row(0), row(1)]);
		const inventory = MutationInventory.parse({
			...mixed,
			mutants: [...mixed.mutants, { ...bare, file: "src/b.ts" }],
			total: 3,
			claimsIn: ["src/a.ts"],
		});
		expect(inventory.sample()).toEqual({ ...MutationInventory.parse(mixed).sample(), total: 3 });
	});

	it.each([
		[["src/a.ts", "src/a.ts"], "the inventory's claimsIn names one file twice"],
		[[], "fields, coordinates, claims"],
		[["../outside.ts"], "invalid inventory file path"],
	])("refuses claimsIn %j", (claimsIn, message) => {
		expect(() => MutationInventory.create(owing({ claimsIn }))).toThrow(message);
		expect(() => MutationInventory.parse({ ...legacy(), claimsIn })).toThrow(message);
	});
});

describe("a listing limited to some files", () => {
	const limited = (mutants: MutationInventoryRowInput[] = [row()], extra = {}) =>
		fields(mutants, { limitedTo: ["src/a.ts", "src/link.ts"], ...extra });

	it("records its files and can be neither sampled nor verified", () => {
		const inventory = MutationInventory.create(limited([row(0), row(1)]));
		expect(inventory.toJSON().limitedTo).toEqual(["src/a.ts", "src/link.ts"]);
		expect(inventory.renderTable().split("\n").at(-1)).toBe('limited to "src/a.ts", "src/link.ts"');
		const refusal = expect.objectContaining({
			code: "incompleteInventory",
			message: expect.stringContaining("reading"),
		});
		expect(() => inventory.sample()).toThrow(refusal);
		expect(() => inventory.forVerification()).toThrow(refusal);
		expect(() => MutationInventory.parse({ ...legacy(), limitedTo: ["src/a.ts"] }).sample()).toThrow(refusal);
	});

	it("refuses a mutant in a file outside them, naming the file", () => {
		expect(() => MutationInventory.create(limited([row(0, { file: "src/b.ts" })]))).toThrow(
			'"src/b.ts" is outside the files the listing was limited to',
		);
	});

	it("refuses an unmutated entry outside them", () => {
		expect(() => MutationInventory.create(limited([row(0)], { limitedTo: ["src/a.ts"] }))).toThrow(
			'"src/link.ts" is outside the files the listing was limited to',
		);
	});

	it("refuses limitedTo that names one file twice", () => {
		expect(() =>
			MutationInventory.create(limited([row(0)], { limitedTo: ["src/a.ts", "src/a.ts", "src/link.ts"] })),
		).toThrow("the inventory's limitedTo names one file twice");
	});

	it("reads an inventory with neither field as before, without either table line", () => {
		const inventory = MutationInventory.create(fields());
		expect("claimsIn" in inventory.toJSON()).toBe(false);
		expect("limitedTo" in inventory.toJSON()).toBe(false);
		expect(inventory.renderTable().split("\n").at(-1)).toBe("1 of 1 mutants; 0 omitted");
	});
});
