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
