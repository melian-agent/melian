import { createHash } from "node:crypto";
import Type, { type Static } from "typebox";
import { reportingCheck } from "./carried.ts";
import { type Severity, severitySchema } from "./config.ts";
import type { ChoiceQuestion, QuestionSet } from "./decider.ts";
import { evidenceLocationSchema } from "./evidence.ts";
import type { Finding, MemberClaim, StoredFinding } from "./findings.ts";

const strict = { additionalProperties: false } as const;
const answer = Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unknown")]);
const reason = Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" });

/** The JSON Schema of the verifier's `code`, `guard`, and `base` answers. */
export const verificationAnswersSchema = Type.Object({ code: answer, guard: answer, base: answer }, strict);

/** The JSON Schema of a {@link StoredLowering}: the lens's severity, the one the verifier lowered it to, and why. */
export const loweringSchema = Type.Object({ from: severitySchema, to: severitySchema, reason }, strict);

/**
 * The verifier's judgement, distinct from calibrated confidence. `answers` and `evidence`, the locations Melian read
 * back, are absent from a record written before Melian kept them. `lowered` is present only when the verifier proposed
 * a lowering and Melian accepted it.
 */
export const verificationSchema = Type.Object(
	{
		verdict: Type.Union([Type.Literal("confirmed"), Type.Literal("plausible"), Type.Literal("refuted")]),
		reason,
		correction: Type.Optional(reason),
		answers: Type.Optional(verificationAnswersSchema),
		evidence: Type.Optional(Type.Array(evidenceLocationSchema, { minItems: 1 })),
		lowered: Type.Optional(loweringSchema),
		executor: Type.Literal("llm"),
		model: Type.String({ pattern: "^[^/\\s]+/[^\\s]+$" }),
		version: Type.String({ minLength: 1 }),
	},
	strict,
);

/** A sighting's stored verification outcome. */
export type Verification = Static<typeof verificationSchema>;

/** A lowering as a verification record stores it. */
export type StoredLowering = Static<typeof loweringSchema>;

const verdictStrength: Readonly<Record<Verification["verdict"], number>> = { confirmed: 2, plausible: 1, refuted: 0 };
const severities: readonly Severity[] = ["P0", "P1", "P2", "P3", "nit"];

/** What a {@link Lowering} is checked against. */
export interface LoweringFields {
	/** The severity the claim's lens reported. */
	readonly from: Severity;
	/** The severity the verifier proposes. */
	readonly to: Severity;
	readonly verdict: Verification["verdict"];
	/** The claim's rule. */
	readonly rule: string;
	/** Whether a static, guardrail, or mutation check reported the defect too. */
	readonly coReported: boolean;
	/** The severities the table in force at the finding's path resolves `silent`; `undefined` when Melian could not read it. */
	readonly silent: readonly Severity[] | undefined;
	/** How many evidence locations at the head Melian read back. Lines only the base holds show nothing the head has. */
	readonly evidence: number;
	readonly executor: "llm" | "decision-model";
}

/** The rule every lens reports an instruction found in reviewed content under. */
export const injectionAttemptRuleId = "melian/injection-attempt";

/** A verifier's proposal to lower one claim's severity, held against the fence. */
export class Lowering {
	readonly fields: LoweringFields;

	constructor(fields: LoweringFields) {
		this.fields = fields;
	}

	/** Why the fence refuses the lowering, or `undefined` when it holds. A refused lowering leaves the lens's severity. */
	refusal(): string | undefined {
		const { from, to, verdict, rule, coReported, silent, evidence, executor } = this.fields;
		if (executor !== "llm") return "only the LLM verifier may lower a severity";
		if (verdict === "refuted") return "a lowering rides only on a confirmed or plausible verdict";
		if (rule === injectionAttemptRuleId) return `a ${injectionAttemptRuleId} finding is never lowered`;
		if (coReported) return "a deterministic check reported this defect too, so its severity stands";
		if (from === "P0") return "a P0 is never lowered";
		if (to === "nit") return "nothing is lowered to nit";
		if (severities.indexOf(to) !== severities.indexOf(from) + 1)
			return `a lowering is one step, P1 to P2 or P2 to P3; ${from} to ${to} is not`;
		if (silent === undefined) return "Melian could not read the resolution table at the finding's path";
		if (silent.includes(to)) return `the table in force at the finding's path resolves ${to} silent`;
		if (evidence === 0)
			return "a lowering needs evidence locations at the head naming the code that narrows the failure";
		return undefined;
	}
}

/** One claim's stored verification record, as later reports of the same claim meet it. */
export class VerificationRecord {
	readonly stored: Verification | undefined;

	constructor(stored: Verification | undefined) {
		this.stored = stored;
	}

	/**
	 * The record after `report` arrives. The stronger verdict wins whole. On equal verdicts the record keeps the higher
	 * severity, with the reason and evidence of the report that gave it, so a later equal report never weakens a stored
	 * one, in either order.
	 */
	after(report: Verification): Verification {
		const { stored } = this;
		if (stored === undefined) return report;
		if (verdictStrength[stored.verdict] !== verdictStrength[report.verdict])
			return verdictStrength[stored.verdict] > verdictStrength[report.verdict] ? stored : report;
		return stored.lowered === undefined && report.lowered !== undefined ? stored : report;
	}
}

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
			if (!reportingCheck(claim.source.check).startsWith("lens.") || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		return new VerificationState({ speaker: speaker.toJSON(), claims });
	}

	/** The candidate as JSON for a durable task. */
	toJSON(): StoredVerificationState {
		// Severity belongs on the verifier's trusted labels, outside the quoted claim data.
		return {
			speaker: structuredClone(this.speaker),
			claims: structuredClone(this.claims.map(({ severity: _, ...claim }) => claim)),
		};
	}
}
