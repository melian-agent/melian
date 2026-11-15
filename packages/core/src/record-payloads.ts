import Type, { type Static, type TLiteral, type TSchema, type TUnion } from "typebox";
import Value from "typebox/value";
import { severitySchema } from "./config.ts";
import { FindingError } from "./errors.ts";
import { Finding, type StoredFinding } from "./findings.ts";
import { scrutinyLevels } from "./lens.ts";
import type { PayloadChecks, RecordJson } from "./record.ts";
import { verificationSchema } from "./verification.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const count = Type.Integer({ minimum: 0 });
const findingId = Type.String({ pattern: "^[0-9a-f]{16}$" });
const recordId = Type.String({ pattern: "^[0-9a-f]{64}$" });
const objectId = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
const revision = Type.String({ pattern: `^${objectId}\\.\\.${objectId}$` });
// TypeBox types a union built by `map` as `never`, since it reads literals only from a tuple; the cast names the tuple.
type Literals<T extends readonly string[]> = { -readonly [K in keyof T]: TLiteral<T[K] & string> };
const literals = <const T extends readonly string[]>(values: T) =>
	Type.Union(values.map((each) => Type.Literal(each))) as unknown as TUnion<Literals<T>>;
const level = literals(scrutinyLevels);
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
// A sighting is checked by `Finding.parse`, the authority on what a finding is, after the shape.
const sightings = Type.Array(Type.Unknown());
const v = Type.Literal(1);

const snapshot = Type.Object(
	{
		commit: text,
		snapshotId: text,
		receipt: text,
		cacheKey: nullable(text),
		coverage: nullable(Type.Object({ graph: nullable(text), review: nullable(text), test: nullable(text) }, strict)),
	},
	strict,
);
const notes = Type.Array(Type.String());
const name = text;
const version = nullable(text);

/**
 * The JSON Schema of a check's result as its record holds it: the run record `melian.checks` keeps, with `null` where
 * the stored record leaves a field out, so a record missing any field is refused.
 */
export const checkResultSchema = Type.Union([
	Type.Object(
		{ name, status: Type.Literal("ran"), version, findings: count, notes, snapshots: nullable(Type.Array(snapshot)) },
		strict,
	),
	Type.Object({ name, status: Type.Literal("provisional"), version, findings: count, notes, reason: text }, strict),
	Type.Object(
		{
			name,
			status: Type.Literal("skipped"),
			reason: text,
			cause: nullable(literals(["noProductionLines", "headNotAllowed", "timeout", "unmutated"])),
		},
		strict,
	),
	Type.Object({ name, status: Type.Literal("failed"), reason: text, error: Type.String() }, strict),
]);

/** A check record's payload: the check's result and the findings it reported at the record's revision. */
export const checkPayloadSchema = Type.Object({ v, result: checkResultSchema, sightings }, strict);

const budgetEnd = Type.Object(
	{ budget: Type.Union([Type.Literal("tokens"), Type.Literal("tools")]), limit: count, tokens: count, tools: count },
	strict,
);
const trigger = Type.Union([
	Type.Object({ kind: Type.Literal("severity"), severity: severitySchema }, strict),
	Type.Object(
		{ kind: Type.Literal("budget"), budget: Type.Union([Type.Literal("tokens"), Type.Literal("tools")]) },
		strict,
	),
]);
const findingIds = Type.Array(findingId);

/**
 * A lens run's outcome. Every field is present, `null` where the run has no such fact, and the spend is in whole
 * millionths of a US dollar, since a record holds integers only.
 */
export const lensOutcomeSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("done"),
			model: nullable(text),
			budgetEnded: nullable(budgetEnd),
			capped: nullable(count),
			escalation: nullable(
				Type.Object(
					{ trigger, to: nullable(text), carried: findingIds, kept: findingIds, refuted: findingIds },
					strict,
				),
			),
			usage: nullable(Type.Object({ models: Type.Array(text), tokens: count, costMicros: count }, strict)),
		},
		strict,
	),
	Type.Object({ status: Type.Literal("unanswered"), reason: text }, strict),
	Type.Object({ status: Type.Literal("exhausted"), tried: Type.Array(text), reason: text }, strict),
]);

/**
 * A lens record's payload: the lens, its version and level, whether the run probed, its outcome, the findings it
 * reported, and its delivery evidence, `null` until Melian works delivery evidence out.
 */
export const lensPayloadSchema = Type.Object(
	{
		v,
		name: text,
		version: text,
		level,
		probe: Type.Boolean(),
		outcome: lensOutcomeSchema,
		sightings,
		delivery: Type.Null(),
	},
	strict,
);

const source = Type.Object({ check: text, version: nullable(text) }, strict);

/**
 * A verification record's payload: each claim's verdict, each dismissed finding the verifier was shown with the ID of
 * its dismissal record, and each candidate's outcome.
 */
export const verificationPayloadSchema = Type.Object(
	{
		v,
		claims: Type.Array(Type.Object({ id: findingId, source, verification: verificationSchema }, strict)),
		dismissals: Type.Array(Type.Object({ finding: findingId, record: recordId }, strict)),
		outcomes: Type.Array(
			Type.Object(
				{
					candidate: text,
					outcome: Type.Union([
						Type.Object({ status: Type.Literal("done"), model: text }, strict),
						Type.Object({ status: Type.Literal("ended"), budgetEnded: budgetEnd }, strict),
						Type.Object(
							{ status: Type.Union([Type.Literal("unanswered"), Type.Literal("exhausted")]), reason: text },
							strict,
						),
					]),
				},
				strict,
			),
		),
	},
	strict,
);

/** A walkthrough record's payload: the route that wrote it and the walkthrough, `null` where it has no diagram or note. */
export const walkthroughPayloadSchema = Type.Object(
	{
		v,
		route: text,
		summary: text,
		files: Type.Array(Type.Object({ path: text, summary: text }, strict)),
		diagram: nullable(text),
		note: nullable(text),
	},
	strict,
);

/**
 * A triage record's payload: the decision, or why there is none, and whether the decider's input was cut. Each answer's
 * distribution is in whole millionths, since a record holds integers only.
 */
export const triagePayloadSchema = Type.Object(
	{
		v,
		decision: nullable(
			Type.Object(
				{
					questionSet: Type.Object({ name: text, version: text }, strict),
					decider: text,
					calibrated: Type.Boolean(),
					model: nullable(text),
					answers: Type.Array(
						Type.Object(
							{ question: text, distribution: Type.Record(Type.String(), count), chosen: text },
							strict,
						),
					),
				},
				strict,
			),
		),
		failure: nullable(text),
		inputCut: Type.Boolean(),
	},
	strict,
);

/** A telemetry record's payload: a round's duration and each stage's spend, in whole millionths of a US dollar. */
export const telemetryPayloadSchema = Type.Object(
	{
		v,
		durationMs: nullable(count),
		stages: Type.Array(
			Type.Object(
				{
					name: text,
					level: nullable(level),
					models: Type.Array(text),
					durationMs: nullable(count),
					tokens: nullable(count),
					cacheRead: nullable(count),
					costMicros: nullable(count),
					outcome: text,
					tools: nullable(count),
					limits: nullable(Type.Object({ tokens: nullable(count), tools: nullable(count) }, strict)),
					ended: nullable(Type.Union([Type.Literal("tokens"), Type.Literal("tools")])),
					usageIncomplete: Type.Boolean(),
				},
				strict,
			),
		),
	},
	strict,
);

/**
 * A dismissal record's payload, by rule 5 of the shared record decision: the dismisser, the reason, the time, the
 * severity the verdict showed, the frozen sighting with the revision it was seen at, the head the dismissal was made
 * at, the rounds its writer listed, and the accepted trigger with its proof.
 */
export const dismissalPayloadSchema = Type.Object(
	{
		v,
		by: text,
		reason: text,
		at: text,
		severity: severitySchema,
		sighting: Type.Object({ revision, finding: Type.Unknown() }, strict),
		head: Type.String({ pattern: `^${objectId}$` }),
		rounds: Type.Array(recordId),
		trigger: Type.Object({ hash: text, proof: Type.Array(Type.Object({ file: text, hash: text }, strict)) }, strict),
	},
	strict,
);

export type CheckPayload = Static<typeof checkPayloadSchema>;
export type LensPayload = Static<typeof lensPayloadSchema>;
export type VerificationPayload = Static<typeof verificationPayloadSchema>;
export type WalkthroughPayload = Static<typeof walkthroughPayloadSchema>;
export type TriagePayload = Static<typeof triagePayloadSchema>;
export type TelemetryPayload = Static<typeof telemetryPayloadSchema>;
export type DismissalPayload = Static<typeof dismissalPayloadSchema>;

function shape(schema: TSchema, payload: RecordJson): string | undefined {
	const [error] = Value.Errors(schema, payload);
	if (error === undefined) return undefined;
	return `does not match its schema at ${error.instancePath || "(top level)"}: ${error.message}`;
}

function finding(value: unknown, where: string): StoredFinding | string {
	try {
		return Finding.parse(value).toJSON();
	} catch (error) {
		if (error instanceof FindingError) return `holds a sighting at ${where} that is not a finding: ${error.message}`;
		throw error;
	}
}

// Each sighting must be a finding, and must name the producer the record is for, so a record cannot carry another's.
function sightingsOf(values: readonly unknown[], check: string, version: string | undefined): string | undefined {
	for (const [index, value] of values.entries()) {
		const parsed = finding(value, `/sightings/${index}`);
		if (typeof parsed === "string") return parsed;
		const { source } = parsed.properties;
		if (source.check !== check || source.version !== version)
			return `holds a sighting at /sightings/${index} from ${source.check}@${source.version ?? ""}, not ${check}@${version ?? ""}`;
	}
	return undefined;
}

/**
 * The payload check of each kind a review writes, and of a dismissal, for {@link SharedRecord.parse} and
 * {@link RecordSet.of}. Each refuses a payload missing any field, holding one more, or of another version than 1.
 */
export const reviewPayloads: PayloadChecks = {
	check: (payload) => {
		const refused = shape(checkPayloadSchema, payload);
		if (refused !== undefined) return refused;
		const { result, sightings } = payload as CheckPayload;
		if ((result.status === "skipped" || result.status === "failed") && sightings.length > 0)
			return `holds sightings for a check that ${result.status === "skipped" ? "was skipped" : "failed"}`;
		return sightingsOf(sightings, result.name, "version" in result ? (result.version ?? undefined) : undefined);
	},
	lens: (payload) => {
		const refused = shape(lensPayloadSchema, payload);
		if (refused !== undefined) return refused;
		const { name, version, level, sightings } = payload as LensPayload;
		return sightingsOf(sightings, `lens.${name}`, `${version}@${level}`);
	},
	verification: (payload) => {
		const refused = shape(verificationPayloadSchema, payload);
		if (refused !== undefined) return refused;
		const { claims, dismissals } = payload as VerificationPayload;
		const shown = new Set(dismissals.map((each) => each.finding));
		if (shown.size !== dismissals.length) return "names one dismissed finding twice";
		for (const [index, claim] of claims.entries())
			for (const id of Object.keys(claim.verification.matches ?? {}))
				if (!shown.has(id)) return `matches claim ${index} against ${id}, which names no dismissal record`;
		return undefined;
	},
	walkthrough: (payload) => shape(walkthroughPayloadSchema, payload),
	triage: (payload) => shape(triagePayloadSchema, payload),
	telemetry: (payload) => shape(telemetryPayloadSchema, payload),
	dismissal: (payload) => {
		const refused = shape(dismissalPayloadSchema, payload);
		if (refused !== undefined) return refused;
		const { sighting, head } = payload as DismissalPayload;
		if (sighting.revision.split("..")[1] !== head) return "names a head that is not its sighting's revision's";
		const parsed = finding(sighting.finding, "/sighting/finding");
		return typeof parsed === "string" ? parsed : undefined;
	},
};
