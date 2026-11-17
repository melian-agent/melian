import { goldenCommentSchema } from "@melian-agent/evals";
import Value from "typebox/value";
import { describe, expect, it } from "vitest";

const comment = {
	comment: "The user can be null.",
	severity: "High",
	category: "correctness",
	file: "src/user.ts",
	rule: "null-dereference",
	cause: "introduced",
	failureScenario: "A missing user crashes the page.",
	evidence: [{ file: "src/user.ts", line: 3, role: "cause" }],
};

describe("an expected finding's schema", () => {
	it("takes alternative rules that are some and distinct, and lines that are two lines from 1", () => {
		const cases = [
			{ fields: {}, valid: true },
			{ fields: { alternativeRules: ["wrong-result"] }, valid: true },
			{ fields: { alternativeRules: [] }, valid: false },
			{ fields: { alternativeRules: ["wrong-result", "wrong-result"] }, valid: false },
			{ fields: { lines: [1, 1] }, valid: true },
			{ fields: { lines: [0, 1] }, valid: false },
			{ fields: { lines: [1, 0] }, valid: false },
			{ fields: { lines: [1] }, valid: false },
		];
		for (const { fields, valid } of cases)
			expect(Value.Check(goldenCommentSchema, { ...comment, ...fields }), JSON.stringify(fields)).toBe(valid);
	});
});
