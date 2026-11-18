import { valid } from "semver";
import Type, { type Static, type TLiteral, type TSchema, type TUnion } from "typebox";
import Value from "typebox/value";
import { noRecord } from "./adjudication.ts";
import { severitySchema, thinkingLevelSchema } from "./config.ts";
import { type CheckErrorCode, FindingError } from "./errors.ts";
import { Finding, findingIdPattern, type StoredFinding } from "./findings.ts";
import { lensVersionDigits, scrutinyLevels } from "./lens.ts";
import { canonicalJson, hashPattern, type PayloadChecks, type RecordJson } from "./record.ts";
import { verificationSchema } from "./verification.ts";

/** What an exported record says in place of text a tool, a provider or the head's code may have written. */
export const withheld = "Melian shares none of this text, which the reviewing host's store and terminal hold";

/** The start of the caveat a review states once when no lens saw who calls the changed code. */
export const blindCallers =
	"callers were unavailable for every changed site, so no lens saw who calls the changed code";

/** The note, and the caveat, of a review in which triage chose quick for every lens. */
export const lightTriage =
	"triage chose quick for every lens, so the whole review looked lightly, at a change that can steer triage";

/**
 * The codes a record carries as they are, where a reason or an error would otherwise be text: a check error's, a task
 * outcome's, a manifest's and the export's own.
 */
export const recordCodes = [
	...([
		"unknownCheck",
		"unknownTier",
		"tierCycle",
		"unknownConversation",
		"notCompleted",
		"noEnvironment",
		"worktreeFailed",
		"toolMissing",
		"toolFailed",
		"timeout",
		"aborted",
		"nothingToCheck",
		"outputTooLarge",
		"invalidOutput",
		"unreadable",
		"tooLarge",
	] as const satisfies readonly CheckErrorCode[]),
	"failed",
	"orphaned",
	"faulted",
	noRecord,
	"unexpected",
	"withheld",
] as const;

/**
 * A telemetry stage's outcome: a Pi task's end, as the telemetry projection reads it, a check record's, or a run row's
 * `ran` or `reused`.
 */
export const telemetryOutcomes = [
	"ran",
	"reused",
	"running",
	"completed",
	"superseded",
	"failed",
	"aborted",
	"orphaned",
	"faulted",
	"timed-out",
	"skipped",
	"ended",
	"provisional",
] as const;

/** An Enola snapshot's ID, which Melian computes as a SHA-256 hash. */
export const snapshotIdPattern = "^sha256:[0-9a-f]{64}$";

/** A git object ID, SHA-1 or SHA-256, as a revision names a commit. */
export const objectIdPattern = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";

/** The receipt a record keeps of Enola's: the three fields Melian checks, in the order Melian writes them. */
const receiptPattern =
	'^\\{"format_version":1,"snapshot_id":"sha256:[0-9a-f]{64}","enola_version":"([0-9][0-9A-Za-z.+-]{0,63})"\\}$';

/** Whether `text` is a receipt as a record keeps it, its Enola version in semver's own form, which `valid` decides. */
export function isReceipt(text: string): boolean {
	const version = new RegExp(receiptPattern).exec(text)?.[1];
	return version !== undefined && isSemver(version);
}

/**
 * Whether a record may carry `version` as a tool's: a version in semver's own form of at most 64 characters, which
 * `valid` decides, or Melian's `unavailable`. A tool's version comes from its installed manifest, which the head can
 * write, so anything else is text Melian did not write.
 */
export function isToolVersion(version: string): boolean {
	return version === "unavailable" || isSemver(version);
}

function isSemver(version: string): boolean {
	return version.length <= 64 && valid(version) === version;
}

/** How many hex digits of its hash the verifier's version keeps, which pipeline's `verifierVersion` cuts it to. */
export const verifierVersionDigits = 16;

const lensVersion = new RegExp(`^[0-9a-f]{${lensVersionDigits}}$`);
const verifierVersion = new RegExp(`^[0-9a-f]{${verifierVersionDigits}}$`);

// A check's version as a record holds it: a lens's and the verifier's are Melian's hashes, and any other check's is a
// tool's, or Melian's sentence where the tool's was not one.
function checkVersion(name: string, version: string): boolean {
	if (name.startsWith("lens.")) return lensVersion.test(version);
	if (name === "verifier") return verifierVersion.test(version);
	return version === withheld || isToolVersion(version);
}

// A finding's source as a record holds it: a lens's version at its level, or a check's version as `checkVersion` has.
function sourceVersion(check: string, version: string): boolean {
	if (!check.startsWith("lens.")) return checkVersion(check, version);
	const [hash, level, ...rest] = version.split("@");
	return rest.length === 0 && lensVersion.test(hash ?? "") && scrutinyLevels.includes(level as never);
}

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const count = Type.Integer({ minimum: 0 });
const findingId = Type.String({ pattern: findingIdPattern });
const hash = Type.String({ pattern: hashPattern });
const recordId = hash;
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
const code = literals([...recordCodes, withheld]);
const caveat = literals([blindCallers, lightTriage, withheld]);
const coverage = nullable(Type.Object({ graph: nullable(hash), review: nullable(hash), test: nullable(hash) }, strict));
const thinking = Type.Union([thinkingLevelSchema, Type.Literal("unset")]);

const snapshot = Type.Object(
	{
		commit: Type.String({ pattern: objectIdPattern }),
		snapshotId: Type.String({ pattern: snapshotIdPattern }),
		receipt: Type.Union([Type.Literal(withheld), Type.String({ pattern: receiptPattern })]),
		cacheKey: nullable(hash),
		coverage,
	},
	strict,
);
// A record keeps no note, since a note is a check's own text.
const notes = Type.Array(Type.String(), { maxItems: 0 });
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
	Type.Object({ name, status: Type.Literal("provisional"), version, findings: count, notes, reason: code }, strict),
	Type.Object(
		{
			name,
			status: Type.Literal("skipped"),
			reason: code,
			cause: nullable(literals(["noProductionLines", "headNotAllowed", "timeout", "unmutated"])),
		},
		strict,
	),
	Type.Object(
		{ name, status: Type.Literal("failed"), reason: literals(recordCodes), error: Type.Literal(withheld) },
		strict,
	),
]);

/** A check record's payload: the check's result and the findings it reported at the record's revision. */
export const checkPayloadSchema = Type.Object({ v, result: checkResultSchema, sightings }, strict);

const budgetEnd = Type.Object(
	{ budget: Type.Union([Type.Literal("tokens"), Type.Literal("tools")]), limit: count, tokens: count, tools: count },
	strict,
);
// A check record's fields as a review decided them, with `null` where the record leaves one out.
const decidedFields = {
	name: text,
	reason: nullable(code),
	error: nullable(code),
	version: nullable(text),
	level: nullable(level),
	budgetEnded: nullable(budgetEnd),
	caveats: nullable(Type.Array(caveat)),
	coverage,
	lineage: nullable(
		Type.Object(
			{
				model: text,
				thinking: nullable(Type.Object({ level: thinking, wanted: thinking, by: text }, strict)),
				wanted: nullable(text),
				by: text,
				moved: nullable(Type.Object({ by: text, from: text, to: text }, strict)),
				outside: Type.Boolean(),
			},
			strict,
		),
	),
};

// The check record a run decided, with `null` where the record leaves a field out. A reader takes it as the run's
// result, so a record that must hold one and does not reads as not reviewed.
const decidedCheckSchema = Type.Object({ ...decidedFields, status: literals(["ran", "ended", "failed"]) }, strict);

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
	Type.Object({ status: Type.Literal("unanswered"), reason: code }, strict),
	Type.Object({ status: Type.Literal("exhausted"), tried: Type.Array(text), reason: code }, strict),
]);

/**
 * A lens record's payload: the lens, its version and level, whether the run probed, its outcome, the findings it
 * reported, its delivery evidence, `null` until Melian works delivery evidence out, and the check record the review
 * decided for the run that stands for the lens, `null` in a record exported as the lens ended, before the review
 * decided.
 */
export const lensPayloadSchema = Type.Object(
	{
		v,
		name: text,
		version: Type.String({ pattern: lensVersion.source }),
		level,
		probe: Type.Boolean(),
		outcome: lensOutcomeSchema,
		sightings,
		delivery: Type.Null(),
		check: nullable(decidedCheckSchema),
	},
	strict,
);

const source = Type.Object({ check: text, version: nullable(text) }, strict);

/**
 * A verification record's payload: each claim's verdict, each dismissed finding the verifier was shown with the ID of
 * its dismissal record, each candidate's outcome, and the verifier's check record, `null` when the review decided none.
 */
export const verificationPayloadSchema = Type.Object(
	{
		v,
		claims: Type.Array(Type.Object({ id: findingId, source, verification: verificationSchema }, strict)),
		dismissals: Type.Array(Type.Object({ finding: findingId, record: recordId }, strict)),
		outcomes: Type.Array(
			Type.Object(
				{
					candidate: findingId,
					outcome: Type.Union([
						Type.Object({ status: Type.Literal("done"), model: text }, strict),
						Type.Object({ status: Type.Literal("ended"), budgetEnded: budgetEnd }, strict),
						Type.Object(
							{ status: Type.Union([Type.Literal("unanswered"), Type.Literal("exhausted")]), reason: code },
							strict,
						),
					]),
				},
				strict,
			),
		),
		check: nullable(decidedCheckSchema),
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
		failure: nullable(code),
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
					outcome: literals([...telemetryOutcomes, withheld]),
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
		trigger: Type.Object({ hash, proof: Type.Array(Type.Object({ file: text, hash }, strict)) }, strict),
	},
	strict,
);

const accountFields = {
	checks: Type.Array(text),
	records: Type.Array(recordId),
	filled: Type.Array(Type.Object({ ...decidedFields, status: literals(["skipped", "failed"]) }, strict)),
	allowSkip: Type.Array(text),
	producers: Type.Array(Type.Object({ check: text, version: nullable(text), ids: nullable(findingIds) }, strict)),
};

/**
 * An account record's payload: how a round accounts for every check its tier names. It holds the tier's checks in tier
 * order, the IDs of the check and lens records it counts, the record it made for each check no record holds, the checks
 * whose skip lets the review pass, and the sources whose findings the review counts, each with the finding IDs it keeps
 * where it keeps only some. Version 2 names the resolution policy the review decided under by its fingerprint, or
 * `null` when the review read no policy source, so a reader decides the round only under that policy.
 */
export const accountPayloadSchema = Type.Object(
	{
		v: Type.Literal(2),
		...accountFields,
		resolutionPolicy: nullable(Type.String({ pattern: "^[0-9]+:[0-9a-f]{16}$" })),
	},
	strict,
);

/** An account record's payload at version 1, which main wrote before accounts named their resolution policy. */
export const legacyAccountPayloadSchema = Type.Object({ v, ...accountFields }, strict);

export type CheckPayload = Static<typeof checkPayloadSchema>;
export type LensPayload = Static<typeof lensPayloadSchema>;
export type VerificationPayload = Static<typeof verificationPayloadSchema>;
export type WalkthroughPayload = Static<typeof walkthroughPayloadSchema>;
export type TriagePayload = Static<typeof triagePayloadSchema>;
export type TelemetryPayload = Static<typeof telemetryPayloadSchema>;
export type DismissalPayload = Static<typeof dismissalPayloadSchema>;
export type AccountPayload = Static<typeof accountPayloadSchema>;
export type LegacyAccountPayload = Static<typeof legacyAccountPayloadSchema>;

function shape(schema: TSchema, payload: RecordJson): string | undefined {
	const [error] = Value.Errors(schema, payload);
	if (error === undefined) return undefined;
	// A key the schema does not name, an unknown field's or a map's, is the record's own text, so the path masks it.
	const named = (segment: string) =>
		/^\d+$/.test(segment) || `${error.schemaPath}/`.includes(`/properties/${segment}/`);
	const where = error.instancePath
		.split("/")
		.slice(1)
		.map((segment) => (named(segment) ? segment : "*"))
		.join("/");
	return `does not match its schema at ${error.instancePath === "" ? "(top level)" : `/${where}`}: ${error.message}`;
}

function finding(value: unknown, where: string): StoredFinding | string {
	try {
		return Finding.parse(value).toJSON();
	} catch (error) {
		if (error instanceof FindingError) return `holds a sighting at ${where} that is not a finding: ${error.code}`;
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
			return `holds a sighting at /sightings/${index} from another producer than the record's`;
	}
	return undefined;
}

// Whether `values` is in the order `compare` sets, with none twice, so one account has one form.
function ordered<T>(values: readonly T[], compare: (a: T, b: T) => number): boolean {
	return values.every((value, index) => index === 0 || compare(values[index - 1] as T, value) < 0);
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// A message names the field and never repeats its value, which may be the very text the record must not hold.
const decidedVersion = (check: { name: string; version: string | null } | null, where: string) =>
	check === null || check.version === null || checkVersion(check.name, check.version)
		? undefined
		: `names a version at ${where} that is not one Melian writes`;
const namedSource = (source: { check: string; version: string | null }, where: string) =>
	source.version === null || sourceVersion(source.check, source.version)
		? undefined
		: `names a version at ${where} that is not one Melian writes`;

/**
 * The payload check of each kind a review writes, and of a dismissal, for {@link SharedRecord.parse} and
 * {@link RecordSet.of}. Each refuses a payload missing any field, holding one more, or of another version than 1,
 * except the account's, which takes version 2 and version 1.
 */
export const reviewPayloads: PayloadChecks = {
	check: (payload) => {
		const refused = shape(checkPayloadSchema, payload);
		if (refused !== undefined) return refused;
		const { result, sightings } = payload as CheckPayload;
		const unwritten = decidedVersion("version" in result ? result : null, "/result/version");
		if (unwritten !== undefined) return unwritten;
		const unread = (("snapshots" in result && result.snapshots) || []).findIndex(
			({ receipt }) => receipt !== withheld && !isReceipt(receipt),
		);
		if (unread !== -1) return `names a version at /result/snapshots/${unread}/receipt that is not one Melian writes`;
		if ((result.status === "skipped" || result.status === "failed") && sightings.length > 0)
			return `holds sightings for a check that ${result.status === "skipped" ? "was skipped" : "failed"}`;
		return sightingsOf(sightings, result.name, "version" in result ? (result.version ?? undefined) : undefined);
	},
	lens: (payload) => {
		const refused = shape(lensPayloadSchema, payload);
		if (refused !== undefined) return refused;
		const { name, version, level, sightings, check } = payload as LensPayload;
		if (check !== null && (check.name !== `lens.${name}` || check.version !== version || check.level !== level))
			return "holds the check of another lens, version or level than its own";
		return sightingsOf(sightings, `lens.${name}`, `${version}@${level}`);
	},
	verification: (payload) => {
		const refused = shape(verificationPayloadSchema, payload);
		if (refused !== undefined) return refused;
		const { claims, dismissals, check } = payload as VerificationPayload;
		if (check !== null && check.name !== "verifier") return "holds the check of another check than the verifier";
		// A claim's verification ran under the verifier, so its version is the verifier's.
		const stamped = claims.findIndex((claim) => !verifierVersion.test(claim.verification.version));
		if (stamped !== -1)
			return `names a version at /claims/${stamped}/verification/version that is not the verifier's`;
		const unwritten =
			decidedVersion(check, "/check/version") ??
			claims.map((claim, index) => namedSource(claim.source, `/claims/${index}/source/version`)).find(Boolean);
		if (unwritten !== undefined) return unwritten;
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
	account: (payload) => {
		const legacy = typeof payload === "object" && payload !== null && "v" in payload && payload.v === 1;
		const refused = shape(legacy ? legacyAccountPayloadSchema : accountPayloadSchema, payload);
		if (refused !== undefined) return refused;
		const { checks, records, filled, allowSkip, producers } = payload as AccountPayload | LegacyAccountPayload;
		const unwritten = [
			...filled.map((each, index) => decidedVersion(each, `/filled/${index}/version`)),
			...producers.map((each, index) => namedSource(each, `/producers/${index}/version`)),
		].find(Boolean);
		if (unwritten !== undefined) return unwritten;
		if (new Set(checks).size !== checks.length) return "names one check twice";
		if (!ordered(records, byText)) return "lists its records out of ID order, or one twice";
		if (!ordered(filled, (a, b) => byText(a.name, b.name) || byText(canonicalJson(a), canonicalJson(b))))
			return "fills its checks out of order, or one twice";
		if (!ordered(allowSkip, byText)) return "lists the skips it allows out of order, or one twice";
		const source = (each: (typeof producers)[number]) => `${each.check}@${each.version ?? ""}`;
		if (!ordered(producers, (a, b) => byText(a.check, b.check) || byText(source(a), source(b))))
			return "lists its producers out of order, or one twice";
		const unordered = producers.findIndex(({ ids }) => ids !== null && !ordered(ids, byText));
		if (unordered !== -1) return `keeps the findings at /producers/${unordered}/ids out of order, or one twice`;
		return undefined;
	},
	dismissal: (payload) => {
		const refused = shape(dismissalPayloadSchema, payload);
		if (refused !== undefined) return refused;
		const { at, sighting, head } = payload as DismissalPayload;
		const stamped = new Date(at);
		if (Number.isNaN(stamped.getTime()) || stamped.toISOString() !== at)
			return "holds an `at` that is not a time as Melian stamps one";
		if (sighting.revision.split("..")[1] !== head) return "names a head that is not its sighting's revision's";
		const parsed = finding(sighting.finding, "/sighting/finding");
		if (typeof parsed === "string") return parsed;
		const { check, version } = parsed.properties.source;
		return namedSource({ check, version: version ?? null }, "/sighting/finding/properties/source/version");
	},
};
