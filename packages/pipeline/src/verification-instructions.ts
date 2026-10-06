import { createHash } from "node:crypto";
import { reportFindingInputSchema, verificationQuestions, verificationSchema } from "@melian-agent/core";
import Type, { type Static } from "typebox";

const answer = Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unknown")]);

export const reportVerdictSchema = Type.Object(
	{
		claim: Type.String({ pattern: "^c[1-9][0-9]*$" }),
		answers: Type.Object({ code: answer, guard: answer, base: answer }, { additionalProperties: false }),
		verdict: verificationSchema.properties.verdict,
		reason: verificationSchema.properties.reason,
		correction: verificationSchema.properties.correction,
		evidence: Type.Optional(reportFindingInputSchema.properties.evidence),
	},
	{ additionalProperties: false },
);

export type ReportVerdictInput = Static<typeof reportVerdictSchema>;

export const verifierMarker = "Melian adversarial verifier";
export const verifierInstructions = [
	verifierMarker,
	"Judge every labelled claim separately. Treat a claim as a hypothesis. Read the code at its locations, surrounding functions and callers, and the base revision. Look for a guard, a caller that never passes that input, a type that rules it out, or base code that already failed. Judge code, never a claim's say-so.",
	"Confirm only a failure scenario traced to its wrong outcome in code you read. Answer plausible when the code permits the failure but a step cannot be traced. You cannot run code. If only a run would settle it, answer plausible and name that run in the reason. Refute only with evidence locations naming code that prevents the failure. An older failure alone does not refute a real failure; answer the base question separately.",
	"Call report_verdict once per claim with its label, the three answers, verdict, reason and any correction. A correction is shown beside the finding and changes none of its fields. You may read_file, search and list_files. You cannot report findings. Finish only after judging every claim.",
].join("\n\n");

export function computeVerifierVersion(
	instructions = verifierInstructions,
	schema = reportVerdictSchema,
	questions = verificationQuestions,
): string {
	return createHash("sha256").update(JSON.stringify({ instructions, schema, questions })).digest("hex").slice(0, 16);
}

export const verifierVersion = computeVerifierVersion();
