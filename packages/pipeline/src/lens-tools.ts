import {
	type ChangedFile,
	checkEvidence,
	classifyCause,
	createFinding,
	type Finding,
	type LensRule,
	type LensToolName,
	lensCovers,
	listRevisionFiles,
	type ReportFindingInput,
	type Resolution,
	type RevisionEntry,
	readRevisionFile,
	reportFindingInputSchema,
	repositoryPath,
	type Severity,
	searchRevision,
	snippetOccurrence,
	visibleText,
} from "@melian-agent/core";
import { FindingsDocument, hasSighting, sightingCount, upsertFinding } from "./findings.ts";
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

/** A changed file as the review document keeps it: enough to classify cause, without the hunks' text. */
type ReviewFile = { path: string; status: ChangedFile["status"]; binary: boolean; hunks: ReviewHunk[] };

/** The revision a lens reviews, fixed when its lens task creates it. */
export type ReviewState = {
	repoRoot: string;
	/** This review's boundary nonce: head content reaches a lens only inside `quoteUntrusted` blocks carrying it. */
	nonce: string;
	base: string;
	head: string;
	files: ReviewFile[];
	resolution: Record<Severity, Resolution>;
};

/** The fields of `files` that the review document keeps. */
export function reviewFiles(files: readonly ChangedFile[]): ReviewFile[] {
	return files.map(({ path, status, binary, hunks }) => ({
		path,
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

/** What a lens conversation may do, written on it in the commit that creates it. */
export type LensPolicy = {
	name: string;
	version: string;
	/** The root conversation, which owns the review and its findings document. */
	review: ConversationId;
	/**
	 * The revision this lens reviews. Each lens carries its own, so a later review of the same changeset, whose lens task
	 * may start while a crashed one resumes, never moves an earlier lens to a different head.
	 */
	revision: ReviewState;
	tools: LensToolName[];
	severities: Severity[];
	rules: LensRule[];
	budget: number;
	/** Where the lens may report: its folder and paths, less any folder a nearer lens of its name covers. */
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

const maxReadLines = 2000;

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
		"Read a file as it is at the head revision under review, with line numbers. Reads up to 2000 lines from startLine.",
	parameters: Type.Object({
		path: Type.String({ minLength: 1, description: "Repository-relative path" }),
		startLine: Type.Optional(Type.Integer({ minimum: 1 })),
		endLine: Type.Optional(Type.Integer({ minimum: 1 })),
	}),
	replay: "safe",
	execute: async (args, api, context) => {
		const review = await headOf(api, api.conversationId, context);
		const file = await readRevisionFile(review.repoRoot, review.head, args.path);
		const lines = file.content.split("\n");
		if (lines.at(-1) === "" && !file.truncated) lines.pop();
		const start = args.startLine ?? 1;
		const end = Math.min(args.endLine ?? lines.length, start + maxReadLines - 1, lines.length);
		const width = String(end).length;
		const body = lines
			.slice(start - 1, end)
			.map((line, index) => `${String(start + index).padStart(width)}\t${line}`)
			.join("\n");
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
		const notes = truncated ? ["[more matches not shown; narrow the search]"] : [];
		return text([quoteUntrusted("search", lines.join("\n"), review.nonce), ...notes].join("\n"));
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
	execute: async (args, api, context) => {
		const review = await headOf(api, api.conversationId, context);
		const { entries, truncated } = await listRevisionFiles(review.repoRoot, review.head, args);
		if (entries.length === 0) return text("Empty.");
		const listing = quoteUntrusted("listing", entries.map(describeEntry).join("\n"), review.nonce);
		return text([listing, ...(truncated ? ["[more entries not shown]"] : [])].join("\n"));
	},
});

/**
 * The `injection_policy` section: in a lens conversation, the rule that everything inside this review's boundaries is
 * data. Lens conversations select only the lens extension, so it renders first, ahead of the lens's instructions.
 */
export const injectionPolicySection = section("injection_policy", async (input, context) => {
	const lens = (await input.read.snapshot(LensDocument, input.conversationId, context))?.lens;
	return lens === undefined ? undefined : injectionPolicy(lens.revision.nonce);
});

/** The read-only tools a lens may be offered, by the names `LENS.md` lists them under. */
export const lensReadTools = { read_file: readFile, search, list_files: listFiles } as const;

function overlapping(file: ReviewFile | undefined, startLine: number, endLine: number): ReviewHunk | undefined {
	return file?.hunks.find(
		(hunk) => hunk.newLines > 0 && startLine < hunk.newStart + hunk.newLines && endLine >= hunk.newStart,
	);
}

/**
 * Builds the finding a `report_finding` call describes. The snippet comes from the head revision at the reported
 * lines, never from the model, so a finding's ID does not depend on how the model quoted the code.
 */
async function headLines(review: ReviewState, path: string, line: number, endLine: number) {
	if (endLine < line) throw new Error(`endLine ${endLine} is before line ${line}`);
	const { content, truncated } = await readRevisionFile(review.repoRoot, review.head, path);
	const lines = content.split("\n");
	// A cut file's last line may be partial, and a whole file's final newline leaves an empty element that is no line.
	if (truncated || lines.at(-1) === "") lines.pop();
	if (endLine > lines.length) {
		const known = truncated ? `only its first ${lines.length} lines can be read` : `it has ${lines.length} lines`;
		throw new Error(`${path}:${endLine} is past what Melian can read at the head revision; ${known}`);
	}
	const snippet = lines.slice(line - 1, endLine).join("\n");
	if (snippet.trim() === "") throw new Error(`${path}:${line} is blank; point at the code itself`);
	return { content, snippet };
}

const proseEvidence =
	"evidence must be a location, { file, line, endLine }, naming lines this change added or modified that break the reported code. Prose is not evidence: put the reasoning in explanation.why, and leave evidence out for a finding inside the change";

// Evidence must name changed code; Melian reads its snippet from the head, so prose can never make a finding affected.
async function evidenceFrom(args: NonNullable<ReportFindingInput["evidence"]>, review: ReviewState) {
	const file = repositoryPath(args.file);
	const endLine = args.endLine ?? args.line;
	checkEvidence({ file, startLine: args.line, endLine }, { files: changedFiles(review) });
	const { snippet } = await headLines(review, file, args.line, endLine);
	return { file, startLine: args.line, ...(args.endLine === undefined ? {} : { endLine }), snippet };
}

// The snippet comes from the head revision at the reported lines, never from the model, so a finding's ID does not
// depend on how the model quoted the code.
async function findingFromCall(args: ReportFindingInput, lens: LensPolicy, review: ReviewState): Promise<Finding> {
	const path = repositoryPath(args.file);
	if (!lensCovers(lens.coverage, path)) {
		throw new Error(`${path} is outside the paths lens ${lens.name} reviews; report only within them`);
	}
	const endLine = args.endLine ?? args.line;
	const { content, snippet } = await headLines(review, path, args.line, endLine);
	const located = classifyCause({ file: path, startLine: args.line, endLine }, { files: changedFiles(review) });
	const changed = review.files.find((file) => file.path === path);
	const hunk = located === "introduced" ? overlapping(changed, args.line, endLine) : undefined;
	const evidence =
		located === "introduced" || args.evidence === undefined ? undefined : await evidenceFrom(args.evidence, review);
	const { severity } = args;
	return createFinding({
		rule: args.rule,
		message: args.explanation.what,
		file: path,
		startLine: args.line,
		...(args.endLine === undefined ? {} : { endLine }),
		snippet,
		occurrence: snippetOccurrence(content, snippet, { startLine: args.line, endLine }),
		cause: evidence === undefined ? located : { evidence },
		...(hunk === undefined
			? {}
			: {
					trigger: { file: hunk.file, index: hunk.index, snippet: hunk.added },
				}),
		severity,
		resolution: review.resolution[severity],
		explanation: {
			what: args.explanation.what,
			whyHere: args.explanation.why,
			whatToDo: args.explanation.fix,
		},
		source: { check: `lens.${lens.name}`, version: lens.version },
	});
}

/**
 * `report_finding`: the only way a finding leaves a lens. An idempotent upsert into the root conversation's findings
 * document, keyed by the finding's stable ID, so it is safe to replay after a crash. The budget is checked inside the
 * commit, where parallel calls in one round see each other's findings, and where a finding this lens already reported
 * at this head always passes, so a replay or a correction succeeds at a full budget.
 */
export const reportFinding = defineTool({
	name: "report_finding",
	description:
		"Report one finding at the head revision: the file and lines of the flagged code, one of your rules, a severity, and an explanation. Call once per finding; never report findings in prose.",
	parameters: reportFindingInputSchema,
	// Runs before validation, so prose evidence gets a reply saying what evidence must be, not a schema error.
	prepareArguments: (args) => {
		if (typeof (args as { evidence?: unknown } | undefined)?.evidence === "string") throw new Error(proseEvidence);
		return args as ReportFindingInput;
	},
	replay: "safe",
	execute: async (args, api, context) => {
		const lens = await lensOf(api, api.conversationId, context);
		const review = lens.revision;
		const finding = await findingFromCall(args, lens, review);
		const id = finding.properties.id;
		await api.commit(async (tx) => {
			// One storage holds every review of a changeset, so the budget counts this lens's sightings at its own head.
			const state = await tx.doc(FindingsDocument, lens.review);
			const { source } = finding.properties;
			const own = hasSighting(state, id, review.head, source);
			if (!own && sightingCount(state, review.head, source) >= lens.budget) {
				throw new Error(`budget reached: this lens may report ${lens.budget} findings; stop reporting and finish`);
			}
			await upsertFinding(tx, lens.review, finding, review.head);
		}, context);
		return text(`recorded finding ${id}`);
	},
});

/**
 * Enforces each lens's policy before a tool call runs: only the tools the lens lists plus `report_finding`, and only its
 * severities and rules. `report_finding` checks the budget inside its commit, where it can tell a new finding from a
 * correction of one the lens already reported. Calls in conversations that are not lenses pass untouched.
 */
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
