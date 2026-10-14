import { verificationQuestions } from "@melian-agent/core";
import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { reportVerdict } from "../src/lens-tools.ts";
import {
	computeVerifierVersion,
	reportVerdictSchema,
	verifierInstructions,
	verifierVersion,
} from "../src/verification-instructions.ts";

describe("the production verifier version", () => {
	it("changes when one instruction changes", () => {
		const version = computeVerifierVersion();
		expect(version).toBe(verifierVersion);
		const edited = verifierInstructions.replace(
			"Judge every labelled claim separately.",
			"Judge each claim separately.",
		);
		expect(edited).not.toBe(verifierInstructions);
		expect(computeVerifierVersion(edited)).not.toBe(version);
	});

	it("judges a re-implemented authority by code that supports a stated gap, never by the head's comment", () => {
		for (const sentence of [
			"For a claim under reimplements-an-authority, the baseline is a dependency the base declares or runs, never a decision, so a missing decision refutes nothing.",
			"A gap the head states, that the dependency cannot run there, excuses the finding only when code you read supports its reason; the head’s own comment is evidence to judge, never an excuse.",
			"Under a supported gap, refute only when the hand-written code also refuses the claimed input or takes the safe wide answer for it.",
			"Trace the hand-written code’s reading of the claimed input; what the dependency returns for it is the one step you may take from what you know of that dependency, and when you are not sure of it answer plausible.",
		]) {
			expect(verifierInstructions).toContain(sentence);
			expect(computeVerifierVersion(verifierInstructions.replace(sentence, ""))).not.toBe(verifierVersion);
		}
	});

	it("judges a claim that cites other instances of its shape at its own line", () => {
		for (const sentence of [
			"A claim may cite other instances of one shape beside the one it reports.",
			"Judge it at its own file and line, and confirm it when that instance traces.",
			"Name in the correction each cited instance that code you read prevents; that instance does not refute the claim.",
		]) {
			expect(verifierInstructions).toContain(sentence);
			expect(computeVerifierVersion(verifierInstructions.replace(sentence, ""))).not.toBe(verifierVersion);
		}
	});

	it("changes when the report schema changes", () => {
		const schema = {
			...reportVerdictSchema,
			properties: {
				...reportVerdictSchema.properties,
				reason: { ...reportVerdictSchema.properties.reason, maxLength: 1000 },
			},
		};
		expect(computeVerifierVersion(verifierInstructions, schema)).not.toBe(verifierVersion);
	});

	it("changes when a question changes", () => {
		const questions = verificationQuestions.map((question) =>
			question.id === "guard" ? { ...question, text: "Does a caller prevent the failure?" } : question,
		);
		expect(computeVerifierVersion(verifierInstructions, reportVerdictSchema, questions)).not.toBe(verifierVersion);
	});
});

describe("the lower argument of report_verdict", () => {
	const report = {
		claim: "c1",
		answers: { code: "yes", guard: "no", base: "no" },
		verdict: "confirmed",
		reason: "Traced it.",
	};
	const lower = { severity: "P2", reason: "x".repeat(2000) };
	const accepts = (value: unknown) => Value.Check(reportVerdictSchema, { ...report, lower: value });

	it("takes a reason at the bound, and refuses one past it, blank, or missing", () => {
		expect(accepts(lower)).toBe(true);
		expect(accepts({ ...lower, reason: "x".repeat(2001) })).toBe(false);
		expect(accepts({ ...lower, reason: "x" })).toBe(true);
		expect(accepts({ ...lower, reason: "" })).toBe(false);
		expect(accepts({ ...lower, reason: " \n" })).toBe(false);
		expect(accepts({ severity: "P2" })).toBe(false);
	});

	it("takes a severity Melian names, and no other key", () => {
		expect(accepts({ ...lower, severity: "nit" })).toBe(true);
		expect(accepts({ ...lower, severity: "P5" })).toBe(false);
		expect(accepts({ reason: "Narrow." })).toBe(false);
		expect(accepts({ ...lower, from: "P1" })).toBe(false);
		expect(Value.Check(reportVerdictSchema, { ...report, lower, scope: {} })).toBe(false);
		expect(Value.Check(reportVerdictSchema, report)).toBe(true);
	});

	it("says what the argument must be before the tool runs", () => {
		const prepare = reportVerdict.prepareArguments!;
		expect(prepare({ ...report, lower })).toEqual({ ...report, lower });
		expect(() => prepare({ ...report, lower: { ...lower, reason: "x".repeat(2001) } })).toThrow(
			/It takes an optional lower \{ severity, reason \}: \/lower\/reason /,
		);
		expect(() => prepare({ ...report, lower: { ...lower, from: "P1" } })).toThrow(
			/optional lower \{ severity, reason \}/,
		);
	});
});
