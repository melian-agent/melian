import {
	type ChangedFile,
	capSnippet,
	changeOverlap,
	classifyCause,
	createFinding,
	type EvidenceLocation,
	type Finding,
	type LensRule,
	type LensToolName,
	lensCovers,
	listRevisionFiles,
	maxEvidenceLines,
	maxEvidenceLocations,
	maxFailureScenarioLength,
	type ReportFindingInput,
	type RevisionEntry,
	RevisionError,
	readRevisionFile,
	reportFindingInputSchema,
	repositoryPath,
	type Severity,
	searchRevision,
	snippetOccurrence,
	visibleText,
} from "@melian-agent/core";
import { FindingsDocument, hasSighting, revisionKey, sightingCount, upsertFinding } from "./findings.ts";
import {
	type Context,
	type ConversationId,
	type DocumentReader,
	defineDoc,
	defineTool,
	hook,
	section,
	ToolTask,
	Type,
} from "./harness.ts";
import { injectionPolicy, quoteUntrusted } from "./untrusted.ts";

// `added` is the hunk's new lines, the code a dismissal is tied to.
type ReviewHunk = {
	file: string;
	index: number;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	added: string;
};

// A changed file as the review document keeps it: enough to classify cause, without the hunks' text. `oldPath` names a
// renamed file at the base, where evidence on its deleted lines points.
type ReviewFile = {
	path: string;
	oldPath?: string;
	status: ChangedFile["status"];
	binary: boolean;
	hunks: ReviewHunk[];
};

// The revision a lens reviews, fixed when its lens task creates it.
export type ReviewState = {
	repoRoot: string;
	// This review's boundary nonce: head content reaches a lens only inside `quoteUntrusted` blocks carrying it.
	nonce: string;
	base: string;
	head: string;
	files: ReviewFile[];
};

// The fields of `files` that the review document keeps.
export function reviewFiles(files: readonly ChangedFile[]): ReviewFile[] {
	return files.map(({ path, oldPath, status, binary, hunks }) => ({
		path,
		...(oldPath === undefined ? {} : { oldPath }),
		status,
		binary,
		hunks: hunks.map(({ file, index, oldStart, oldLines, newStart, newLines, text }) => ({
			file,
			index,
			oldStart,
			oldLines,
			newStart,
			newLines,
			added: text
				.split("\n")
				.filter((line) => line.startsWith("+"))
				.map((line) => line.slice(1))
				.join("\n"),
		})),
	}));
}

function changedFiles(review: ReviewState): ChangedFile[] {
	return review.files.map((file) => ({
		...file,
		hunks: file.hunks.map(({ added: _, ...hunk }) => ({ ...hunk, header: "", text: "" })),
	}));
}

// What a lens conversation may do, written on it in the commit that creates it.
export type LensPolicy = {
	name: string;
	version: string;
	// The root conversation, which owns the review and its findings document.
	review: ConversationId;
	// The revision this lens reviews. Each lens carries its own, so a later review of the same changeset, whose lens task
	// may start while a crashed one resumes, never moves an earlier lens to a different head.
	revision: ReviewState;
	tools: LensToolName[];
	severities: Severity[];
	rules: LensRule[];
	budget: number;
	// Where the lens may report: its folder and paths, less any folder a nearer lens of its name covers.
	coverage: { scope: string; paths: string[]; nearer: string[] };
};

export const LensDocument = defineDoc<{ lens?: LensPolicy }>({
	kind: "melian.lens",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
});

// What one read_file call returns, at most. The file itself is read whole, so any line can be reached by startLine.
const maxReadLines = 2000;

// Pi Durable cuts a tool's result at 50 KB or 2000 lines unless the tool says otherwise, which would drop a boundary's
// closing tag and Melian's notes. Each tool bounds the body it quotes below that, and sets Pi's limit above it.
const maxShownBytes = 48 * 1024;
const outputLimits = { maxBytes: 64 * 1024, maxLines: maxReadLines + 50 } as const;

// The leading rows that fit in `maxShownBytes`, joined by newlines; a first row too long alone is cut to fit.
function fitting(rows: readonly string[]): { body: string; count: number } {
	const shown: string[] = [];
	let size = 0;
	for (const row of rows) {
		const bytes = Buffer.byteLength(row) + 1;
		if (size + bytes > maxShownBytes) {
			if (shown.length === 0)
				shown.push(
					`${Buffer.from(row)
						.subarray(0, maxShownBytes - 64)
						.toString()} [line cut]`,
				);
			break;
		}
		shown.push(row);
		size += bytes;
	}
	return { body: shown.join("\n"), count: shown.length };
}

async function lensOf(reader: DocumentReader, conversationId: ConversationId, context: Context): Promise<LensPolicy> {
	const lens = (await reader.snapshot(LensDocument, conversationId, context))?.lens;
	if (lens === undefined) throw new Error("this tool runs only inside a Melian lens conversation");
	return lens;
}

async function headOf(reader: DocumentReader, conversationId: ConversationId, context: Context) {
	return (await lensOf(reader, conversationId, context)).revision;
}

function text(content: string) {
	return { content: [{ type: "text" as const, text: content }] };
}

const readFile = defineTool({
	name: "read_file",
	description:
		'Read a file as it is at the head revision under review, or at the base with revision "base", with line numbers: up to maxLines lines, at most 2000, from startLine. Any line of the file can be reached by startLine.',
	parameters: Type.Object({
		path: Type.String({ minLength: 1, description: "Repository-relative path at the named revision" }),
		startLine: Type.Optional(Type.Integer({ minimum: 1, description: "First line to read; 1 when absent" })),
		maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: maxReadLines, description: "At most 2000" })),
		revision: Type.Optional(
			Type.Union([Type.Literal("head"), Type.Literal("base")], {
				description:
					"head by default; base to read code this change deleted, numbered as evidence with revision base is, naming a renamed file by its old path",
			}),
		),
	}),
	replay: "safe",
	outputLimits,
	execute: async (args, api, context) => {
		const review = await headOf(api, api.conversationId, context);
		const commit = args.revision === "base" ? review.base : review.head;
		const file = await readRevisionFile(review.repoRoot, commit, args.path);
		const lines = file.content.split("\n");
		if (lines.at(-1) === "" && !file.truncated) lines.pop();
		const start = args.startLine ?? 1;
		const last = Math.min(start + (args.maxLines ?? maxReadLines) - 1, lines.length);
		const width = String(last).length;
		const window = lines
			.slice(start - 1, last)
			.map((line, index) => `${String(start + index).padStart(width)}\t${line}`);
		const { body, count } = fitting(window);
		const end = start - 1 + count;
		const notes = [
			end < lines.length ? `[lines ${end + 1} onward not shown; read again with startLine ${end + 1}]` : undefined,
			file.truncated ? `[the file is ${file.size} bytes; only the first part was read]` : undefined,
			start > lines.length ? `[the file has ${lines.length} lines]` : undefined,
		].filter((note) => note !== undefined);
		return text([quoteUntrusted("file", body, review.nonce), ...notes].join("\n"));
	},
});

const search = defineTool({
	name: "search",
	description:
		"Search the files at the head revision under review, like git grep. Returns path:line: text for each matching line.",
	parameters: Type.Object({
		pattern: Type.String({ minLength: 1 }),
		regex: Type.Optional(Type.Boolean({ description: "Read pattern as an extended regular expression" })),
		ignoreCase: Type.Optional(Type.Boolean()),
		path: Type.Optional(Type.String({ description: "Search only this file or directory" })),
	}),
	replay: "safe",
	outputLimits,
	execute: async (args, api, context) => {
		const review = await headOf(api, api.conversationId, context);
		// The base's attributes decide what is binary, as they do for the diff, so a head cannot hide its files.
		const search = { ...args, attributesFrom: review.base };
		const { matches, truncated } = await searchRevision(review.repoRoot, review.head, search);
		// A single matching line longer than the output bound leaves nothing whole to show; that is not "no matches".
		if (matches.length === 0 && truncated)
			return text("[matches found, but their lines are too long to show; narrow the search with path]");
		if (matches.length === 0) return text("No matches.");
		const lines = matches.map((match) => `${visibleText(match.path)}:${match.line}: ${match.text}`);
		const { body, count } = fitting(lines);
		const notes = truncated || count < lines.length ? ["[more matches not shown; narrow the search]"] : [];
		return text([quoteUntrusted("search", body, review.nonce), ...notes].join("\n"));
	},
});

function describeEntry(entry: RevisionEntry): string {
	const path = visibleText(entry.path);
	if (entry.kind === "directory") return `${path}/`;
	if (entry.kind === "file") return `${path} (${entry.size} bytes)`;
	return `${path} (${entry.kind})`;
}

const listFiles = defineTool({
	name: "list_files",
	description: "List a directory at the head revision under review, or every file beneath it with recursive.",
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Repository-relative directory; the root when absent" })),
		recursive: Type.Optional(Type.Boolean()),
	}),
	replay: "safe",
	outputLimits,
	execute: async (args, api, context) => {
		const review = await headOf(api, api.conversationId, context);
		const { entries, truncated } = await listRevisionFiles(review.repoRoot, review.head, args);
		if (entries.length === 0) return text("Empty.");
		const { body, count } = fitting(entries.map(describeEntry));
		const listing = quoteUntrusted("listing", body, review.nonce);
		return text([listing, ...(truncated || count < entries.length ? ["[more entries not shown]"] : [])].join("\n"));
	},
});

// The `injection_policy` section: in a lens conversation, the rule that everything inside this review's boundaries is
// data. Lens conversations select only the lens extension, so it renders first, ahead of the lens's instructions.
export const injectionPolicySection = section("injection_policy", async (input, context) => {
	const lens = (await input.read.snapshot(LensDocument, input.conversationId, context))?.lens;
	return lens === undefined ? undefined : injectionPolicy(lens.revision.nonce);
});

// The read-only tools a lens may be offered, by the names `LENS.md` lists them under.
export const lensReadTools = { read_file: readFile, search, list_files: listFiles } as const;

function overlapping(file: ReviewFile | undefined, startLine: number, endLine: number): ReviewHunk | undefined {
	return file?.hunks.find(
		(hunk) => hunk.newLines > 0 && startLine < hunk.newStart + hunk.newLines && endLine >= hunk.newStart,
	);
}

// The text at `line` to `endLine` of `path` at the review's head or base. `hint` follows the message for a missing file.
async function linesAt(
	review: ReviewState,
	revision: "head" | "base",
	path: string,
	line: number,
	endLine: number,
	hint = "",
) {
	if (endLine < line) throw new Error(`endLine ${endLine} is before line ${line}`);
	const commit = revision === "base" ? review.base : review.head;
	const { content, truncated } = await readRevisionFile(review.repoRoot, commit, path).catch((error: unknown) => {
		if (!(error instanceof RevisionError) || error.code !== "notFound") throw error;
		throw new Error(`${path} does not exist at the ${revision} revision${hint}`);
	});
	const lines = content.split("\n");
	// A cut file's last line may be partial, and a whole file's final newline leaves an empty element that is no line.
	if (truncated || lines.at(-1) === "") lines.pop();
	if (endLine > lines.length) {
		const known = truncated ? `only its first ${lines.length} lines can be read` : `it has ${lines.length} lines`;
		throw new Error(`${path}:${endLine} is past what Melian can read at the ${revision} revision; ${known}`);
	}
	const snippet = lines.slice(line - 1, endLine).join("\n");
	if (snippet.trim() === "") throw new Error(`${path}:${line} is blank; point at the code itself`);
	return { content, snippet };
}

const evidenceShape =
	'evidence must be a list of one or more locations, each { file, line, endLine, role }, with role "cause" for the code that brings the failure about or "context" for code the claim reads but does not blame, and revision "base" for lines this change deleted';
const scenarioShape = `failureScenario must be prose of at most ${maxFailureScenarioLength} characters naming the concrete input, state, or sequence that makes the code fail, and the wrong outcome it produces`;

// What a call's failure scenario or evidence must be, when it is missing or malformed, so the model reads how to fix
// its call rather than a schema error. Undefined when both look right; the schema then checks the rest.
function malformed(args: unknown): string | undefined {
	const { failureScenario, evidence } = (args ?? {}) as { failureScenario?: unknown; evidence?: unknown };
	if (typeof failureScenario !== "string" || failureScenario.trim() === "")
		return `${scenarioShape}; it is missing or blank`;
	if (failureScenario.length > maxFailureScenarioLength) {
		return `${scenarioShape}; this one has ${failureScenario.length}`;
	}
	if (typeof evidence === "string") {
		return `${evidenceShape}. Prose is not evidence: put the reasoning in explanation.why and failureScenario`;
	}
	if (!Array.isArray(evidence) || evidence.length === 0) return `${evidenceShape}; it is missing or empty`;
	if (evidence.length > maxEvidenceLocations) return `${evidenceShape}, at most ${maxEvidenceLocations} of them`;
	const bad = evidence.findIndex(
		(location) =>
			location === null ||
			typeof location !== "object" ||
			!["cause", "context"].includes((location as { role?: unknown }).role as string),
	);
	return bad === -1 ? undefined : `${evidenceShape}; evidence[${bad}] is not one`;
}

// Melian reads each location's snippet from the revision it names, so the evidence a verifier and the author see is
// the code itself, never the model's quotation of it.
async function evidenceFrom(args: ReportFindingInput["evidence"], review: ReviewState): Promise<EvidenceLocation[]> {
	// A call an older Melian stored before a crash resumes here without passing prepareArguments or the schema again.
	if (!Array.isArray(args)) throw new Error(evidenceShape);
	return await Promise.all(
		args.map(async ({ file: given, line, endLine: last, role, revision = "head" }) => {
			const file = repositoryPath(given);
			const endLine = last ?? line;
			if (endLine - line >= maxEvidenceLines) {
				throw new Error(
					`evidence ${file}:${line}-${endLine} spans more than ${maxEvidenceLines} lines; name the lines that matter`,
				);
			}
			const hint =
				revision === "head"
					? '; for lines this change deleted, add revision: "base" to the location, naming a renamed file by its old path'
					: "";
			const { snippet } = await linesAt(review, revision, file, line, endLine, hint);
			const deleted =
				revision === "base" &&
				changeOverlap({ file, startLine: line, endLine, revision }, { files: changedFiles(review) }) !== undefined;
			return {
				file,
				startLine: line,
				...(last === undefined ? {} : { endLine }),
				role,
				revision,
				...(deleted ? { deleted } : {}),
				snippet: capSnippet(snippet).text,
			};
		}),
	);
}

// The snippet comes from the head revision at the reported lines, never from the model, so a finding's ID does not
// depend on how the model quoted the code. A cut snippet's occurrence is its kept prefix's, which starts at the
// reported line as the whole snippet does.
async function findingFromCall(args: ReportFindingInput, lens: LensPolicy, review: ReviewState): Promise<Finding> {
	const path = repositoryPath(args.file);
	if (!lensCovers(lens.coverage, path)) {
		throw new Error(`${path} is outside the paths lens ${lens.name} reviews; report only within them`);
	}
	const endLine = args.endLine ?? args.line;
	const { content, snippet: whole } = await linesAt(review, "head", path, args.line, endLine);
	const { text: snippet, kept } = capSnippet(whole);
	const evidence = await evidenceFrom(args.evidence, review);
	const location = { file: path, startLine: args.line, endLine };
	const cause = classifyCause(location, { files: changedFiles(review) }, evidence);
	const changed = review.files.find((file) => file.path === path);
	const hunk = cause === "introduced" ? overlapping(changed, args.line, endLine) : undefined;
	const { severity } = args;
	return createFinding({
		rule: args.rule,
		message: args.explanation.what,
		file: path,
		startLine: args.line,
		...(args.endLine === undefined ? {} : { endLine }),
		snippet,
		occurrence: snippetOccurrence(content, kept, { startLine: args.line, endLine }),
		cause,
		failureScenario: args.failureScenario,
		evidence,
		...(hunk === undefined
			? {}
			: {
					trigger: { file: hunk.file, index: hunk.index, snippet: capSnippet(hunk.added).text },
				}),
		severity,
		explanation: {
			what: args.explanation.what,
			whyHere: args.explanation.why,
			whatToDo: args.explanation.fix,
		},
		source: { check: `lens.${lens.name}`, version: lens.version },
	});
}

// `report_finding`: the only way a finding leaves a lens. An idempotent upsert into the root conversation's findings
// document, keyed by the finding's stable ID, so it is safe to replay after a crash. The budget is checked inside the
// commit, where parallel calls in one round see each other's findings, and where a finding this lens already reported
// at this head always passes, so a replay or a correction succeeds at a full budget.
export const reportFinding = defineTool({
	name: "report_finding",
	description:
		"Report one finding at the head revision: the file and lines of the flagged code, one of your rules, a severity, an explanation, a failure scenario, and evidence locations. Call once per finding; never report findings in prose.",
	parameters: reportFindingInputSchema,
	outputLimits,
	// Runs before validation, so a missing or malformed failure scenario or evidence gets a reply saying what it must be,
	// not a schema error.
	prepareArguments: (args) => {
		const problem = malformed(args);
		if (problem !== undefined) throw new Error(problem);
		return args as ReportFindingInput;
	},
	replay: "safe",
	execute: async (args, api, context) => {
		const lens = await lensOf(api, api.conversationId, context);
		const review = lens.revision;
		const finding = await findingFromCall(args, lens, review);
		const id = finding.properties.id;
		await api.commit(async (tx) => {
			// One storage holds every review of a changeset, so the budget counts this lens's sightings at its own revision.
			const state = await tx.doc(FindingsDocument, lens.review);
			const { source } = finding.properties;
			const at = revisionKey(review);
			const own = hasSighting(state, id, at, source);
			if (!own && sightingCount(state, at, source) >= lens.budget) {
				throw new Error(`budget reached: this lens may report ${lens.budget} findings; stop reporting and finish`);
			}
			await upsertFinding(tx, lens.review, finding, at);
		}, context);
		const { cause, evidence = [] } = finding.properties;
		const unproven =
			cause === "pre-existing"
				? ": it is outside the change, and no cause location overlaps lines the change added, modified, or deleted, or a file it renamed"
				: "";
		// Each location's first line as Melian read it, so a lens that miscounted a line number sees what it cited.
		const { body } = fitting(
			evidence.map(
				({ file, startLine, role, revision, snippet }) =>
					`${role} ${visibleText(file)}:${startLine}${revision === "base" ? " at base" : ""}: ${snippet.split("\n")[0]}`,
			),
		);
		const cited = quoteUntrusted("evidence", body, review.nonce);
		return text(`recorded finding ${id} as ${cause}${unproven}\nThe first line of each evidence location:\n${cited}`);
	},
});

// Enforces each lens's policy before a tool call runs: only the tools the lens lists plus `report_finding`, and only
// its severities and rules. `report_finding` checks the budget inside its commit, where it can tell a new finding from
// a correction of one the lens already reported. Calls in conversations that are not lenses pass untouched.
export const lensPolicyHook = hook(ToolTask, {
	beforeTool: async (call, api, context) => {
		const lens = (await api.snapshot(LensDocument, api.conversationId, context))?.lens;
		if (lens === undefined) return undefined;
		const allowed = [...lens.tools, reportFinding.name];
		if (!allowed.includes(call.name as LensToolName)) {
			return { block: `lens ${lens.name} may call only ${allowed.join(", ")}` };
		}
		if (call.name !== reportFinding.name) return undefined;
		const { severity, rule } = call.arguments as { severity?: unknown; rule?: unknown };
		if (!lens.severities.includes(severity as Severity)) {
			return {
				block: `severity ${String(severity)} is outside this lens's severities: ${lens.severities.join(", ")}`,
			};
		}
		if (!lens.rules.some((each) => each.id === rule)) {
			const rules = lens.rules.map((each) => `${each.id} (${each.description})`).join("; ");
			return { block: `rule ${String(rule)} is not one of this lens's rules: ${rules}` };
		}
		return undefined;
	},
});
