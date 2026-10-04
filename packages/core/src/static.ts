import { isAbsolute, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { Revision } from "./changeset.ts";
import type { Severity, StaticToolSettings } from "./config.ts";
import { CheckError } from "./errors.ts";
import {
	canonicalPath,
	Finding,
	type FindingTrigger,
	findingId,
	normaliseSnippet,
	type SarifLevel,
	sarifLevelSchema,
	snippetOccurrence,
} from "./findings.ts";
import { type CheckReport, guardrailLimits } from "./guardrails.ts";
import { openSource, SourceError, type SourceReader } from "./source.ts";

/** The static tools Melian runs. */
export type StaticTool = "biome" | "tsc";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const line = Type.Integer({ minimum: 1 });

/** The JSON Schema of a {@link ToolResult}. */
export const toolResultSchema = Type.Object(
	{
		ruleId: text,
		level: sarifLevelSchema,
		message: Type.Object({ text }, strict),
		locations: Type.Array(
			Type.Object(
				{
					physicalLocation: Type.Object(
						{
							artifactLocation: Type.Object({ uri: text }, strict),
							region: Type.Object(
								{
									startLine: line,
									startColumn: Type.Optional(line),
									endLine: Type.Optional(line),
									endColumn: Type.Optional(line),
								},
								strict,
							),
						},
						strict,
					),
				},
				strict,
			),
			{ minItems: 1, maxItems: 1 },
		),
	},
	strict,
);

/** The JSON Schema of a {@link ToolLog}. */
export const toolLogSchema = Type.Object(
	{
		version: Type.Literal("2.1.0"),
		runs: Type.Array(
			Type.Object(
				{
					tool: Type.Object(
						{ driver: Type.Object({ name: text, version: text, informationUri: Type.Optional(text) }, strict) },
						strict,
					),
					results: Type.Array(toolResultSchema),
				},
				strict,
			),
			{ minItems: 1, maxItems: 1 },
		),
	},
	strict,
);

/**
 * One result of a static tool, as a SARIF `result` in the tool's own terms: `ruleId` is the tool's, such as Biome's
 * `lint/suspicious/noDebugger` or tsc's `TS2322`, and the one location's URI is repository-relative, each segment
 * percent-encoded as in a finding.
 */
export type ToolResult = Static<typeof toolResultSchema>;

/** What one static tool reported at one revision: a SARIF 2.1.0 log of one run, with the tool's version in its driver. */
export type ToolLog = Static<typeof toolLogSchema>;

/** Where a tool ran and which version it was, for its output to be read against. */
export interface ToolRun {
	/** The directory the tool ran in, the root of a worktree of the revision. Paths in its output are relative to it. */
	readonly root: string;
	readonly version: string;
}

const checkOf = (tool: StaticTool) => `static.${tool}`;

function invalid(tool: StaticTool, detail: string, cause?: unknown): CheckError {
	return new CheckError("invalidOutput", checkOf(tool), `${tool} wrote output Melian cannot read: ${detail}`, {
		cause,
	});
}

// A path as the tool wrote it, as a canonical repository-relative path, or undefined when it lies outside the
// worktree or inside its dependencies.
function repositoryPath(root: string, written: string): string | undefined {
	const absolute = written.startsWith("file:") ? fileURLToPath(written) : written;
	const path = (isAbsolute(absolute) ? relative(root, absolute) : posix.normalize(absolute)).split("\\").join("/");
	if (path === ".." || path.startsWith("../") || isAbsolute(path)) return undefined;
	if (path.split("/").includes("node_modules")) return undefined;
	try {
		return canonicalPath(path);
	} catch {
		return undefined;
	}
}

function uriOf(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function toolLog(name: string, run: ToolRun, results: ToolResult[]): ToolLog {
	return { version: "2.1.0", runs: [{ tool: { driver: { name, version: run.version } }, results }] };
}

const sarifLevels: Readonly<Record<string, SarifLevel>> = {
	error: "error",
	warning: "warning",
	note: "note",
	none: "note",
};

interface LooseResult {
	readonly ruleId?: unknown;
	readonly level?: unknown;
	readonly message?: { readonly text?: unknown };
	readonly locations?: readonly {
		readonly physicalLocation?: {
			readonly artifactLocation?: { readonly uri?: unknown };
			readonly region?: Record<string, unknown>;
		};
	}[];
}

/**
 * Reads the output of Biome's SARIF reporter, `biome lint --reporter=sarif`, into a {@link ToolLog}. Biome writes
 * absolute paths as URIs and no version, so paths are made relative to `run.root` and `run.version` is recorded. A
 * result outside the worktree, or under a `node_modules` directory, is dropped. Throws `CheckError` `invalidOutput` when
 * the text is not a SARIF log.
 */
export function normaliseBiomeSarif(output: string, run: ToolRun): ToolLog {
	let parsed: { runs?: readonly { results?: readonly LooseResult[] }[] };
	try {
		parsed = JSON.parse(output);
	} catch (cause) {
		throw invalid("biome", "the SARIF report is not JSON", cause);
	}
	const results = parsed?.runs?.[0]?.results;
	if (!Array.isArray(results)) throw invalid("biome", "the SARIF report has no results");
	const normalised: ToolResult[] = [];
	for (const result of results as readonly LooseResult[]) {
		const location = result.locations?.[0]?.physicalLocation;
		const uri = location?.artifactLocation?.uri;
		const message = result.message?.text;
		if (typeof uri !== "string" || typeof message !== "string" || message === "") {
			throw invalid("biome", "a result has no file or no message");
		}
		const path = repositoryPath(run.root, uri);
		if (path === undefined) continue;
		const region = location?.region ?? {};
		const startLine = typeof region.startLine === "number" ? region.startLine : 1;
		normalised.push({
			ruleId: typeof result.ruleId === "string" && result.ruleId !== "" ? result.ruleId : "unknown",
			level: sarifLevels[String(result.level ?? "warning")] ?? "warning",
			message: { text: message },
			locations: [
				{
					physicalLocation: {
						artifactLocation: { uri: uriOf(path) },
						region: withoutUndefined({
							startLine,
							startColumn: positive(region.startColumn),
							endLine: positive(region.endLine),
							endColumn: positive(region.endColumn),
						}),
					},
				},
			],
		});
	}
	return checked("biome", toolLog("Biome", run, normalised));
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T;
}

function checked(tool: StaticTool, log: ToolLog): ToolLog {
	const error = Value.Errors(toolLogSchema, log)[0];
	if (error !== undefined) throw invalid(tool, `${error.instancePath} ${error.message}`);
	return log;
}

// Where a diagnostic's location could end and its rule begin. A message can quote this text, and so can a file name.
const locationEnd = /\((\d+),(\d+)\): (?:error|warning|message) (TS\d+): /g;
const global = /^(?:error|warning|message) (TS\d+): (.*)$/;

interface Diagnostic {
	readonly written: string;
	readonly path: string | undefined;
	readonly region: ToolResult["locations"][0]["physicalLocation"]["region"];
	readonly rule: string;
	readonly message: string;
}

// Every place a location could end, from the left, those whose prefix names a file in the tree first. A greedy match
// took the last, which a quoted literal type in the message controls.
function located(row: string, root: string, exists: (path: string) => boolean): Diagnostic[] {
	return [...row.matchAll(locationEnd)]
		.filter((match) => match.index > 0)
		.map((match) => ({
			written: row.slice(0, match.index),
			path: repositoryPath(root, row.slice(0, match.index)),
			region: { startLine: Number(match[1]), startColumn: Number(match[2]) },
			rule: match[3]!,
			message: row.slice(match.index + match[0].length),
		}))
		.sort((a, b) => Number(b.path !== undefined && exists(b.path)) - Number(a.path !== undefined && exists(a.path)));
}

/**
 * Reads the diagnostics `tsc --noEmit --pretty false` prints into a {@link ToolLog}: `file(line,col): error TS1234:
 * message`, with indented lines continuing the message above them. A message or a file name can hold text that looks
 * like a location, so the file is the shortest prefix of the line that ends where a location could and names a file
 * for which `run.exists` holds; `exists` takes a repository-relative path and answers for the revision's tree. Failing
 * that, a line tsc prints without a file is read as one, and anything else takes the shortest such prefix. A
 * diagnostic without a file, such as a `tsconfig.json` tsc cannot read, sits at line 1 of `project`, the
 * repository-relative path of the project file. Every tsc diagnostic is an error. Diagnostics outside the worktree or
 * under `node_modules` are dropped, and the file each named, as tsc wrote it, is pushed onto `dropped`; other lines are
 * ignored.
 */
export function parseTscDiagnostics(
	output: string,
	run: ToolRun & { readonly project: string; readonly exists: (path: string) => boolean },
	dropped: string[] = [],
): ToolLog {
	const results: ToolResult[] = [];
	// The message an indented line continues; undefined after a dropped diagnostic, whose continuation is dropped too.
	let continuing: { text: string } | undefined;
	for (const row of output.split(/\r?\n/)) {
		if (/^\s/.test(row) && row.trim() !== "") {
			if (continuing !== undefined) continuing.text += `\n${row.trim()}`;
			continue;
		}
		continuing = undefined;
		const [first] = located(row, run.root, run.exists);
		const fileless = global.exec(row);
		const inTree = first?.path !== undefined && run.exists(first.path);
		const diagnostic: Diagnostic | undefined =
			fileless !== null && !inTree
				? {
						written: run.project,
						path: canonicalPath(run.project),
						region: { startLine: 1 },
						rule: fileless[1]!,
						message: fileless[2]!,
					}
				: first;
		if (diagnostic === undefined) continue;
		if (diagnostic.path === undefined) {
			dropped.push(diagnostic.written);
			continue;
		}
		continuing = { text: diagnostic.message };
		results.push({
			ruleId: diagnostic.rule,
			level: "error",
			message: continuing,
			locations: [
				{ physicalLocation: { artifactLocation: { uri: uriOf(diagnostic.path) }, region: diagnostic.region } },
			],
		});
	}
	return checked("tsc", toolLog("tsc", run, results));
}

/** The Melian rule ID of a tool's rule: `biome/suspicious/noDebugger` for Biome's `lint/suspicious/noDebugger`, `tsc/TS2322`. */
export function staticRuleId(tool: StaticTool, ruleId: string): string {
	return tool === "biome" ? `biome/${ruleId.replace(/^lint\//, "")}` : `tsc/${ruleId}`;
}

const biomeSeverities: Readonly<Record<SarifLevel, Severity>> = { error: "P2", warning: "P3", note: "nit" };

/**
 * The severity of a static result: Biome's `error` is `P2`, `warning` `P3`, and `note` `nit`; every tsc error is `P1`.
 * `overrides`, from `static.<tool>.severity`, replaces it for one Melian rule ID.
 */
export function staticSeverity(
	tool: StaticTool,
	rule: string,
	level: SarifLevel,
	overrides: Readonly<Record<string, Severity>>,
): Severity {
	return overrides[rule] ?? (tool === "biome" ? biomeSeverities[level] : "P1");
}

/** What {@link staticFindings} compares. */
export interface StaticFindingsInput {
	readonly repoRoot: string;
	readonly revision: Revision;
	readonly tool: StaticTool;
	readonly settings: StaticToolSettings;
	readonly base: ToolLog;
	readonly head: ToolLog;
}

interface Identified {
	readonly id: string;
	readonly result: ToolResult;
	readonly path: string;
	readonly rule: string;
	readonly snippet?: string;
	readonly occurrence?: number;
	readonly discriminator?: string;
	readonly count: number;
}

function decodePath(uri: string): string {
	return uri.split("/").map(decodeURIComponent).join("/");
}

// Each result keyed by finding identity in the revision it came from, its file named by `pathAtHead`. Results of one
// rule on the same lines share an ID, so they merge into one, counted.
async function identify(
	tool: StaticTool,
	log: ToolLog,
	reader: SourceReader,
	pathAtHead: (path: string) => string,
): Promise<Map<string, Identified>> {
	const texts = new Map<string, Promise<string | undefined>>();
	const textOf = (path: string) => {
		let text = texts.get(path);
		if (text === undefined) {
			text = reader.readText(path, guardrailLimits.fileBytes).catch((error: unknown) => {
				// Too large or a symlink: identified by message rather than code. Absence is already undefined; any other
				// failure would silently change identities, so the check fails instead.
				if (error instanceof SourceError && (error.code === "tooLarge" || error.code === "symlink"))
					return undefined;
				if (error instanceof SourceError) {
					throw new CheckError("unreadable", checkOf(tool), error.message, { cause: error });
				}
				throw error;
			});
			texts.set(path, text);
		}
		return text;
	};
	const identified = new Map<string, Identified>();
	for (const result of log.runs[0].results) {
		const { artifactLocation, region } = result.locations[0]!.physicalLocation;
		const path = decodePath(artifactLocation.uri);
		const rule = staticRuleId(tool, result.ruleId);
		const text = await textOf(path);
		const endLine = Math.max(region.endLine ?? region.startLine, region.startLine);
		const snippet = text
			?.split("\n")
			.slice(region.startLine - 1, endLine)
			.join("\n");
		const byCode = text !== undefined && snippet !== undefined && normaliseSnippet(snippet) !== "";
		const identity = byCode
			? { snippet, occurrence: snippetOccurrence(text, snippet, { startLine: region.startLine, endLine }) }
			: { discriminator: result.message.text };
		const id = findingId({ file: pathAtHead(path), rule, snippet: identity.snippet ?? "", ...identity });
		const earlier = identified.get(id);
		identified.set(
			id,
			earlier === undefined
				? { id, result, path, rule, ...identity, count: 1 }
				: { ...earlier, count: earlier.count + 1 },
		);
	}
	return identified;
}

function triggerFor(revision: Revision, path: string, startLine: number, endLine: number): FindingTrigger | undefined {
	const file = revision.files.find((each) => each.path === path);
	const hunk = file?.hunks.find(
		(each) => each.newLines > 0 && startLine < each.newStart + each.newLines && endLine >= each.newStart,
	);
	if (hunk === undefined) return undefined;
	const added = hunk.text
		.split("\n")
		.filter((row) => row.startsWith("+"))
		.map((row) => row.slice(1))
		.join("\n");
	return { file: path, index: hunk.index, snippet: added };
}

/**
 * Turns one tool's results at base and head into findings, matched across the two runs by finding identity, never by
 * line. A result's snippet is the full text of its lines at its own revision, read through git's object store, and its
 * occurrence is counted there, so code an edit above moved keeps its ID. A result at head absent at base is
 * `introduced`; one at both is `pre-existing`, which never blocks; one only at base was resolved and is not reported.
 * Severity follows {@link staticSeverity}. A finding carries no resolution: only adjudication writes one.
 */
export async function staticFindings(input: StaticFindingsInput): Promise<CheckReport> {
	const { repoRoot, revision, tool } = input;
	const [baseReader, headReader] = await Promise.all([
		openSource(repoRoot, { kind: "revision", commit: revision.base }),
		openSource(repoRoot, { kind: "revision", commit: revision.head }),
	]);
	// A renamed file's base results are identified under its head path, so a pure rename introduces nothing.
	const renamed = new Map(
		revision.files.flatMap((file) => (file.oldPath === undefined ? [] : [[file.oldPath, file.path] as const])),
	);
	const [base, head] = await Promise.all([
		identify(tool, input.base, baseReader, (path) => renamed.get(path) ?? path),
		identify(tool, input.head, headReader, (path) => path),
	]);
	const version = input.head.runs[0].tool.driver.version;
	const findings: Finding[] = [];
	for (const each of head.values()) {
		const { region } = each.result.locations[0]!.physicalLocation;
		const endLine = Math.max(region.endLine ?? region.startLine, region.startLine);
		const before = base.get(each.id);
		const severity = staticSeverity(tool, each.rule, each.result.level, input.settings.severity);
		const sameLine = endLine === region.startLine;
		// Results of one rule on one set of lines share an ID, so presence alone would hide a second error added beside
		// an old one. What the head has beyond the base's count is introduced.
		const added = before === undefined ? 0 : each.count - before.count;
		const findingOf = (cause: "introduced" | "pre-existing", count: number, extra?: { discriminator: string }) => {
			const more = count > 1 ? ` (and ${count - 1} more on these lines)` : "";
			const message =
				extra === undefined
					? `${each.result.message.text}${more}`
					: `${count} more ${each.rule} result(s) on these lines than at the base: ${each.result.message.text}`;
			return Finding.create({
				rule: each.rule,
				message,
				file: each.path,
				startLine: region.startLine,
				endLine,
				startColumn: region.startColumn,
				endColumn: sameLine && (region.endColumn ?? 0) < (region.startColumn ?? 1) ? undefined : region.endColumn,
				snippet: extra === undefined ? each.snippet : undefined,
				occurrence: extra === undefined ? each.occurrence : undefined,
				discriminator: extra?.discriminator ?? each.discriminator,
				cause,
				trigger: cause === "introduced" ? triggerFor(revision, each.path, region.startLine, endLine) : undefined,
				severity,
				explanation: {
					what: each.result.message.text,
					whyHere:
						cause === "introduced"
							? `${tool} reports this at head but not at the base, so this change introduced it.`
							: `${tool} reports this at the base too, so it predates this change.`,
					whatToDo: `Change the code so ${tool} no longer reports ${each.rule}.`,
				},
				source: { check: checkOf(tool), version },
			});
		};
		if (before === undefined) findings.push(findingOf("introduced", each.count));
		else findings.push(findingOf("pre-existing", Math.min(each.count, before.count)));
		if (added > 0) findings.push(findingOf("introduced", added, { discriminator: `beyond the base at ${each.id}` }));
	}
	return { findings, notes: [] };
}
