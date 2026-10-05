import { createHash } from "node:crypto";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import type { Verdict } from "./adjudication.ts";
import { FindingError } from "./errors.ts";
import { canonicalPath, type Finding } from "./findings.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const line = Type.Integer({ minimum: 1 });
const count = Type.Integer({ minimum: 0 });
const idSchema = Type.String({ pattern: "^[0-9a-f]{16}$" });

/** The most characters an external finding's title keeps; a longer title, such as a thread's first line, is cut. */
export const maxExternalTitleLength = 200;

/** The most characters an external finding's body may hold: GitHub's own limit on a comment. */
export const maxExternalBodyLength = 65_536;

/** The most findings one file may hold. */
export const maxExternalFileFindings = 1_000;

/** How many lines apart an external finding and another may lie and still be one site. */
export const siteDistance = 3;

/** The reviewers Melian compares itself with. A reviewer on GitHub other than CodeRabbit is `human`, named by login. */
export const externalReviewerNameSchema = Type.Union([
	Type.Literal("codex"),
	Type.Literal("claude-code"),
	Type.Literal("coderabbit"),
	Type.Literal("human"),
]);

/** Who raised an external finding: the reviewer, its version where known, and its login on a code host. */
export const externalReviewerSchema = Type.Object(
	{ name: externalReviewerNameSchema, version: Type.Optional(text), login: Type.Optional(text) },
	strict,
);

/**
 * Where an external finding was read: a review thread, by GitHub's node ID for the thread, the database ID of its first
 * comment, and that comment's URL; or a file, by its path and the finding's position in it, or the `ref` the file gave.
 */
export const externalSourceSchema = Type.Union([
	Type.Object({ kind: Type.Literal("thread"), thread: text, comment: text, url: text }, strict),
	Type.Object({ kind: Type.Literal("file"), path: text, position: count, ref: Type.Optional(text) }, strict),
]);

/**
 * An external finding as the comparison document stores it. `line` and `endLine` are where the reviewer put it at the
 * compared head. `outdated` marks a thread GitHub no longer places, whose lines are its original ones, and `revision:
 * "base"` one on the diff's left side; neither matches by site. A finding with no line matches only by hand.
 */
export const externalFindingSchema = Type.Object(
	{
		id: idSchema,
		reviewer: externalReviewerSchema,
		file: Type.Optional(text),
		line: Type.Optional(line),
		endLine: Type.Optional(line),
		revision: Type.Optional(Type.Literal("base")),
		outdated: Type.Optional(Type.Boolean()),
		title: Type.String({ minLength: 1, maxLength: maxExternalTitleLength }),
		body: Type.String({ maxLength: maxExternalBodyLength }),
		severity: Type.Optional(text),
		source: externalSourceSchema,
		postedAt: Type.Optional(text),
		resolved: Type.Optional(Type.Boolean()),
	},
	strict,
);

/** A match between an external finding and a Melian finding: by `site`, or by `hand`, with who matched them and when. */
export const comparisonMatchSchema = Type.Object(
	{
		external: idSchema,
		melian: idSchema,
		kind: Type.Union([Type.Literal("site"), Type.Literal("hand")]),
		by: Type.Optional(text),
		at: Type.Optional(text),
	},
	strict,
);

/** A maintainer's word that an external finding and a Melian finding are not one defect, whatever their sites say. */
export const comparisonUnmatchSchema = Type.Object(
	{ external: idSchema, melian: idSchema, by: text, at: text },
	strict,
);

/**
 * The last import from one source: when it ran, the IDs of the findings it holds, and how many review bodies it skipped.
 * The next import from the source replaces them.
 */
export const comparisonImportSchema = Type.Object(
	{ at: text, ids: Type.Array(idSchema), skippedBodies: count },
	strict,
);

/**
 * One changeset's comparison at one revision, as the pipeline's document stores it. `melian` lists the IDs of the
 * findings in Melian's stored review of the revision, read from it, never copied; `imports` is keyed by source, such as
 * `github:coderabbitai[bot]` or `file:codex.json`.
 */
export const comparisonSchema = Type.Object(
	{
		base: text,
		head: text,
		external: Type.Record(Type.String(), externalFindingSchema),
		melian: Type.Array(idSchema),
		matches: Type.Array(comparisonMatchSchema),
		unmatches: Type.Array(comparisonUnmatchSchema),
		imports: Type.Record(Type.String(), comparisonImportSchema),
	},
	strict,
);

const fileFindingSchema = Type.Object(
	{
		ref: Type.Optional(text),
		file: Type.Optional(text),
		line: Type.Optional(line),
		endLine: Type.Optional(line),
		title: text,
		body: Type.String({ maxLength: maxExternalBodyLength }),
		severity: Type.Optional(text),
		postedAt: Type.Optional(text),
		resolved: Type.Optional(Type.Boolean()),
	},
	strict,
);

/**
 * The file a local reviewer's findings arrive in, written by the agent that ran the reviewer: the reviewer, and each
 * finding's file, lines, title, body, and the reviewer's own severity. `ref` is the reviewer's own label for a finding,
 * such as `A1`; without one, a finding is known by its position in the file.
 */
export const externalFindingsFileSchema = Type.Object(
	{
		reviewer: Type.Object({ name: externalReviewerNameSchema, version: Type.Optional(text) }, strict),
		findings: Type.Array(fileFindingSchema, { maxItems: maxExternalFileFindings }),
	},
	strict,
);

/** The JSON Codex's adversarial review writes, under its own `review-output` schema. */
export const codexReviewSchema = Type.Object(
	{
		verdict: Type.Union([Type.Literal("approve"), Type.Literal("needs-attention")]),
		summary: Type.String(),
		findings: Type.Array(
			Type.Object(
				{
					severity: Type.Union([
						Type.Literal("critical"),
						Type.Literal("high"),
						Type.Literal("medium"),
						Type.Literal("low"),
					]),
					title: Type.String({ minLength: 1 }),
					body: Type.String({ minLength: 1, maxLength: maxExternalBodyLength }),
					file: Type.String({ minLength: 1 }),
					line_start: line,
					line_end: line,
					confidence: Type.Number({ minimum: 0, maximum: 1 }),
					recommendation: Type.String(),
				},
				strict,
			),
			{ maxItems: maxExternalFileFindings },
		),
		next_steps: Type.Array(Type.String()),
	},
	strict,
);

export type ExternalReviewerName = Static<typeof externalReviewerNameSchema>;
export type ExternalReviewer = Static<typeof externalReviewerSchema>;
export type ExternalSource = Static<typeof externalSourceSchema>;
export type StoredExternalFinding = Static<typeof externalFindingSchema>;
export type ComparisonMatch = Static<typeof comparisonMatchSchema>;
export type ComparisonUnmatch = Static<typeof comparisonUnmatchSchema>;
export type ComparisonImport = Static<typeof comparisonImportSchema>;
export type StoredComparison = Static<typeof comparisonSchema>;
export type ExternalFindingsFile = Static<typeof externalFindingsFileSchema>;

/** An external finding before Melian gives it an ID. */
export type ExternalFindingInput = Omit<StoredExternalFinding, "id">;

/** Why an external finding, a reviewer's file, or a match was refused. */
export type ComparisonErrorCode = "invalidFinding" | "invalidFile" | "unknownExternal" | "unknownMelian";

/** An external finding, a reviewer's file, or a match was refused. `path` names the file or JSON pointer at fault. */
export class ComparisonError extends Error {
	readonly code: ComparisonErrorCode;
	readonly path: string | undefined;

	constructor(code: ComparisonErrorCode, message: string, options: { path?: string; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "ComparisonError";
		this.code = code;
		this.path = options.path;
	}
}

// The first schema error in `value`, as a pointer and a message, or undefined when it conforms.
function schemaProblem(schema: TSchema, value: unknown): string | undefined {
	const errors = Value.Errors(schema, value);
	const unknown = errors.find((error) => error.keyword === "additionalProperties");
	if (unknown !== undefined) {
		const [key] = (unknown.params as { additionalProperties: string[] }).additionalProperties;
		return `has an unknown key at ${unknown.instancePath}/${key}`;
	}
	const error = errors[0];
	return error === undefined ? undefined : `${error.instancePath || "(top level)"} ${error.message}`;
}

// What the ID hashes besides the reviewer: the thread; or the file, and the finding's ref in it, or without one its
// file, line, and title, so an unchanged finding keeps its ID when a rerun reorders the file.
function sourceFields(input: ExternalFindingInput, title: string): string[] {
	const { source } = input;
	if (source.kind === "thread") return ["thread", source.thread];
	if (source.ref !== undefined) return ["file", source.path, "ref", source.ref];
	return ["file", source.path, "finding", input.file ?? "", String(input.line ?? ""), title];
}

// Whether two line ranges overlap or lie within `siteDistance` lines of each other.
function near(start: number, end: number, otherStart: number, otherEnd: number): boolean {
	return start <= otherEnd + siteDistance && otherStart <= end + siteDistance;
}

/** Where an external finding sits for matching by site: its file and its first and last line. */
export interface ExternalSite {
	readonly file: string;
	readonly start: number;
	readonly end: number;
}

/**
 * A finding another reviewer raised, in one shape whatever the reviewer: Codex, Claude Code, CodeRabbit, or a human. Its
 * ID hashes the reviewer and the source reference, so importing it again updates it rather than adding another.
 */
export class ExternalFinding {
	readonly id: string;
	readonly reviewer: ExternalReviewer;
	readonly file: string | undefined;
	readonly line: number | undefined;
	readonly endLine: number | undefined;
	readonly revision: "base" | undefined;
	readonly outdated: boolean | undefined;
	readonly title: string;
	readonly body: string;
	readonly severity: string | undefined;
	readonly source: ExternalSource;
	readonly postedAt: string | undefined;
	readonly resolved: boolean | undefined;

	// Declared in the order a stored finding holds them, so its JSON keeps that order.
	private constructor(stored: StoredExternalFinding) {
		this.id = stored.id;
		this.reviewer = stored.reviewer;
		this.file = stored.file;
		this.line = stored.line;
		this.endLine = stored.endLine;
		this.revision = stored.revision;
		this.outdated = stored.outdated;
		this.title = stored.title;
		this.body = stored.body;
		this.severity = stored.severity;
		this.source = stored.source;
		this.postedAt = stored.postedAt;
		this.resolved = stored.resolved;
	}

	/** The finding a stored one describes, trusted as stored. */
	static from(stored: StoredExternalFinding): ExternalFinding {
		return new ExternalFinding(stored);
	}

	/**
	 * Builds an external finding, deriving its ID from the reviewer and the source reference, putting its file in
	 * canonical form, and cutting its title to its first line and {@link maxExternalTitleLength} characters. Throws
	 * {@link ComparisonError} `invalidFinding` for a file that is not a repository-relative path, an `endLine` before
	 * `line` or without one, or anything else {@link externalFindingSchema} refuses.
	 */
	static create(input: ExternalFindingInput): ExternalFinding {
		const title = titleOf(input.title);
		let file: string | undefined;
		try {
			file = input.file === undefined ? undefined : canonicalPath(input.file, "/file");
		} catch (error) {
			if (!(error instanceof FindingError)) throw error;
			throw new ComparisonError("invalidFinding", `an external finding's file ${error.message}`, { path: "/file" });
		}
		if (input.endLine !== undefined && (input.line === undefined || input.endLine < input.line)) {
			throw new ComparisonError("invalidFinding", "an external finding's endLine comes before its line", {
				path: "/endLine",
			});
		}
		// Length-prefixed, so no character inside a field can move text from one field to the next.
		const hashed = [input.reviewer.name, ...sourceFields(input, title)]
			.map((field) => `${field.length}:${field}`)
			.join("");
		const id = createHash("sha256").update(hashed).digest("hex").slice(0, 16);
		// Through JSON, so an undefined field at any depth is absent, as it will be once stored.
		const stored = JSON.parse(JSON.stringify({ ...input, id, file, title })) as StoredExternalFinding;
		const problem = schemaProblem(externalFindingSchema, stored);
		if (problem !== undefined) throw new ComparisonError("invalidFinding", `an external finding ${problem}`);
		return new ExternalFinding(stored);
	}

	/**
	 * The findings a reviewer's file holds, read from its parsed JSON: the external-finding file shape,
	 * {@link externalFindingsFileSchema}, or Codex's adversarial review output, {@link codexReviewSchema}. `path` is how
	 * the source reference names the file. Throws {@link ComparisonError} `invalidFile`, naming the path and what is
	 * wrong, for JSON in neither shape.
	 */
	static fromFile(value: unknown, path: string): ExternalFinding[] {
		const codex = typeof value === "object" && value !== null && "next_steps" in value;
		const problem = schemaProblem(codex ? codexReviewSchema : externalFindingsFileSchema, value);
		if (problem !== undefined) {
			const shape = codex ? "Codex's review output" : "an external-finding file";
			throw new ComparisonError("invalidFile", `${path} is not ${shape}: it ${problem}`, { path });
		}
		const create = (input: ExternalFindingInput, position: number) => {
			try {
				return ExternalFinding.create(input);
			} catch (error) {
				if (!(error instanceof ComparisonError)) throw error;
				throw new ComparisonError("invalidFile", `${path}: finding ${position}: ${error.message}`, { path });
			}
		};
		if (codex) {
			const review = value as Static<typeof codexReviewSchema>;
			return review.findings.map((finding, position) =>
				create(
					{
						reviewer: { name: "codex" },
						file: finding.file,
						line: finding.line_start,
						endLine: Math.max(finding.line_start, finding.line_end),
						title: finding.title,
						body:
							finding.recommendation.trim() === ""
								? finding.body
								: `${finding.body}\n\nRecommendation: ${finding.recommendation}`,
						severity: finding.severity,
						source: { kind: "file", path, position },
					},
					position,
				),
			);
		}
		const file = value as ExternalFindingsFile;
		const refs = new Set<string>();
		const found = new Map<string, ExternalFinding>();
		for (const [position, { ref, ...finding }] of file.findings.entries()) {
			if (ref !== undefined) {
				if (refs.has(ref)) {
					throw new ComparisonError(
						"invalidFile",
						`${path}: finding ${position} repeats an earlier finding's ref`,
						{
							path,
						},
					);
				}
				refs.add(ref);
			}
			const created = create(
				{
					...finding,
					reviewer: { ...file.reviewer },
					source: { kind: "file", path, position, ...(ref === undefined ? {} : { ref }) },
				},
				position,
			);
			// Two findings alike in file, line, and title are one finding.
			if (!found.has(created.id)) found.set(created.id, created);
		}
		return [...found.values()];
	}

	/**
	 * Where the finding sits for matching by site, or `undefined` when it matches only by hand: it has no file or line,
	 * GitHub no longer places it, or it sits on the base side of the diff.
	 */
	site(): ExternalSite | undefined {
		const { file, line: start } = this;
		if (file === undefined || start === undefined || this.outdated === true || this.revision === "base") {
			return undefined;
		}
		return { file, start, end: this.endLine ?? start };
	}

	/**
	 * Whether `finding`, from Melian's review, sits at this finding's site: in the same file, on lines that overlap this
	 * finding's or lie within {@link siteDistance} lines of them, at the finding's own location or at one of its `cause`
	 * evidence locations at head.
	 */
	meetsFinding(finding: Finding): boolean {
		const site = this.site();
		if (site === undefined) return false;
		const [start, end] = finding.lines();
		const locations = [
			{ file: finding.properties.path, start, end },
			...(finding.properties.evidence ?? [])
				.filter((location) => location.role === "cause" && location.revision !== "base")
				.map((location) => ({
					file: location.file,
					start: location.startLine,
					end: location.endLine ?? location.startLine,
				})),
		];
		return locations.some(
			(location) => location.file === site.file && near(site.start, site.end, location.start, location.end),
		);
	}

	/** Whether `other` sits at this finding's site, by the same rule as {@link ExternalFinding.meetsFinding}. */
	meets(other: ExternalFinding): boolean {
		const site = this.site();
		const otherSite = other.site();
		if (site === undefined || otherSite === undefined || site.file !== otherSite.file) return false;
		return near(site.start, site.end, otherSite.start, otherSite.end);
	}

	/** Orders findings by file, then line, then ID; a finding with no file or line sorts first. */
	compareSite(other: ExternalFinding): number {
		return (
			compareText(this.file ?? "", other.file ?? "") ||
			(this.line ?? 0) - (other.line ?? 0) ||
			compareText(this.id, other.id)
		);
	}

	/**
	 * Whether `other` came from the same reviewer: the same name, and the same login where either has one, ignoring case
	 * as GitHub does.
	 */
	sameReviewer(other: ExternalFinding): boolean {
		return (
			this.reviewer.name === other.reviewer.name &&
			this.reviewer.login?.toLowerCase() === other.reviewer.login?.toLowerCase()
		);
	}

	toJSON(): StoredExternalFinding {
		return withoutUndefined({
			id: this.id,
			reviewer: this.reviewer,
			file: this.file,
			line: this.line,
			endLine: this.endLine,
			revision: this.revision,
			outdated: this.outdated,
			title: this.title,
			body: this.body,
			severity: this.severity,
			source: this.source,
			postedAt: this.postedAt,
			resolved: this.resolved,
		});
	}
}

// A title is one line: the first that is not blank, cut to the limit on a code point boundary.
function titleOf(title: string): string {
	const first = title.split(/\r?\n/).find((each) => each.trim() !== "") ?? "";
	const points = [...first.trim()];
	return points.length <= maxExternalTitleLength
		? points.join("")
		: `${points.slice(0, maxExternalTitleLength - 1).join("")}…`;
}

function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T;
}

/** What one importer read: the findings, and how many review bodies it skipped because they have no thread. */
export interface ExternalImport {
	readonly findings: readonly ExternalFinding[];
	readonly skippedBodies: number;
	/** The head commit the source reports, where it knows one, such as a pull request's. */
	readonly head?: string;
}

/** A source of external findings, such as a pull request's review threads or a reviewer's file. */
export interface ExternalImporter {
	/** How the comparison names the source, such as `github:coderabbitai[bot]` or `file:codex.json`. */
	readonly source: string;
	import(): Promise<ExternalImport>;
}

/** One defect as the comparison counts it: the external findings at it, and the Melian findings they match. */
export interface ComparisonGroup {
	readonly external: readonly ExternalFinding[];
	readonly melian: readonly string[];
}

function pairKey(pair: { readonly external: string; readonly melian: string }): string {
	return JSON.stringify([pair.external, pair.melian]);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * External reviewers' findings and Melian's, for one changeset at one revision, and the matches between them. Each
 * external finding ends matched or external-only, and each Melian finding matched or Melian-only.
 *
 * Matching is mechanical: {@link Comparison.compare} matches an external finding with every Melian finding at its site.
 * A maintainer's {@link Comparison.match} or {@link Comparison.unmatch} overrides it, and is kept across every later
 * import and comparison.
 */
export class Comparison {
	readonly base: string;
	readonly head: string;
	private external: Record<string, StoredExternalFinding>;
	private melian: string[];
	private matches: ComparisonMatch[];
	private unmatches: ComparisonUnmatch[];
	private imports: Record<string, ComparisonImport>;

	// Declared in the order a stored comparison holds them, so its JSON keeps that order.
	private constructor(stored: StoredComparison) {
		this.base = stored.base;
		this.head = stored.head;
		this.external = stored.external;
		this.melian = stored.melian;
		this.matches = stored.matches;
		this.unmatches = stored.unmatches;
		this.imports = stored.imports;
	}

	/** An empty comparison of the revision `base`..`head`. */
	static of(revision: { readonly base: string; readonly head: string }): Comparison {
		return new Comparison({
			base: revision.base,
			head: revision.head,
			external: {},
			melian: [],
			matches: [],
			unmatches: [],
			imports: {},
		});
	}

	/**
	 * The comparison a stored one describes, trusted as stored, and copied through JSON, since a comparison changes and a
	 * document's value inside a commit is a view `structuredClone` refuses.
	 */
	static from(stored: StoredComparison): Comparison {
		return new Comparison(JSON.parse(JSON.stringify(stored)) as StoredComparison);
	}

	/**
	 * Replaces what `source` last imported with what `imported` read, as of `at`. A finding the source no longer reports
	 * goes, unless another source still holds it, and so do the hand matches and unmatches that name it. A finding it
	 * reports again keeps its ID and its hand records. Call {@link Comparison.compare} after, so the new findings are
	 * matched.
	 */
	import(source: string, imported: ExternalImport, at: string): void {
		const ids = [...new Set(imported.findings.map((finding) => finding.id))];
		const others = new Set(
			Object.entries(this.imports)
				.filter(([name]) => name !== source)
				.flatMap(([, each]) => each.ids),
		);
		const kept = new Set(ids);
		const gone = new Set(
			(Object.hasOwn(this.imports, source) ? this.imports[source]!.ids : []).filter(
				(id) => !kept.has(id) && !others.has(id),
			),
		);
		const external = Object.fromEntries(Object.entries(this.external).filter(([id]) => !gone.has(id)));
		for (const finding of imported.findings) external[finding.id] = finding.toJSON();
		this.external = external;
		this.matches = this.matches.filter((match) => !gone.has(match.external));
		this.unmatches = this.unmatches.filter((unmatch) => !gone.has(unmatch.external));
		this.imports = { ...this.imports, [source]: { at, ids, skippedBodies: imported.skippedBodies } };
	}

	/**
	 * Compares with `verdict`, Melian's stored review of the revision: records the IDs of the findings it shows, those
	 * that need attention and those dismissed, and matches each external finding with every one at its site, except a
	 * pair a maintainer unmatched. Hand matches stay. A silent finding was never shown to the author, so it takes no part.
	 */
	compare(verdict: Verdict): void {
		const findings = [...verdict.attention(), ...verdict.dismissed];
		this.melian = [...new Set(findings.map((finding) => finding.id))];
		const hand = this.matches.filter((match) => match.kind === "hand");
		const kept = new Set([...hand, ...this.unmatches].map(pairKey));
		const site: ComparisonMatch[] = [];
		for (const external of this.externalFindings()) {
			for (const finding of findings) {
				const pair = { external: external.id, melian: finding.id };
				if (!kept.has(pairKey(pair)) && external.meetsFinding(finding)) {
					kept.add(pairKey(pair));
					site.push({ ...pair, kind: "site" });
				}
			}
		}
		this.matches = [...hand, ...site].sort(
			(a, b) => compareText(a.external, b.external) || compareText(a.melian, b.melian),
		);
	}

	/**
	 * Matches an external finding with a Melian finding by hand, as `by` at `at`, replacing any unmatch of the pair.
	 * Throws {@link ComparisonError} `unknownExternal` or `unknownMelian` for an ID the comparison does not hold.
	 */
	match(external: string, melian: string, by: string, at: string): void {
		this.known(external, melian);
		const key = pairKey({ external, melian });
		this.unmatches = this.unmatches.filter((each) => pairKey(each) !== key);
		this.matches = [
			...this.matches.filter((each) => pairKey(each) !== key),
			{ external, melian, kind: "hand" as const, by, at },
		].sort((a, b) => compareText(a.external, b.external) || compareText(a.melian, b.melian));
	}

	/**
	 * Records that an external finding and a Melian finding are not one defect, as `by` at `at`, removing any match of
	 * the pair, by site or by hand. Throws as {@link Comparison.match} does.
	 */
	unmatch(external: string, melian: string, by: string, at: string): void {
		this.known(external, melian);
		const key = pairKey({ external, melian });
		this.matches = this.matches.filter((each) => pairKey(each) !== key);
		this.unmatches = [...this.unmatches.filter((each) => pairKey(each) !== key), { external, melian, by, at }];
	}

	/** Every external finding, in file, line, and ID order. */
	externalFindings(): ExternalFinding[] {
		return Object.values(this.external)
			.map(ExternalFinding.from)
			.sort((a, b) => a.compareSite(b));
	}

	/** The external finding with `id`, or `undefined`. */
	externalFinding(id: string): ExternalFinding | undefined {
		return Object.hasOwn(this.external, id) ? ExternalFinding.from(this.external[id]!) : undefined;
	}

	/** The IDs of the Melian findings compared against, as the stored review listed them. */
	melianFindings(): readonly string[] {
		return [...this.melian];
	}

	/** The matches that hold, between findings the comparison holds now, by site and by hand. */
	effectiveMatches(): ComparisonMatch[] {
		const melian = new Set(this.melian);
		return this.matches
			.filter((match) => Object.hasOwn(this.external, match.external) && melian.has(match.melian))
			.map((match) => ({ ...match }));
	}

	/** The last import from each source, by source. */
	importsBySource(): Readonly<Record<string, ComparisonImport>> {
		return structuredClone(this.imports);
	}

	/**
	 * Every defect the comparison counts, each once. Each Melian finding is one, with every external finding matched with
	 * it, so several reviewers at one Melian finding count once; an external finding that matches two Melian findings
	 * sits beside each and never joins them. External findings that match none grow groups in site order: one joins the
	 * first group holding a finding it meets and none from its own reviewer, so a group holds at most one finding from
	 * each reviewer, as two reports from one check stay two.
	 */
	groups(): ComparisonGroup[] {
		const external = this.externalFindings();
		const matches = this.effectiveMatches();
		const matched = new Set(matches.map((match) => match.external));
		const own = this.melian.map((id) => ({
			external: external.filter((finding) =>
				matches.some((match) => match.melian === id && match.external === finding.id),
			),
			melian: [id],
		}));
		const alone: ExternalFinding[][] = [];
		for (const finding of external.filter((each) => !matched.has(each.id))) {
			const group = alone.find(
				(members) =>
					members.some((member) => member.meets(finding)) &&
					!members.some((member) => member.sameReviewer(finding)),
			);
			if (group === undefined) alone.push([finding]);
			else group.push(finding);
		}
		return [...own, ...alone.map((members) => ({ external: members, melian: [] }))];
	}

	/** The groups where external findings match Melian findings. */
	matched(): ComparisonGroup[] {
		return this.groups().filter((group) => group.external.length > 0 && group.melian.length > 0);
	}

	/** The groups of external findings that match no Melian finding, each a defect Melian did not report. */
	externalOnly(): ComparisonGroup[] {
		return this.groups().filter((group) => group.melian.length === 0);
	}

	/** The IDs of the Melian findings no external finding matches. */
	melianOnly(): string[] {
		return this.groups()
			.filter((group) => group.external.length === 0)
			.flatMap((group) => group.melian);
	}

	toJSON(): StoredComparison {
		return structuredClone({
			base: this.base,
			head: this.head,
			external: this.external,
			melian: this.melian,
			matches: this.matches,
			unmatches: this.unmatches,
			imports: this.imports,
		});
	}

	private known(external: string, melian: string): void {
		if (!Object.hasOwn(this.external, external)) {
			throw new ComparisonError("unknownExternal", `the comparison has no external finding ${external}`);
		}
		if (!this.melian.includes(melian)) {
			throw new ComparisonError("unknownMelian", `Melian's review has no finding ${melian}`);
		}
	}
}
