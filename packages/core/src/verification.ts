import { createHash } from "node:crypto";
import Type, { type Static } from "typebox";
import type { ChoiceQuestion, QuestionSet } from "./decider.ts";
import type { Finding, MemberClaim, StoredFinding } from "./findings.ts";

/** The verifier's judgement, distinct from calibrated confidence. */
export const verificationSchema = Type.Object(
	{
		verdict: Type.Union([Type.Literal("confirmed"), Type.Literal("plausible"), Type.Literal("refuted")]),
		reason: Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" }),
		correction: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" })),
		executor: Type.Literal("llm"),
		model: Type.String({ pattern: "^[^/\\s]+/[^\\s]+$" }),
		version: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

/** A sighting's stored verification outcome. */
export type Verification = Static<typeof verificationSchema>;

/** The questions both verification executors answer for each claim. */
export const verificationQuestions: readonly ChoiceQuestion[] = [
	{ id: "code", text: "Does the code at the location do what the claim says?", options: ["yes", "no", "unknown"] },
	{ id: "guard", text: "Does a guard prevent the failure?", options: ["yes", "no", "unknown"] },
	{ id: "base", text: "Was the failure there before the change?", options: ["yes", "no", "unknown"] },
	{ id: "verdict", text: "What is the verdict?", options: ["confirmed", "plausible", "refuted"] },
];

/** The versioned question set, also usable by the decision-model executor. */
export const verificationQuestionSet: QuestionSet = {
	name: "verification",
	version: createHash("sha256").update(JSON.stringify(verificationQuestions)).digest("hex").slice(0, 16),
};

/** Fixed per-candidate limits until configurable verifier budgets arrive. */
export const verificationBudget = { tokens: 300_000, tools: 60 } as const;

/** One merged defect and the lens sightings the verifier judges separately. */
export type StoredVerificationState = { speaker: StoredFinding; claims: MemberClaim[] };

/** A candidate's speaker and claims, without static or guardrail reports. */
export class VerificationState {
	readonly speaker: StoredFinding;
	readonly claims: readonly MemberClaim[];

	private constructor(stored: StoredVerificationState) {
		this.speaker = stored.speaker;
		this.claims = stored.claims;
	}

	/** Builds a candidate from its speaker, retaining one claim per lens sighting. */
	static from(speaker: Finding): VerificationState {
		const seen = new Set<string>();
		const claims = [...speaker.claims(), ...(speaker.properties.otherClaims ?? [])].filter((claim) => {
			const key = JSON.stringify([claim.id, claim.source.check, claim.source.version]);
			if (!claim.source.check.startsWith("lens.") || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		return new VerificationState({ speaker: speaker.toJSON(), claims });
	}

	/** The candidate as JSON for a durable task. */
	toJSON(): StoredVerificationState {
		return { speaker: structuredClone(this.speaker), claims: structuredClone([...this.claims]) };
	}
}
