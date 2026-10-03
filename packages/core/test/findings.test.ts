import { findingId } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const evalCall = { file: "src/run.ts", rule: "no-eval", snippet: "eval(input)" };

describe("findingId", () => {
	it("is 16 lowercase hex characters", () => {
		expect(findingId(evalCall)).toMatch(/^[0-9a-f]{16}$/);
	});

	// Pinned so that a change to the normalisation, which would orphan every stored finding, fails here first.
	it("hashes the file, rule, and normalised snippet", () => {
		expect(findingId(evalCall)).toBe("8dd0822422207e29");
	});

	it("ignores reindenting and rewrapping the flagged code", () => {
		const reflowed = { ...evalCall, snippet: "\n\t  eval(\n\t\tinput\n\t)  " };
		expect(findingId({ ...evalCall, snippet: "eval( input )" })).toBe(findingId(reflowed));
		expect(findingId({ ...evalCall, snippet: "  eval(input)\n" })).toBe(findingId(evalCall));
	});

	it("changes when one token of the flagged code changes", () => {
		expect(findingId({ ...evalCall, snippet: "eval(body)" })).not.toBe(findingId(evalCall));
	});

	it("changes with the file or the rule", () => {
		expect(findingId({ ...evalCall, file: "src/main.ts" })).not.toBe(findingId(evalCall));
		expect(findingId({ ...evalCall, rule: "no-implied-eval" })).not.toBe(findingId(evalCall));
	});

	it("keeps fields apart, so text cannot move from one field to the next", () => {
		expect(findingId({ file: "a", rule: "bc", snippet: "d" })).not.toBe(
			findingId({ file: "ab", rule: "c", snippet: "d" }),
		);
	});
});
