import { ComparisonAdjudication, ComparisonError } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const input = { verdict: "valid", by: "Ada <ada@example.com>", at: "2026-10-05T01:00:00Z" } as const;
const refuses = (value: unknown) => {
	try {
		ComparisonAdjudication.create(value);
	} catch (error) {
		expect(error).toBeInstanceOf(ComparisonError);
		expect((error as ComparisonError).code).toBe("invalidAdjudication");
		return;
	}
	throw new Error("expected the adjudication to be refused");
};

describe("ComparisonAdjudication", () => {
	it("trims the author, rule and note, and drops absent fields", () => {
		const stored = ComparisonAdjudication.create({
			...input,
			by: "  Ada  ",
			rule: " r ",
			note: " n ",
			golden: "correctness",
			severity: "P1",
			reason: "no-owner",
		}).toJSON();
		expect(stored).toEqual({
			verdict: "valid",
			by: "Ada",
			at: input.at,
			severity: "P1",
			reason: "no-owner",
			golden: "correctness",
			rule: "r",
			note: "n",
		});
		expect(Object.keys(ComparisonAdjudication.create(input).toJSON())).toEqual(["verdict", "by", "at"]);
	});

	it.each([
		["a missing author", { ...input, by: "" }],
		["an author over 1000 characters", { ...input, by: "a".repeat(1001) }],
		["a missing time", { ...input, at: "" }],
		["a time that is not a date", { ...input, at: "later" }],
		["an of that is not an ID", { ...input, verdict: "duplicate", of: "xyz" }],
		["a golden over 100 characters", { ...input, golden: "a".repeat(101) }],
		["a golden that is not a lens name", { ...input, golden: "Not A Lens" }],
		["an empty rule", { ...input, rule: "" }],
		["a rule over 200 characters", { ...input, rule: "r".repeat(201) }],
		["a note over 1000 characters", { ...input, note: "n".repeat(1001) }],
		["an unknown key", { ...input, extra: true }],
		["an unknown verdict", { ...input, verdict: "maybe" }],
		["a blank-only rule", { ...input, rule: "   " }],
		["a duplicate without of", { ...input, verdict: "duplicate" }],
		["an of on another verdict", { ...input, of: "0123456789abcdef" }],
		["no input", undefined],
	])("refuses %s", (_name, value) => refuses(value));

	it("accepts the limits themselves", () => {
		const limits = {
			...input,
			by: "a".repeat(1000),
			golden: "g".repeat(100),
			rule: "r".repeat(200),
			note: "n".repeat(1000),
		};
		expect(ComparisonAdjudication.create(limits).toJSON()).toMatchObject({ golden: "g".repeat(100) });
		expect(ComparisonAdjudication.create({ ...input, golden: "none" }).toJSON().golden).toBe("none");
		expect(
			ComparisonAdjudication.create({ ...input, verdict: "duplicate", of: "0123456789abcdef" }).toJSON().of,
		).toBe("0123456789abcdef");
	});

	it("keeps its own copy of what it reads and returns", () => {
		const stored = ComparisonAdjudication.create(input).toJSON();
		const adjudication = ComparisonAdjudication.from(stored);
		stored.verdict = "noise";
		adjudication.toJSON().verdict = "noise";
		expect(adjudication.toJSON().verdict).toBe("valid");
	});
});
