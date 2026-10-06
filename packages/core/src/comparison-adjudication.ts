import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { severitySchema } from "./config.ts";
import { ComparisonError } from "./comparison.ts";

/** The four actions a valid miss calls for. */
export const missReasons = ["owned-missed", "no-owner", "needs-execution", "out-of-scope"] as const;

/** A maintainer's judgement of one comparison finding, with local author identity. */
export const comparisonAdjudicationSchema = Type.Object(
	{
		verdict: Type.Union([Type.Literal("valid"), Type.Literal("noise"), Type.Literal("duplicate")]),
		by: Type.String({ minLength: 1, maxLength: 1000 }),
		at: Type.String({ minLength: 1 }),
		severity: Type.Optional(severitySchema),
		of: Type.Optional(Type.String({ pattern: "^[0-9a-f]{16}$" })),
		reason: Type.Optional(
			Type.Union([
				Type.Literal("owned-missed"),
				Type.Literal("no-owner"),
				Type.Literal("needs-execution"),
				Type.Literal("out-of-scope"),
			]),
		),
		golden: Type.Optional(Type.String({ pattern: "^(none|[a-z0-9][a-z0-9-]*)$", maxLength: 100 })),
		rule: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		note: Type.Optional(Type.String({ maxLength: 1000 })),
	},
	{ additionalProperties: false },
);

/** The current judgement; earlier judgements are kept separately in its record. */
export type StoredComparisonAdjudication = Static<typeof comparisonAdjudicationSchema>;

/** One finding's current judgement and the judgements it replaced, oldest first. */
export type ComparisonAdjudicationRecord = {
	current: StoredComparisonAdjudication;
	history: StoredComparisonAdjudication[];
};

/** A local comparison judgement. Exported as ComparisonAdjudication beside the review's Adjudication. */
export class Adjudication {
	private readonly stored: StoredComparisonAdjudication;

	private constructor(stored: StoredComparisonAdjudication) {
		this.stored = stored;
	}

	/** Reads a stored judgement without validating it. */
	static from(stored: StoredComparisonAdjudication): Adjudication {
		return new Adjudication(structuredClone(stored));
	}

	/** Validates a maintainer's input, trimming the author and note. */
	static create(input: unknown): Adjudication {
		if (!Value.Check(comparisonAdjudicationSchema, input))
			throw new ComparisonError(
				"invalidAdjudication",
				"adjudication needs valid fields, an author, a time, and a note of at most 1000 characters",
			);
		const stored = JSON.parse(
			JSON.stringify({
				verdict: input.verdict,
				by: input.by.trim(),
				at: input.at,
				severity: input.severity,
				of: input.of,
				reason: input.reason,
				golden: input.golden,
				rule: input.rule?.trim(),
				note: input.note?.trim(),
			}),
		) as StoredComparisonAdjudication;
		if (!Value.Check(comparisonAdjudicationSchema, stored) || !Number.isFinite(Date.parse(stored.at))) {
			throw new ComparisonError(
				"invalidAdjudication",
				"adjudication needs valid fields, an author, a time, and a note of at most 1000 characters",
			);
		}
		if ((stored.verdict === "duplicate") !== (stored.of !== undefined))
			throw new ComparisonError(
				"invalidAdjudication",
				"duplicate requires --of <id>; other verdicts cannot use --of",
			);
		return new Adjudication(stored);
	}

	toJSON(): StoredComparisonAdjudication {
		return structuredClone(this.stored);
	}
}
