import { createHash } from "node:crypto";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { type Resolution, resolutionSchema, type Severity, severitySchema } from "./config.ts";
import { FindingError } from "./errors.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const line = Type.Integer({ minimum: 1 });
const count = Type.Integer({ minimum: 0 });
const idSchema = Type.String({ pattern: "^[0-9a-f]{16}$" });

/** The `partialFingerprints` key under which a SARIF result carries Melian's stable ID. */
export const fingerprintKey = "melian/v1";

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
	{
		file: text,
		index: count,
		snippet: Type.Optional(Type.String()),
		hash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
	},
	strict,
);

/** The JSON Schema of a {@link FindingExplanation}. */
export const findingExplanationSchema = Type.Object({ what: text, whyHere: text, whatToDo: text }, strict);

/** The JSON Schema of an {@link EvidenceRole}. */
export const evidenceRoleSchema = Type.Union([Type.Literal("cause"), Type.Literal("context")]);

/** The JSON Schema of an {@link EvidenceRevision}. */
export const evidenceRevisionSchema = Type.Union([Type.Literal("head"), Type.Literal("base")]);

/** The JSON Schema of an {@link EvidenceLocation}. */
export const evidenceLocationSchema = Type.Object(
	{
		file: text,
		startLine: line,
		endLine: Type.Optional(line),
		role: evidenceRoleSchema,
		revision: evidenceRevisionSchema,
		deleted: Type.Optional(Type.Literal(true)),
		proves: Type.Optional(Type.Literal(true)),
		snippet: text,
	},
	strict,
);

/** The JSON Schema of {@link FindingEvidence}. */
export const findingEvidenceSchema = Type.Array(evidenceLocationSchema, { minItems: 1 });

/** The JSON Schema of a {@link FindingSource}. */
export const findingSourceSchema = Type.Object({ check: text, version: Type.Optional(text) }, strict);

/** The JSON Schema of an {@link AlsoReportedAs}. */
export const alsoReportedAsSchema = Type.Object({ id: idSchema, ruleId: text, check: text }, strict);

/** The JSON Schema of a {@link MemberClaim}. */
export const memberClaimSchema = Type.Object(
	{
		id: idSchema,
		ruleId: text,
		source: findingSourceSchema,
		failureScenario: Type.Optional(text),
		evidence: Type.Optional(findingEvidenceSchema),
	},
	strict,
);

/** The JSON Schema of a {@link FindingDismissal}. */
export const findingDismissalSchema = Type.Object({ by: text, reason: text, at: text }, strict);

/** The JSON Schema of a {@link PastDismissal}. */
export const pastDismissalSchema = Type.Object(
	{
		by: Type.String(),
		reason: Type.String(),
		at: Type.String(),
		reopenedRevision: Type.Optional(text),
		replacedAt: Type.Optional(text),
	},
	strict,
);

/** The JSON Schema of {@link FindingProperties}. Unknown keys are rejected, so a misspelt optional key is not lost. */
export const findingPropertiesSchema = Type.Object(
	{
		id: idSchema,
		path: text,
		occurrence: Type.Optional(count),
		discriminator: Type.Optional(text),
		cause: causeSchema,
		failureScenario: Type.Optional(text),
		evidence: Type.Optional(findingEvidenceSchema),
		trigger: Type.Optional(findingTriggerSchema),
		severity: severitySchema,
		confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		resolution: Type.Optional(resolutionSchema),
		status: findingStatusSchema,
		dismissal: Type.Optional(findingDismissalSchema),
		pastDismissals: Type.Optional(Type.Array(pastDismissalSchema)),
		explanation: findingExplanationSchema,
		source: findingSourceSchema,
		reportedBy: Type.Optional(Type.Array(findingSourceSchema, { minItems: 1 })),
		alsoReportedAs: Type.Optional(Type.Array(alsoReportedAsSchema)),
		otherClaims: Type.Optional(Type.Array(memberClaimSchema)),
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
		partialFingerprints: Type.Object({ [fingerprintKey]: idSchema }, strict),
		properties: findingPropertiesSchema,
	},
	strict,
);

const logResultSchema = Type.Object({ ...findingSchema.properties, ruleIndex: count }, strict);

/** The longest reason a dismissal may give, in UTF-16 code units. */
export const maxDismissalReasonLength = 1000;

/** The longest failure scenario a lens may report, in UTF-16 code units. */
export const maxFailureScenarioLength = 2000;

/** The most evidence locations one finding may carry. */
export const maxEvidenceLocations = 10;

/** The most lines one evidence location may span, so it names the code that matters rather than a whole file. */
export const maxEvidenceLines = 60;

/** The most bytes of UTF-8 a snippet a lens finding stores may hold, the cut marker included. */
export const maxSnippetBytes = 2048;

const encoder = new TextEncoder();

const cutMarker = " [cut at 2 KiB]";

/**
 * A snippet as a finding stores it, for display: the snippet itself when its UTF-8 fits in {@link maxSnippetBytes};
 * otherwise its longest prefix that ends on a character boundary and leaves room for the marker ` [cut at 2 KiB]`, then
 * the marker. One long line repeated across a finding's locations then stores kilobytes, not megabytes. Identity never
 * reads the cut copy: a finding's ID and its trigger's {@link snippetHash} come from the whole snippet.
 */
export function capSnippet(snippet: string): string {
	if (Buffer.byteLength(snippet) <= maxSnippetBytes) return snippet;
	const { read } = encoder.encodeInto(snippet, new Uint8Array(maxSnippetBytes - cutMarker.length));
	return `${snippet.slice(0, read)}${cutMarker}`;
}

// Whether `text` is a snippet capSnippet cut, so the whole snippet its finding's ID came from is gone. A cut leaves at
// most three bytes of the cap unused, since no character is longer than four.
export function wasCut(text: string): boolean {
	return text.endsWith(cutMarker) && Buffer.byteLength(text) > maxSnippetBytes - 4;
}

/**
 * The JSON Schema of a {@link ReportFindingInput}: what a lens supplies through its `report_finding` tool, and nothing
 * else. Melian derives the rest of the finding.
 */
export const reportFindingInputSchema = Type.Object(
	{
		file: Type.String({ minLength: 1, description: "Repository-relative path of the flagged file at head" }),
		line: Type.Integer({ minimum: 1, description: "First flagged line at head" }),
		endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last flagged line at head" })),
		rule: Type.String({ minLength: 1, description: "One of the rules this lens declares" }),
		severity: severitySchema,
		explanation: Type.Object(
			{
				what: Type.String({ minLength: 1, description: "What is wrong" }),
				why: Type.String({ minLength: 1, description: "Why it matters in this change" }),
				fix: Type.String({ minLength: 1, description: "What the author should do" }),
			},
			strict,
		),
		failureScenario: Type.String({
			minLength: 1,
			maxLength: maxFailureScenarioLength,
			pattern: "\\S",
			description:
				"The concrete input, state, or sequence of calls that makes the code fail, and the wrong outcome it produces. Prose",
		}),
		evidence: Type.Array(
			Type.Object(
				{
					file: Type.String({ minLength: 1, description: "Repository-relative path at the named revision" }),
					line: Type.Integer({ minimum: 1, description: "First line at the named revision" }),
					endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last line at the named revision" })),
					role: Type.Union([Type.Literal("cause"), Type.Literal("context")], {
						description:
							"cause: the code that brings the failure about; context: code the claim reads but does not blame",
					}),
					revision: Type.Optional(
						Type.Union([Type.Literal("head"), Type.Literal("base")], {
							description: "head by default; base for lines this change deleted, read from the base commit",
						}),
					),
				},
				strict,
			),
			{
				minItems: 1,
				maxItems: maxEvidenceLocations,
				description:
					"The code the claim rests on, as locations, never prose. A finding outside the change is caused by it only when a cause location overlaps lines the change added, modified, or deleted, or names a file it renamed without editing, unless it only moved the finding's own file",
			},
		),
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
								{
									name: Type.Literal("Melian"),
									informationUri: Type.Optional(Type.String()),
									rules: Type.Array(Type.Object({ id: text }, strict)),
								},
								strict,
							),
						},
						strict,
					),
					results: Type.Array(logResultSchema),
				},
				strict,
			),
			{ minItems: 1, maxItems: 1 },
		),
	},
	strict,
);

/**
 * What a lens reports for one finding: a location, a rule from those the lens declares, a severity, an explanation, a
 * failure scenario, and evidence locations. Melian derives the rest so that a finding's identity never depends on the
 * model's wording: the snippet is read from the head revision at the reported lines, never taken from the model, and
 * each evidence location's snippet from the revision it names; `source` is the lens and its version; `cause` is
 * {@link classifyCause} of the location and its evidence; `resolution` comes from configuration; and `status` from the
 * findings document. {@link FindingInput} is the full internal input.
 */
export type ReportFindingInput = Static<typeof reportFindingInputSchema>;

/** A SARIF `level`. */
export type SarifLevel = Static<typeof sarifLevelSchema>;

/**
 * Why a finding is in scope.
 *
 * - `introduced`: in the code the changeset added or changed. Can block.
 * - `affected`: outside the changed code, but broken by it, as a `cause` location in `properties.evidence` shows. Can
 *   block.
 * - `pre-existing`: outside the changed code and not shown to be caused by it. Never blocks.
 */
export type Cause = Static<typeof causeSchema>;

/** The causes a location alone can prove. Only evidence makes a finding `affected`. */
export type LocationCause = Exclude<Cause, "affected">;

/** Where a finding stands across revisions. Melian assigns `new`, and `dismissed` once someone dismisses it. */
export type FindingStatus = Static<typeof findingStatusSchema>;

/**
 * The diff hunk that caused a finding, named as a {@link Hunk} names itself: its `file` and its `index` within that
 * file. `snippet` is the changed code as the producer saw it, perhaps cut for storage; `hash`, when present, is the
 * {@link snippetHash} of that code whole. A dismissed finding reopens when the whole code's {@link normaliseSnippet}
 * changes, not when the hunk moves.
 */
export type FindingTrigger = Static<typeof findingTriggerSchema>;

/** What an evidence location says about its lines: `cause` blames them for the failure, `context` only reads them. */
export type EvidenceRole = Static<typeof evidenceRoleSchema>;

/** Which commit an evidence location's lines are read from: the head, or the base for lines the change deleted. */
export type EvidenceRevision = Static<typeof evidenceRevisionSchema>;

/**
 * Lines a finding's claim rests on, at the head or the base, with the role they play and `snippet` read from that
 * revision at those lines, never written by the producer. A `cause` location overlapping the change is what makes a
 * finding outside the diff `affected`. `deleted` marks a base location whose lines the change deleted or replaced, or
 * whose file it renamed without editing when it did not only move the finding's own file, as Melian found when it
 * read the location; a base location without it names code the change left alone. `proves` marks a `cause` location
 * that overlaps the change by {@link causeOverlap}, the location that makes the finding `affected`, so a merge can keep
 * it when it must cut others.
 */
export type EvidenceLocation = Static<typeof evidenceLocationSchema>;

/** A finding's evidence: one or more {@link EvidenceLocation}s. */
export type FindingEvidence = Static<typeof findingEvidenceSchema>;

/**
 * Who dismissed a finding, why, and when, as an ISO 8601 timestamp. Present on a finding whose status is `dismissed`.
 * `by` is whoever the host says dismissed it; the CLI records the git author.
 */
export type FindingDismissal = Static<typeof findingDismissalSchema>;

/**
 * A dismissal that no longer stands, kept so its reason is not lost: `reopenedRevision` names the revision whose
 * trigger changed materially and reopened the finding, and `replacedAt` the time a later dismissal replaced it.
 */
export type PastDismissal = Static<typeof pastDismissalSchema>;

/**
 * A dismissal's reason without surrounding whitespace. Throws {@link FindingError} `invalidDismissal` when it is blank
 * or longer than {@link maxDismissalReasonLength}.
 */
export function dismissalReason(reason: string): string {
	const trimmed = reason.trim();
	if (trimmed === "") {
		throw new FindingError("invalidDismissal", "a dismissal needs a reason", {
			path: "/properties/dismissal/reason",
		});
	}
	if (trimmed.length > maxDismissalReasonLength) {
		throw new FindingError(
			"invalidDismissal",
			`a dismissal's reason is ${trimmed.length} characters; the most is ${maxDismissalReasonLength}`,
			{ path: "/properties/dismissal/reason" },
		);
	}
	return trimmed;
}

/** A finding's explanation for the author: what is wrong, why it matters in this change, and what to do. */
export type FindingExplanation = Static<typeof findingExplanationSchema>;

/** The check that produced a finding, and the version of the lens or question set it ran. */
export type FindingSource = Static<typeof findingSourceSchema>;

/** A finding adjudication merged into another: its ID, its rule, and the check that reported it. */
export type AlsoReportedAs = Static<typeof alsoReportedAsSchema>;

/**
 * The claim of a finding or sighting merged into another, kept whole beside the speaker's in
 * `properties.otherClaims`: who made it, and its own failure scenario and evidence, so a verifier judges each claim
 * with its own proof.
 */
export type MemberClaim = Static<typeof memberClaimSchema>;

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

/**
 * A SARIF 2.1.0 log of one Melian run. The driver lists each rule once, and each result names its rule by `ruleIndex`
 * as well as `ruleId`, which GitHub code scanning reads for rule metadata.
 */
export type FindingsLog = Static<typeof findingsLogSchema>;

// The repository-relative posix form of a path: `./src//run.ts` becomes `src/run.ts`. Refuses what is not one.
export function canonicalPath(path: string, pointer = "/properties/path"): string {
	const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
	const problem = path.startsWith("/")
		? "is absolute"
		: path.includes("\\")
			? "uses a backslash; use forward slashes"
			: segments.includes("..")
				? "escapes the repository"
				: segments.length === 0
					? "names no file"
					: path.isWellFormed()
						? undefined
						: "is not well-formed Unicode";
	if (problem !== undefined) {
		throw new FindingError("invalidPath", `${JSON.stringify(path)} ${problem}`, { path: pointer });
	}
	return segments.join("/");
}

// Percent-encodes each segment of a canonical path; decodeURIComponent on each segment reverses it.
function repositoryUri(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function requireCanonical(path: string, pointer: string): void {
	if (canonicalPath(path, pointer) !== path) {
		throw new FindingError("invalidPath", `${JSON.stringify(path)} is not in canonical form`, { path: pointer });
	}
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

const word = /[\p{L}\p{M}\p{N}_$]/u;

// Normalises like normaliseSnippet, and records for each output code unit the source offset it came from.
function normaliseWithOffsets(source: string): { text: string; offsets: number[] } {
	let text = "";
	const offsets: number[] = [];
	let space = false;
	let previous = "";
	for (let index = 0; index < source.length; ) {
		const char = String.fromCodePoint(source.codePointAt(index)!);
		if (/\s/u.test(char)) {
			space = true;
		} else {
			if (space && word.test(previous) && word.test(char)) {
				text += " ";
				offsets.push(index);
			}
			text += char;
			for (let unit = 0; unit < char.length; unit++) offsets.push(index + unit);
			space = false;
			previous = char;
		}
		index += char.length;
	}
	return { text, offsets };
}

/**
 * The form of a snippet that {@link findingId} hashes: all whitespace removed, except that a run of whitespace between
 * two word characters (letters, marks, digits, `_`, and `$`) becomes one space. Two snippets that normalise alike are
 * the same code, so `foo(a, b)` and the same call wrapped one argument per line are one snippet, while `return x` keeps
 * its space.
 */
export function normaliseSnippet(snippet: string): string {
	return normaliseWithOffsets(snippet).text;
}

/** The sha256, in hex, of {@link normaliseSnippet} of `snippet`: two snippets that normalise alike hash alike. */
export function snippetHash(snippet: string): string {
	return createHash("sha256").update(normaliseSnippet(snippet)).digest("hex");
}

/**
 * The stable ID of a finding: the first 16 hex characters of a sha256 over the length-prefixed file, rule,
 * {@link normaliseSnippet} of the snippet, and the occurrence or discriminator.
 *
 * Line numbers are not an input, so a finding keeps its ID when an edit above it shifts its lines, or when a formatter
 * reindents or rewraps the flagged code. Changing one token of the flagged code, such as `eval(input)` to `eval(body)`,
 * changes the ID, and so does moving the code to another file or reporting it under another rule. Inserting an
 * identical snippet earlier in the file renumbers the occurrences after it.
 *
 * Throws {@link FindingError} `missingDiscriminator` when a finding with a snippet has no occurrence, or one without a
 * snippet has no discriminator.
 */
export function findingId({ file, rule, snippet, occurrence, discriminator }: FindingIdInput): string {
	const normalised = normaliseSnippet(snippet);
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
	// Length-prefixed, so no character inside a field, NUL included, can move text from one field to the next.
	const input = [file, rule, normalised, distinguisher].map((field) => `${field.length}:${field}`).join("");
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
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
	const target = normaliseSnippet(snippet);
	const { text, offsets } = normaliseWithOffsets(source);
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
	/** The flagged code, whole, as it appears at head. Part of the ID; the finding stores it cut by {@link capSnippet}. */
	readonly snippet?: string;
	/** Required with a snippet: its ordinal among identical snippets in the file, from {@link snippetOccurrence}. */
	readonly occurrence?: number;
	/** Required without a snippet: what tells this finding apart, such as the enclosing symbol or the hunk index. */
	readonly discriminator?: string;
	/**
	 * Usually {@link classifyCause} of the location and its evidence. `affected` needs a `cause` location in `evidence`;
	 * this function cannot see the change, so the caller confirms that location overlaps it.
	 */
	readonly cause: Cause;
	/** The input, state, or sequence that makes the code fail, and the wrong outcome. Every lens finding has one. */
	readonly failureScenario?: string;
	/** The code the claim rests on. Every lens finding has some; a static or guardrail finding has none. */
	readonly evidence?: FindingEvidence;
	readonly trigger?: FindingTrigger;
	readonly severity: Severity;
	readonly confidence?: number;
	/** What the finding requires. Only adjudication sets it; a producer leaves it out, and the finding is unresolved. */
	readonly resolution?: Resolution;
	/** Defaults to `new`. */
	readonly status?: FindingStatus;
	readonly explanation: FindingExplanation;
	readonly source: FindingSource;
}

// A JSON round trip drops undefined-valued keys; dropping them first keeps a finding equal to its stored copy.
function withoutUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutUndefined);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, each]) => each !== undefined)
			.map(([key, each]) => [key, withoutUndefined(each)]),
	);
}

/**
 * Builds a finding, deriving its level, ID, and URI from the canonical repository-relative form of its file, so
 * `./src/run.ts` and `src/run.ts` are one file. The ID comes from the whole snippet, and the finding stores it cut by
 * {@link capSnippet}. Throws {@link FindingError}: `invalidPath` when the file is absolute,
 * escapes the repository, or uses a backslash, `invalidRegion` when the region ends before it starts, `missingDiscriminator` when a finding with a
 * snippet has no occurrence or one without a snippet has no discriminator, and `invalidFinding` if the result is invalid.
 */
export function createFinding(input: FindingInput): Finding {
	const { rule, snippet, occurrence, discriminator } = input;
	const file = canonicalPath(input.file);
	const trigger =
		input.trigger === undefined
			? undefined
			: { ...input.trigger, file: canonicalPath(input.trigger.file, "/properties/trigger/file") };
	const id = findingId({ file, rule, snippet: snippet ?? "", occurrence, discriminator });
	const hasSnippet = normaliseSnippet(snippet ?? "") !== "";
	const evidence = input.evidence?.map((location, index) => ({
		...location,
		file: canonicalPath(location.file, `/properties/evidence/${index}/file`),
	}));
	return parseFinding({
		ruleId: rule,
		level: levelForSeverity(input.severity),
		message: { text: input.message },
		partialFingerprints: { [fingerprintKey]: id },
		locations: [
			{
				physicalLocation: {
					artifactLocation: { uri: repositoryUri(file) },
					region: {
						startLine: input.startLine,
						endLine: input.endLine,
						startColumn: input.startColumn,
						endColumn: input.endColumn,
						snippet: snippet === undefined ? undefined : { text: capSnippet(snippet) },
					},
				},
			},
		],
		properties: {
			id,
			path: file,
			occurrence: hasSnippet ? occurrence : undefined,
			discriminator: hasSnippet ? undefined : discriminator,
			cause: input.cause,
			failureScenario: input.failureScenario,
			evidence,
			trigger,
			severity: input.severity,
			confidence: input.confidence,
			resolution: input.resolution,
			status: input.status ?? "new",
			explanation: input.explanation,
			source: input.source,
		},
	});
}

/**
 * Checks that `input` is a valid finding and returns a copy without keys whose value is `undefined`, at any depth, so
 * the copy equals what a JSON round trip stores.
 *
 * Throws {@link FindingError}: `invalidFinding` when it does not match {@link findingSchema}, `levelMismatch` when its
 * level is not {@link levelForSeverity} of its severity, `invalidRegion` when its region ends before it starts,
 * `invalidPath` when its path is not canonical or its URI does
 * not encode that path, `missingEvidence` when it is `affected` without a `cause` evidence location,
 * `missingDiscriminator` when it lacks the occurrence or
 * discriminator its snippet calls for, and `idMismatch` when its ID is not {@link findingId} of its first location, which
 * it cannot tell for a snippet {@link capSnippet} cut.
 */
export function parseFinding(input: unknown): Finding {
	const value = withoutUndefined(input);
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
	const { startLine, endLine = startLine, startColumn, endColumn } = region;
	if (endLine < startLine || (endLine === startLine && (endColumn ?? Infinity) < (startColumn ?? 1))) {
		throw new FindingError("invalidRegion", "the finding's region ends before it starts", {
			path: "/locations/0/physicalLocation/region",
		});
	}
	requireCanonical(path, "/properties/path");
	if (artifactLocation.uri !== repositoryUri(path)) {
		throw new FindingError("invalidPath", `finding URI ${artifactLocation.uri} does not encode its path ${path}`, {
			path: "/locations/0/physicalLocation/artifactLocation/uri",
		});
	}
	if (trigger !== undefined) requireCanonical(trigger.file, "/properties/trigger/file");
	const { cause, evidence = [] } = finding.properties;
	if (cause === "affected" && !evidence.some((location) => location.role === "cause")) {
		throw new FindingError(
			"missingEvidence",
			"an affected finding must cite, as a cause, the change that breaks it",
			{
				path: "/properties/evidence",
			},
		);
	}
	const cited = [
		{ at: "/properties/evidence", locations: evidence },
		...(finding.properties.otherClaims ?? []).map((claim, index) => ({
			at: `/properties/otherClaims/${index}/evidence`,
			locations: claim.evidence ?? [],
		})),
	];
	for (const { at, locations } of cited) {
		for (const [index, location] of locations.entries()) {
			requireCanonical(location.file, `${at}/${index}/file`);
			if ((location.endLine ?? location.startLine) < location.startLine) {
				throw new FindingError("invalidRegion", "an evidence location ends before it starts", {
					path: `${at}/${index}`,
				});
			}
		}
	}
	const snippet = region.snippet?.text ?? "";
	const { occurrence, discriminator } = finding.properties;
	const extra = normaliseSnippet(snippet) === "" ? occurrence : discriminator;
	if (extra !== undefined) {
		const key = normaliseSnippet(snippet) === "" ? "occurrence" : "discriminator";
		throw new FindingError("invalidFinding", `finding has a ${key} its snippet does not call for`, {
			path: `/properties/${key}`,
		});
	}
	// A cut snippet no longer holds the code its ID came from, so only an uncut one can be checked against it.
	const expected = wasCut(snippet)
		? id
		: findingId({ file: path, rule: finding.ruleId, snippet, occurrence, discriminator });
	if (id !== expected) {
		throw new FindingError("idMismatch", `finding ${id} should have ID ${expected}`, { path: "/properties/id" });
	}
	if (finding.partialFingerprints[fingerprintKey] !== id) {
		throw new FindingError("idMismatch", `finding ${id} has a different ${fingerprintKey} fingerprint`, {
			path: "/partialFingerprints/melian~1v1",
		});
	}
	return finding;
}

/** Wraps findings in a SARIF 2.1.0 log of one Melian run, listing each rule once in the driver. */
export function createFindingsLog(findings: readonly Finding[]): FindingsLog {
	const rules = [...new Set(findings.map((finding) => finding.ruleId))].sort();
	return {
		$schema: sarifSchemaUri,
		version: "2.1.0",
		runs: [
			{
				tool: {
					driver: {
						name: "Melian",
						informationUri: "https://github.com/melian-agent/melian",
						rules: rules.map((id) => ({ id })),
					},
				},
				results: findings.map(({ ruleId, ...rest }) => ({ ruleId, ruleIndex: rules.indexOf(ruleId), ...rest })),
			},
		],
	};
}

/**
 * A finding stored before evidence became a list, in the current shape. Its single evidence location, which only an
 * `affected` finding carried, becomes a one-entry list naming the location a `cause` at head. A finding from before
 * failure scenarios has none, which the schema allows. Anything else comes back unchanged. A stored document that holds
 * findings calls this when it migrates, so a review recorded before the change still reads, renders, and publishes.
 */
export function upgradeStoredFinding<T>(finding: T): T {
	const properties = (finding as { properties?: { evidence?: unknown } } | null)?.properties;
	const evidence = properties?.evidence;
	if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) return finding;
	const location = { ...evidence, role: "cause", revision: "head" };
	return { ...finding, properties: { ...properties, evidence: [location] } };
}
