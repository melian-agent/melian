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
		path: text,
		occurrence: Type.Optional(count),
		discriminator: Type.Optional(text),
		cause: causeSchema,
		evidence: Type.Optional(text),
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

const region = Type.Object(
	{
		startLine: line,
		endLine: Type.Optional(line),
		startColumn: Type.Optional(line),
		endColumn: Type.Optional(line),
		snippet: Type.Optional(Type.Object({ text: Type.String() }, strict)),
	},
	strict,
);

/** The JSON Schema of a {@link FindingLocation}: a SARIF `location` with a physical location. */
export const findingLocationSchema = Type.Object(
	{
		physicalLocation: Type.Object({ artifactLocation: Type.Object({ uri: text }, strict), region }, strict),
	},
	strict,
);

/**
 * The JSON Schema of a {@link Finding}: a SARIF 2.1.0 `result` with Melian's extensions in its property bag. Every
 * object lists the SARIF members Melian supports and rejects any other, so a result from outside cannot smuggle data
 * into storage.
 */
export const findingSchema = Type.Object(
	{
		ruleId: text,
		level: sarifLevelSchema,
		message: Type.Object({ text }, strict),
		locations: Type.Array(findingLocationSchema, { minItems: 1 }),
		properties: findingPropertiesSchema,
	},
	strict,
);

/** The URI of the SARIF 2.1.0 JSON Schema, as `$schema` in a {@link FindingsLog}. */
export const sarifSchemaUri = "https://json.schemastore.org/sarif-2.1.0.json";

/** The JSON Schema of a {@link FindingsLog}. */
export const findingsLogSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		version: Type.Literal("2.1.0"),
		runs: Type.Array(
			Type.Object(
				{
					tool: Type.Object(
						{
							driver: Type.Object(
								{ name: Type.Literal("Melian"), informationUri: Type.Optional(Type.String()) },
								strict,
							),
						},
						strict,
					),
					results: Type.Array(findingSchema),
				},
				strict,
			),
			{ minItems: 1, maxItems: 1 },
		),
	},
	strict,
);

/** A SARIF `level`. */
export type SarifLevel = Static<typeof sarifLevelSchema>;

/**
 * Why a finding is in scope.
 *
 * - `introduced`: in the code the changeset added or changed. Can block.
 * - `affected`: outside the changed code, but broken by it, as `properties.evidence` shows. Can block.
 * - `pre-existing`: outside the changed code and not shown to be caused by it. Never blocks.
 */
export type Cause = Static<typeof causeSchema>;

/** The causes a location alone can prove. Only evidence makes a finding `affected`. */
export type LocationCause = Exclude<Cause, "affected">;

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

/** Where a finding points: a file, as a URI relative to the repository root, and a line region, with an optional snippet. */
export type FindingLocation = Static<typeof findingLocationSchema>;

/**
 * One objection, as a SARIF 2.1.0 `result`.
 *
 * `level` follows `properties.severity` by {@link levelForSeverity}, and `properties.id` is {@link findingId} of the
 * first location's file, the rule, that location's snippet, and `properties.occurrence` or `properties.discriminator`. {@link createFinding} derives both, and
 * {@link parseFinding} rejects a finding where either disagrees.
 */
export type Finding = Static<typeof findingSchema>;

/** A SARIF 2.1.0 log of one Melian run. */
export type FindingsLog = Static<typeof findingsLogSchema>;

// Percent-encodes each segment; decodeURIComponent on each segment reverses it.
function repositoryUri(path: string, pointer = "/properties/path"): string {
	const segments = path.split("/");
	const problem =
		path === ""
			? "is empty"
			: segments[0] === ""
				? "is absolute"
				: segments.includes("..")
					? "escapes the repository"
					: path.isWellFormed()
						? undefined
						: "is not well-formed Unicode";
	if (problem !== undefined) {
		throw new FindingError("invalidPath", `${JSON.stringify(path)} ${problem}`, { path: pointer });
	}
	return segments.map(encodeURIComponent).join("/");
}

/** What a finding's stable ID is computed from. */
export interface FindingIdInput {
	/** The repository-relative path, with forward slashes. */
	readonly file: string;
	readonly rule: string;
	/** The flagged code, or empty when the finding has none. Whitespace is collapsed before hashing. */
	readonly snippet: string;
	/**
	 * With a snippet: the zero-based ordinal of this snippet among identical normalised snippets in the file at head,
	 * in line order. {@link snippetOccurrence} counts it.
	 */
	readonly occurrence?: number;
	/**
	 * Without a snippet: what tells this finding apart from others with the same file and rule, such as the enclosing
	 * symbol or the hunk index.
	 */
	readonly discriminator?: string;
}

function normalise(snippet: string): string {
	return snippet.trim().replace(/\s+/g, " ");
}

/**
 * The stable ID of a finding: the first 16 hex characters of a sha256 over the file, the rule, the snippet with
 * leading and trailing whitespace removed and every run of whitespace collapsed to one space, and the occurrence or
 * discriminator.
 *
 * Line numbers are not an input, so a finding keeps its ID when an edit above it shifts its lines, or when the flagged
 * code is reindented or rewrapped. Changing one token of the flagged code, such as `eval(input)` to `eval(body)`,
 * changes the ID, and so does moving the code to another file or reporting it under another rule. Inserting an
 * identical snippet earlier in the file renumbers the occurrences after it.
 *
 * Throws {@link FindingError} `missingDiscriminator` when a finding with a snippet has no occurrence, or one without a
 * snippet has no discriminator.
 */
export function findingId({ file, rule, snippet, occurrence, discriminator }: FindingIdInput): string {
	const normalised = normalise(snippet);
	let distinguisher: string;
	if (normalised !== "") {
		if (occurrence === undefined || !Number.isInteger(occurrence) || occurrence < 0) {
			throw new FindingError("missingDiscriminator", "a finding with a snippet needs its occurrence in the file", {
				path: "/properties/occurrence",
			});
		}
		distinguisher = String(occurrence);
	} else {
		if (discriminator === undefined || discriminator === "") {
			throw new FindingError("missingDiscriminator", "a finding without a snippet needs a discriminator", {
				path: "/properties/discriminator",
			});
		}
		distinguisher = discriminator;
	}
	return createHash("sha256").update([file, rule, normalised, distinguisher].join("\0")).digest("hex").slice(0, 16);
}

/** Where a snippet sits in a file: its first line and, optionally, its first column and last line. 1-based. */
export interface SnippetRegion {
	readonly startLine: number;
	readonly startColumn?: number;
	readonly endLine?: number;
}

function lineStarts(source: string): number[] {
	const starts = [0];
	for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) starts.push(index + 1);
	return starts;
}

/**
 * The zero-based ordinal of the snippet at `region` among identical normalised snippets in `source`, the file's text at
 * head, counted in line order. This is a finding's `occurrence`.
 *
 * Throws {@link FindingError} `snippetNotFound` when the snippet is empty or does not start inside the region.
 */
export function snippetOccurrence(source: string, snippet: string, region: SnippetRegion): number {
	const target = normalise(snippet);
	const chars: string[] = [];
	const offsets: number[] = [];
	let space = false;
	for (let index = 0; index < source.length; index++) {
		const char = source[index]!;
		if (/\s/.test(char)) {
			space = chars.length > 0;
			continue;
		}
		if (space) {
			chars.push(" ");
			offsets.push(index);
			space = false;
		}
		chars.push(char);
		offsets.push(index);
	}
	const text = chars.join("");
	const starts = lineStarts(source);
	const from = (starts[region.startLine - 1] ?? source.length) + (region.startColumn ?? 1) - 1;
	const last = region.endLine ?? region.startLine;
	const until = starts[last] ?? source.length + 1;
	let ordinal = 0;
	for (let match = target === "" ? -1 : text.indexOf(target); match !== -1; match = text.indexOf(target, match + 1)) {
		const offset = offsets[match]!;
		if (offset >= until) break;
		if (offset >= from) return ordinal;
		ordinal++;
	}
	throw new FindingError("snippetNotFound", `the snippet does not start on lines ${region.startLine}-${last}`, {
		path: "/locations/0/physicalLocation/region/snippet",
	});
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
	/** The flagged code, as it appears at head. Part of the ID. */
	readonly snippet?: string;
	/** Required with a snippet: its ordinal among identical snippets in the file, from {@link snippetOccurrence}. */
	readonly occurrence?: number;
	/** Required without a snippet: what tells this finding apart, such as the enclosing symbol or the hunk index. */
	readonly discriminator?: string;
	/**
	 * `introduced` or `pre-existing`, usually from {@link classifyCause}, or `{ evidence }` for an `affected` finding:
	 * the changed code that provably breaks this location, as the lens cites it.
	 */
	readonly cause: LocationCause | { readonly evidence: string };
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

/**
 * Builds a finding, deriving its level, ID, and URI. Throws {@link FindingError}: `invalidPath` when the file is
 * absolute or escapes the repository, `missingDiscriminator` when a finding with a
 * snippet has no occurrence or one without a snippet has no discriminator, and `invalidFinding` if the result is invalid.
 */
export function createFinding(input: FindingInput): Finding {
	const { file, rule, snippet, occurrence, discriminator } = input;
	const id = findingId({ file, rule, snippet: snippet ?? "", occurrence, discriminator });
	const hasSnippet = normalise(snippet ?? "") !== "";
	const evidence = typeof input.cause === "object" ? input.cause.evidence : undefined;
	return parseFinding({
		ruleId: rule,
		level: levelForSeverity(input.severity),
		message: { text: input.message },
		locations: [
			{
				physicalLocation: {
					artifactLocation: { uri: repositoryUri(file) },
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
			id,
			path: file,
			occurrence: hasSnippet ? occurrence : undefined,
			discriminator: hasSnippet ? undefined : discriminator,
			cause: evidence === undefined ? input.cause : "affected",
			evidence,
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
 * level is not {@link levelForSeverity} of its severity, `invalidPath` when its path is absolute or escapes the
 * repository or its URI does not encode that path, `missingEvidence` when it is `affected` without evidence,
 * `missingDiscriminator` when it lacks the occurrence or
 * discriminator its snippet calls for, and `idMismatch` when its ID is not {@link findingId} of its first location.
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
	const { path, trigger } = finding.properties;
	if (artifactLocation.uri !== repositoryUri(path)) {
		throw new FindingError("invalidPath", `finding URI ${artifactLocation.uri} does not encode its path ${path}`, {
			path: "/locations/0/physicalLocation/artifactLocation/uri",
		});
	}
	if (trigger !== undefined) repositoryUri(trigger.file, "/properties/trigger/file");
	const { cause, evidence } = finding.properties;
	if (cause === "affected" && evidence === undefined) {
		throw new FindingError("missingEvidence", "an affected finding must cite the change that breaks it", {
			path: "/properties/evidence",
		});
	}
	if (cause !== "affected" && evidence !== undefined) {
		throw new FindingError("invalidFinding", `an ${cause} finding carries evidence only an affected one needs`, {
			path: "/properties/evidence",
		});
	}
	const snippet = region.snippet?.text ?? "";
	const { occurrence, discriminator } = finding.properties;
	const extra = normalise(snippet) === "" ? occurrence : discriminator;
	if (extra !== undefined) {
		const key = normalise(snippet) === "" ? "occurrence" : "discriminator";
		throw new FindingError("invalidFinding", `finding has a ${key} its snippet does not call for`, {
			path: `/properties/${key}`,
		});
	}
	const expected = findingId({ file: path, rule: finding.ruleId, snippet, occurrence, discriminator });
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
