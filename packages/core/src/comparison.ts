import { createHash } from "node:crypto";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import type { Verdict } from "./adjudication.ts";
import { FindingError } from "./errors.ts";
import { canonicalPath, type Finding } from "./findings.ts";
import { visibleText } from "./render.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const line = Type.Integer({ minimum: 1 });
const count = Type.Integer({ minimum: 0 });
const idSchema = Type.String({ pattern: "^[0-9a-f]{16}$" });
// Bounds on the short fields a reviewer or a file supplies, so a pasted log never lands in one: a path within PATH_MAX,
// a login within GitHub's 39 characters and its `[bot]`, and a severity, version, ref, or time of a line at most.
const pathText = Type.String({ minLength: 1, maxLength: 4096 });
const shortText = Type.String({ minLength: 1, maxLength: 100 });

/** The most characters an external finding's title keeps; a longer title, such as a thread's first line, is cut. */
export const maxExternalTitleLength = 200;

/** The most characters an external finding's body may hold: GitHub's own limit on a comment. */
export const maxExternalBodyLength = 65_536;

/** The most findings one file may hold. */
export const maxExternalFileFindings = 1_000;

/** How many lines apart an external finding and another may lie and still be one site. */
export const siteDistance = 3;

// The reviewers Melian compares itself with. A GitHub author other than CodeRabbit's or Copilot's bot is `human`.
export const externalReviewerNameSchema = Type.Union([
	Type.Literal("codex"),
	Type.Literal("claude-code"),
	Type.Literal("coderabbit"),
	Type.Literal("copilot"),
	Type.Literal("human"),
]);

// Who raised an external finding: the reviewer, its version where known, and on a code host its login and kind.
export const externalReviewerSchema = Type.Object(
	{
		name: externalReviewerNameSchema,
		version: Type.Optional(shortText),
		login: Type.Optional(shortText),
		kind: Type.Optional(Type.Union([Type.Literal("bot"), Type.Literal("user")])),
	},
	strict,
);

// Where an external finding was read: a review thread, by GitHub's node ID and its first comment's URL; or a file, by
// its path, the finding's position in it, and the `ref` the file gave.
export const externalSourceSchema = Type.Union([
	Type.Object({ kind: Type.Literal("thread"), thread: shortText, url: pathText }, strict),
	Type.Object({ kind: Type.Literal("file"), path: pathText, position: count, ref: Type.Optional(shortText) }, strict),
]);

/**
 * An external finding as the comparison document stores it. `line` and `endLine` are where the reviewer put it at the
 * compared head. `outdated` marks a thread GitHub no longer places, whose lines are its original ones, and `revision:
 * "base"` one on the diff's left side; neither matches by site. A finding with no line matches only by hand. `commit` is
 * the commit the reviewer read, where the source knows it, such as a thread's first comment's; a finding read at a
 * commit other than the compared head matches only by hand.
 */
export const externalFindingSchema = Type.Object(
	{
		id: idSchema,
		reviewer: externalReviewerSchema,
		file: Type.Optional(pathText),
		line: Type.Optional(line),
		endLine: Type.Optional(line),
		revision: Type.Optional(Type.Literal("base")),
		outdated: Type.Optional(Type.Boolean()),
		commit: Type.Optional(Type.String({ pattern: "^([0-9a-f]{40}|[0-9a-f]{64})$" })),
		title: Type.String({ minLength: 1, maxLength: maxExternalTitleLength }),
		body: Type.String({ maxLength: maxExternalBodyLength }),
		severity: Type.Optional(shortText),
		source: externalSourceSchema,
		postedAt: Type.Optional(shortText),
		resolved: Type.Optional(Type.Boolean()),
	},
	strict,
);

// A match between an external finding and a Melian finding: by `site`, or by `hand`, with who matched them and when.
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

// A maintainer's word that an external finding and a Melian finding are not one defect, whatever their sites say.
export const comparisonUnmatchSchema = Type.Object(
	{ external: idSchema, melian: idSchema, by: text, at: text },
	strict,
);

// The last import from one source: when it ran, the IDs of the findings it holds, and how many review bodies it
// skipped. The next import from the source replaces them.
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
		ref: Type.Optional(shortText),
		file: Type.Optional(pathText),
		line: Type.Optional(line),
		endLine: Type.Optional(line),
		title: text,
		body: Type.String({ maxLength: maxExternalBodyLength }),
		severity: Type.Optional(shortText),
		postedAt: Type.Optional(shortText),
		resolved: Type.Optional(Type.Boolean()),
	},
	strict,
);

/**
 * The file a local reviewer's findings arrive in, written by the agent that ran the reviewer: the reviewer, and each
 * finding's file, lines, title, body, and the reviewer's own severity. `ref` is the reviewer's own label for a finding,
 * such as `A1`; without one, a finding is known by its file, line, title, and body.
 */
export const externalFindingsFileSchema = Type.Object(
	{
		reviewer: Type.Object({ name: externalReviewerNameSchema, version: Type.Optional(shortText) }, strict),
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

function schemaProblem(schema: TSchema, value: unknown): string | undefined {
	const errors = Value.Errors(schema, value);
	const unknown = errors.find((error) => error.keyword === "additionalProperties");
	// The key's own text is the file author's to choose, so the message names only the object that holds it.
	if (unknown !== undefined) return `has an unknown key in ${unknown.instancePath || "(top level)"}`;
	const error = errors[0];
	return error === undefined ? undefined : `${error.instancePath || "(top level)"} ${error.message}`;
}

// What the ID hashes: the thread's node ID; or the file's path, and the finding's ref in it, or without one its file,
// line, title, and a digest of its body, so an unchanged finding keeps its ID when a rerun reorders the file and two
// findings at one site under one generic title stay two. The reviewer stays out, so a
// later change to how reviewers are named never orphans a hand record.
function sourceFields(input: ExternalFindingInput, title: string): string[] {
	const { source } = input;
	if (source.kind === "thread") return ["thread", source.thread];
	if (source.ref !== undefined) return ["file", source.path, "ref", source.ref];
	const body = createHash("sha256").update(input.body).digest("hex");
	return ["file", source.path, "finding", input.file ?? "", String(input.line ?? ""), title, body];
}

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
 * ID hashes the source reference, so importing it again updates it rather than adding another.
 */
export class ExternalFinding {
	readonly id: string;
	readonly reviewer: ExternalReviewer;
	readonly file: string | undefined;
	readonly line: number | undefined;
	readonly endLine: number | undefined;
	readonly revision: "base" | undefined;
	readonly outdated: boolean | undefined;
	readonly commit: string | undefined;
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
		this.commit = stored.commit;
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
	 * Builds an external finding, deriving its ID from the source reference alone, putting its file in
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
		const hashed = sourceFields({ ...input, file }, title)
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
			// Two findings alike in file, line, title, and body are one finding.
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
		const fields = {
			id: this.id,
			reviewer: this.reviewer,
			file: this.file,
			line: this.line,
			endLine: this.endLine,
			revision: this.revision,
			outdated: this.outdated,
			commit: this.commit,
			title: this.title,
			body: this.body,
			severity: this.severity,
			source: this.source,
			postedAt: this.postedAt,
			resolved: this.resolved,
		};
		return Object.fromEntries(
			Object.entries(fields).filter(([, each]) => each !== undefined),
		) as StoredExternalFinding;
	}

	/** Where the finding sits, as the terminal shows it: its file and lines, and whether it is outdated or on the base. */
	where(): string {
		if (this.file === undefined) return "(no file)";
		const file = visibleText(this.file);
		if (this.line === undefined) return `${file} (no line)`;
		const lines =
			this.endLine === undefined || this.endLine === this.line ? `${this.line}` : `${this.line}-${this.endLine}`;
		const note = this.outdated ? " (outdated)" : this.revision === "base" ? " (base)" : "";
		return `${file}:${lines}${note}`;
	}

	/**
	 * Whether the reviewer read another commit than `head`. A thread stays on the pull request after a push, and GitHub
	 * carries its line forward even when the push fixed what it named, so only a finding read at the compared head
	 * matches by site.
	 */
	readAt(head: string): boolean {
		return this.commit === undefined || this.commit === head;
	}

	/** Who raised the finding, as the terminal shows it: a human by login, any other reviewer by name. */
	by(): string {
		const { name, login } = this.reviewer;
		return visibleText(name === "human" && login !== undefined ? login : name);
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
	// Fields a newer Melian stored that this one does not know, such as adjudications, kept so a write never drops them.
	private readonly later: Record<string, unknown>;

	// Declared in the order a stored comparison holds them, so its JSON keeps that order.
	private constructor(stored: StoredComparison) {
		const { base, head, external, melian, matches, unmatches, imports, ...later } = stored;
		this.base = base;
		this.head = head;
		this.external = external;
		this.melian = melian;
		this.matches = matches;
		this.unmatches = unmatches;
		this.imports = imports;
		this.later = later;
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
		for (const external of this.externalFindings().filter((each) => each.readAt(this.head))) {
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
			// A finding read at another commit waits alone for a hand match, as it never matches by site.
			const group = !finding.readAt(this.head)
				? undefined
				: alone.find(
						(members) =>
							members.every((member) => member.readAt(this.head)) &&
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
			...this.later,
		});
	}

	/**
	 * The external findings with several matches and at least one site match, each with those Melian findings. A hand
	 * match settles only its own pair; any remaining mechanical pairing waits for the maintainer to match or unmatch it.
	 * A finding matched entirely by hand is not ambiguous.
	 */
	ambiguous(): { readonly external: ExternalFinding; readonly melian: readonly string[] }[] {
		const matches = this.effectiveMatches();
		return this.externalFindings()
			.filter((external) => matches.some((match) => match.external === external.id && match.kind === "site"))
			.map((external) => ({
				external,
				melian: matches.filter((match) => match.external === external.id).map((match) => match.melian),
			}))
			.filter((each) => each.melian.length > 1);
	}

	/**
	 * The comparison as the terminal shows it. The matched count is of distinct external findings, with the distinct
	 * Melian findings they cover beside it, so one reviewer's finding near two of Melian's counts once. Then the
	 * external-only and Melian-only counts, and of review bodies skipped when given; each ambiguous match; and every
	 * finding's ID, with matched external findings beside the Melian findings they matched.
	 * `verdict` is the stored review, which names each Melian-only finding's rule and place and identifies dismissed
	 * findings in either group. Every string is untrusted, so each prints through `visibleText`.
	 */
	render(verdict: Verdict | undefined, skippedBodies?: number): string {
		const groups = this.groups();
		const matches = this.effectiveMatches();
		const dismissed = new Set((verdict?.dismissed ?? []).map((finding) => finding.id));
		const matched = new Set(matches.map((match) => match.external)).size;
		const covered = new Set(matches.map((match) => match.melian)).size;
		const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
		const externalOnly = groups.filter((group) => group.melian.length === 0);
		const melianOnly = groups.filter((group) => group.external.length === 0).flatMap((group) => group.melian);
		const skipped = skippedBodies === undefined ? "" : ` Skipped review bodies: ${skippedBodies}.`;
		const out = [
			`Matched: ${plural(matched, "external finding")}, covering ${plural(covered, "Melian finding")}. External only: ${externalOnly.length}. Melian only: ${melianOnly.length}.${skipped}\n`,
		];
		const ambiguous = this.ambiguous();
		if (ambiguous.length > 0) out.push("Ambiguous, near several Melian findings; match or unmatch by hand:\n");
		for (const { external, melian } of ambiguous) {
			out.push(`  ${external.id}  ${external.by()}  ${external.where()}  near ${melian.join(", ")}\n`);
		}
		const matchedGroups = groups.filter((group) => group.external.length > 0 && group.melian.length > 0);
		if (matchedGroups.length > 0) out.push("Matched:\n");
		for (const group of matchedGroups) {
			const id = group.melian[0]!;
			out.push(`  ${id}${dismissed.has(id) ? "  (dismissed)" : ""}\n`);
			for (const finding of group.external) {
				out.push(`    ${finding.id}  ${finding.by()}  ${finding.where()}\n`);
			}
		}
		if (externalOnly.length > 0) out.push("External only:\n");
		for (const finding of externalOnly.flatMap((group) => group.external)) {
			const read = finding.readAt(this.head) ? "" : `  (read at ${finding.commit!.slice(0, 12)}; match it by hand)`;
			out.push(`  ${finding.id}  ${finding.by()}  ${finding.where()}  ${visibleText(finding.title)}${read}\n`);
		}
		if (melianOnly.length > 0) out.push("Melian only:\n");
		const findings = new Map((verdict?.all() ?? []).map((finding) => [finding.id, finding]));
		for (const id of melianOnly) {
			const finding = findings.get(id);
			if (finding === undefined) {
				out.push(`  ${id}\n`);
				continue;
			}
			const [start, end] = finding.lines();
			const lines = start === end ? `${start}` : `${start}-${end}`;
			const { severity, path } = finding.properties;
			out.push(
				`  ${id}  ${severity} ${visibleText(finding.ruleId)}  ${visibleText(path)}:${lines}${dismissed.has(id) ? "  (dismissed)" : ""}\n`,
			);
		}
		return out.join("");
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
