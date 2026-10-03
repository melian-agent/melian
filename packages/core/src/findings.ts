import { createHash } from "node:crypto";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { type Resolution, resolutionSchema, type Severity, severitySchema } from "./config.ts";
import { FindingError } from "./errors.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const line = Type.Integer({ minimum: 1 });
const count = Type.Integer({ minimum: 0 });

/** The JSON Schema of a SARIF `level`. Melian never emits `none`, which SARIF reserves for results that are not failures. */
export const sarifLevelSchema = Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("note")]);

/** The JSON Schema of a {@link Cause}. */
export const causeSchema = Type.Union([
	Type.Literal("introduced"),
	Type.Literal("affected"),
	Type.Literal("pre-existing"),
]);

/** The JSON Schema of a {@link FindingStatus}. */
export const findingStatusSchema = Type.Union([
	Type.Literal("new"),
	Type.Literal("open"),
	Type.Literal("resolved"),
	Type.Literal("dismissed"),
	Type.Literal("stale"),
]);

/** The JSON Schema of a {@link FindingTrigger}. */
export const findingTriggerSchema = Type.Object(
	{ file: text, oldStart: count, oldLines: count, newStart: count, newLines: count },
	strict,
);

/** The JSON Schema of a {@link FindingExplanation}. */
export const findingExplanationSchema = Type.Object({ what: text, whyHere: text, whatToDo: text }, strict);

/** The JSON Schema of a {@link FindingSource}. */
export const findingSourceSchema = Type.Object({ check: text, version: Type.Optional(text) }, strict);

/** The JSON Schema of {@link FindingProperties}. Unknown keys are rejected, so a misspelt optional key is not lost. */
export const findingPropertiesSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[0-9a-f]{16}$" }),
		cause: causeSchema,
		trigger: Type.Optional(findingTriggerSchema),
		severity: severitySchema,
		confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		resolution: resolutionSchema,
		status: findingStatusSchema,
		explanation: findingExplanationSchema,
		source: findingSourceSchema,
	},
	strict,
);

const region = Type.Object({
	startLine: line,
	endLine: Type.Optional(line),
	startColumn: Type.Optional(line),
	endColumn: Type.Optional(line),
	snippet: Type.Optional(Type.Object({ text: Type.String() })),
});

/** The JSON Schema of a {@link FindingLocation}: a SARIF `location` with a physical location. */
export const findingLocationSchema = Type.Object({
	physicalLocation: Type.Object({ artifactLocation: Type.Object({ uri: text }), region }),
});

/** The JSON Schema of a {@link Finding}: a SARIF 2.1.0 `result` with Melian's extensions in its property bag. */
export const findingSchema = Type.Object({
	ruleId: text,
	level: sarifLevelSchema,
	message: Type.Object({ text }),
	locations: Type.Array(findingLocationSchema, { minItems: 1 }),
	properties: findingPropertiesSchema,
});

/** The URI of the SARIF 2.1.0 JSON Schema, as `$schema` in a {@link FindingsLog}. */
export const sarifSchemaUri = "https://json.schemastore.org/sarif-2.1.0.json";

/** The JSON Schema of a {@link FindingsLog}. */
export const findingsLogSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	version: Type.Literal("2.1.0"),
	runs: Type.Array(
		Type.Object({
			tool: Type.Object({
				driver: Type.Object({ name: Type.Literal("Melian"), informationUri: Type.Optional(Type.String()) }),
			}),
			results: Type.Array(findingSchema),
		}),
		{ minItems: 1, maxItems: 1 },
	),
});

/** A SARIF `level`. */
export type SarifLevel = Static<typeof sarifLevelSchema>;

/**
 * Why a finding is in scope.
 *
 * - `introduced`: in the code the changeset added or changed. Can block.
 * - `affected`: outside the changed code, but broken by it. Can block.
 * - `pre-existing`: outside the changed code and not caused by it. Never blocks.
 */
export type Cause = Static<typeof causeSchema>;

/** Where a finding stands across revisions. Only `new` is assigned until cross-revision diffing exists. */
export type FindingStatus = Static<typeof findingStatusSchema>;

/** The diff hunk that caused a finding, in the file that hunk changed. Line ranges follow {@link Hunk}. */
export type FindingTrigger = Static<typeof findingTriggerSchema>;

/** A finding's explanation for the author: what is wrong, why it matters in this change, and what to do. */
export type FindingExplanation = Static<typeof findingExplanationSchema>;

/** The check that produced a finding, and the version of the lens or question set it ran. */
export type FindingSource = Static<typeof findingSourceSchema>;

/** Melian's extensions to a SARIF `result`, carried in its property bag. */
export type FindingProperties = Static<typeof findingPropertiesSchema>;

/** Where a finding points: a repository-relative file and a line region, with an optional snippet. */
export type FindingLocation = Static<typeof findingLocationSchema>;

/**
 * One objection, as a SARIF 2.1.0 `result`.
 *
 * `level` follows `properties.severity` by {@link levelForSeverity}, and `properties.id` is {@link findingId} of the
 * first location's file, the rule, and that location's snippet. {@link createFinding} derives both, and
 * {@link parseFinding} rejects a finding where either disagrees.
 */
export type Finding = Static<typeof findingSchema>;

/** A SARIF 2.1.0 log of one Melian run. */
export type FindingsLog = Static<typeof findingsLogSchema>;

/** What a finding's stable ID is computed from. */
export interface FindingIdInput {
	/** The repository-relative path, with forward slashes. */
	readonly file: string;
	readonly rule: string;
	/** The flagged code. Whitespace is collapsed before hashing. */
	readonly snippet: string;
}

/**
 * The stable ID of a finding: the first 16 hex characters of a sha256 over the file, the rule, and the snippet with
 * leading and trailing whitespace removed and every run of whitespace collapsed to one space.
 *
 * Line numbers are not an input, so a finding keeps its ID when an edit above it shifts its lines, or when the flagged
 * code is reindented or rewrapped. Changing one token of the flagged code, such as `eval(input)` to `eval(body)`,
 * changes the ID, and so does moving the code to another file or reporting it under another rule.
 */
export function findingId({ file, rule, snippet }: FindingIdInput): string {
	const normalised = snippet.trim().replace(/\s+/g, " ");
	return createHash("sha256").update([file, rule, normalised].join("\0")).digest("hex").slice(0, 16);
}

const levels: Readonly<Record<Severity, SarifLevel>> = {
	P0: "error",
	P1: "error",
	P2: "warning",
	P3: "note",
	nit: "note",
};

/**
 * The SARIF level for a severity: `P0` and `P1` are `error`, `P2` is `warning`, `P3` and `nit` are `note`.
 *
 * The mapping follows the default resolution, so a SARIF consumer such as GitHub code scanning shows blocking findings
 * as errors. It does not follow a repository's resolution configuration: the level says how serious a finding is, and
 * `properties.resolution` says what it requires.
 */
export function levelForSeverity(severity: Severity): SarifLevel {
	return levels[severity];
}

/** What {@link createFinding} builds a finding from. Optional fields are left out of the finding when absent. */
export interface FindingInput {
	readonly rule: string;
	readonly message: string;
	/** The repository-relative path, with forward slashes. */
	readonly file: string;
	readonly startLine: number;
	readonly endLine?: number;
	readonly startColumn?: number;
	readonly endColumn?: number;
	/** The flagged code, as it appears at head. Part of the ID; an absent snippet hashes as empty. */
	readonly snippet?: string;
	readonly cause: Cause;
	readonly trigger?: FindingTrigger;
	readonly severity: Severity;
	readonly confidence?: number;
	readonly resolution: Resolution;
	/** Defaults to `new`. */
	readonly status?: FindingStatus;
	readonly explanation: FindingExplanation;
	readonly source: FindingSource;
}

function defined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T;
}

/** Builds a finding, deriving its level and ID. Throws {@link FindingError} `invalidFinding` if the result is invalid. */
export function createFinding(input: FindingInput): Finding {
	const { file, rule, snippet } = input;
	return parseFinding({
		ruleId: rule,
		level: levelForSeverity(input.severity),
		message: { text: input.message },
		locations: [
			{
				physicalLocation: {
					artifactLocation: { uri: file },
					region: defined({
						startLine: input.startLine,
						endLine: input.endLine,
						startColumn: input.startColumn,
						endColumn: input.endColumn,
						snippet: snippet === undefined ? undefined : { text: snippet },
					}),
				},
			},
		],
		properties: defined({
			id: findingId({ file, rule, snippet: snippet ?? "" }),
			cause: input.cause,
			trigger: input.trigger,
			severity: input.severity,
			confidence: input.confidence,
			resolution: input.resolution,
			status: input.status ?? "new",
			explanation: input.explanation,
			source: input.source,
		}),
	});
}

/**
 * Checks that `value` is a valid finding and returns it.
 *
 * Throws {@link FindingError}: `invalidFinding` when it does not match {@link findingSchema}, `levelMismatch` when its
 * level is not {@link levelForSeverity} of its severity, and `idMismatch` when its ID is not {@link findingId} of its
 * first location.
 */
export function parseFinding(value: unknown): Finding {
	const errors = Value.Errors(findingSchema, value);
	const unknown = errors.find((error) => error.keyword === "additionalProperties");
	if (unknown !== undefined) {
		const [key] = (unknown.params as { additionalProperties: string[] }).additionalProperties;
		const path = `${unknown.instancePath}/${key}`;
		throw new FindingError("invalidFinding", `finding has an unknown key at ${path}`, { path });
	}
	const error = errors[0];
	if (error !== undefined) {
		const path = error.instancePath || "(top level)";
		throw new FindingError("invalidFinding", `finding ${path} ${error.message}`, { path: error.instancePath });
	}
	const finding = value as Finding;
	const { severity, id } = finding.properties;
	const level = levelForSeverity(severity);
	if (finding.level !== level) {
		throw new FindingError("levelMismatch", `a ${severity} finding has level ${level}, not ${finding.level}`, {
			path: "/level",
		});
	}
	const { artifactLocation, region } = finding.locations[0]!.physicalLocation;
	const expected = findingId({
		file: artifactLocation.uri,
		rule: finding.ruleId,
		snippet: region.snippet?.text ?? "",
	});
	if (id !== expected) {
		throw new FindingError("idMismatch", `finding ${id} should have ID ${expected}`, { path: "/properties/id" });
	}
	return finding;
}

/** Wraps findings in a SARIF 2.1.0 log of one Melian run. */
export function createFindingsLog(findings: readonly Finding[]): FindingsLog {
	return {
		$schema: sarifSchemaUri,
		version: "2.1.0",
		runs: [
			{
				tool: { driver: { name: "Melian", informationUri: "https://github.com/melian-agent/melian" } },
				results: [...findings],
			},
		],
	};
}
