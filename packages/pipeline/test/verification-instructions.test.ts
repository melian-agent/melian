import { verificationQuestions } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
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
