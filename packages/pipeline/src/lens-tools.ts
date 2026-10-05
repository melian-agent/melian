import {
	type ChangedFile,
	capSnippet,
	type EvidenceLocation,
	Finding,
	type FindingSource,
	type FindingTrigger,
	type LensRule,
	type LensToolName,
	lensCovers,
	listRevisionFiles,
	maxEvidenceLines,
	maxEvidenceLocations,
	maxFailureScenarioLength,
	type ProvingHunk,
	type ReportFindingInput,
	Revision,
	type RevisionEntry,
	RevisionError,
	readRevisionFile,
	reportFindingInputSchema,
	repositoryPath,
	type ScrutinyLevel,
	type Severity,
	searchRevision,
	snippetHash,
	snippetOccurrence,
	visibleText,
} from "@melian-agent/core";
import { FindingsDocument, hasSighting, revisionKey, sightingCount, upsertFinding } from "./findings.ts";
import {
	AssistantEntry,
	type Context,
	type ConversationId,
	type DocumentReader,
	defineDoc,
	defineTool,
	hook,
	LiveDoc,
	section,
	type TaskId,
	type ToolCall,
	type ToolExecutionApi,
	type ToolRegistration,
	ToolTask,
	type ToolTaskInput,
	type Tx,
	Type,
	UsageDoc,
	type UsageState,
	validateToolArguments,
} from "./harness.ts";
import { ReviewIndex } from "./review-index.ts";
import { injectionAttemptRule, injectionPolicy, injectionSeverity, quoteUntrusted } from "./untrusted.ts";

// `added` is the hunk's new lines, the code a dismissal of an introduced finding is tied to. `changes` is its added and
// removed lines in diff order, each keeping its `+` or `-`, the code a dismissal of an affected finding is tied to;
// absent from a lens an older Melian created.
type ReviewHunk = {
	file: string;
	index: number;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	added: string;
	changes?: string;
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

// A lens's findings name its version with the level it ran at, so one lens at two levels of a revision is two producers.
export function lensSource(name: string, version: string, level: ScrutinyLevel | undefined): FindingSource {
	return { check: `lens.${name}`, version: level === undefined ? version : `${version}@${level}` };
}

// The fields of `files` that the review document keeps.
export function reviewFiles(files: readonly ChangedFile[]): ReviewFile[] {
	return files.map(({ path, oldPath, status, binary, hunks }) => ({
		path,
		...(oldPath === undefined ? {} : { oldPath }),
		status,
		binary,
		hunks: hunks.map(({ file, index, oldStart, oldLines, newStart, newLines, text }) => {
			const changes = text.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-"));
			return {
				file,
				index,
				oldStart,
				oldLines,
				newStart,
				newLines,
				added: changes
					.filter((line) => line.startsWith("+"))
					.map((line) => line.slice(1))
					.join("\n"),
				changes: changes.join("\n"),
			};
		}),
	}));
}

// What a lens conversation may do, written on it in the commit that creates it.
export type LensPolicy = {
	name: string;
	version: string;
	// The level it runs at, which its findings' source names; absent from a lens an older Melian created, whose findings
	// name the lens's version alone.
	level?: ScrutinyLevel;
	// The root conversation, which owns the review and its findings document.
	review: ConversationId;
	// The revision this lens reviews. Each lens carries its own, so a later review of the same changeset, whose lens task
	// may start while a crashed one resumes, never moves an earlier lens to a different head.
	revision: ReviewState;
	tools: LensToolName[];
	severities: Severity[];
	rules: LensRule[];
	// The findings budget.
	budget: number;
	// The lens task that runs it, which the review index must still name for the revision for a report to count; absent
	// from a lens an older Melian created.
	task?: number;
	// The level's token and tool budgets; absent from a lens an older Melian created, which enforces neither.
	limits?: { tokens?: number; tools?: number };
	// Where the lens may report: its folder and paths, less any folder a nearer lens of its name covers, and the head
	// path of each file the review moved out of them.
	coverage: { scope: string; paths: string[]; nearer: string[]; moved?: string[] };
};

// What a lens has spent that Pi's usage document does not hold: the tool task of every call the tools budget counted,
// never one it refused, the first budget the lens ran out of, recorded by the call that ended the conversation for it,
// and the tool task of every `report_finding` call by the finding it reported. Pi mints a task per call and keeps it
// across a replay, where a provider may reuse a call ID in every round.
// `refuted` holds the IDs of findings the lens reported as not a defect, which an escalated run is asked to check.
type LensSpend = {
	calls: number[];
	ended?: "tokens" | "tools";
	reports?: Record<string, number[]>;
	refuted?: string[];
};

export const LensDocument = defineDoc<{ lens?: LensPolicy; spend?: LensSpend }>({
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

function text(content: string) {
	return { content: [{ type: "text" as const, text: content }] };
}

// Input tokens, cache writes included, and output tokens of every model response in the conversation. Cache reads are
// left out: they re-read context a provider has already counted once.
function tokensUsed(usage: Readonly<UsageState> | undefined): number {
	return Object.values(usage?.models ?? {}).reduce((sum, each) => sum + each.input + each.cacheWrite + each.output, 0);
}

type Spent = "tokens" | "tools";

type Metered = { position: number; spent?: Spent };

type Slot = { callId: string; name: string; taskId?: number };

// The round's slots, from `LiveDoc`, which lists every call of the round in call order when it starts, and the tokens
// the conversation has used, which Pi records with each response before its round runs. A call of a sequential round
// that has not started has no task yet, but keeps its place.
async function roundState(reader: DocumentReader, conversationId: ConversationId, context: Context) {
	const slots: readonly Slot[] = (await reader.snapshot(LiveDoc, conversationId, context))?.tools ?? [];
	const used = tokensUsed(await reader.snapshot(UsageDoc, conversationId, context));
	return { slots, used };
}

// The tool tasks of the round's counted calls, to the read-only tools and `report_finding` that `reaches` admits, in
// call order; whether those hold a read; and the tokens used before the round.
function roundOf(
	lens: LensPolicy,
	{ slots, used }: Awaited<ReturnType<typeof roundState>>,
	reaches: (slot: Slot) => boolean,
) {
	const reads: readonly string[] = lens.tools;
	const counted = slots.filter(
		(slot) => (reads.includes(slot.name) || slot.name === "report_finding") && reaches(slot),
	);
	const round = counted.map((slot) => slot.taskId);
	return { round, reads: counted.some((slot) => reads.includes(slot.name)), used };
}

type Round = ReturnType<typeof roundOf>;

// The calls of this task's round that reach their tool: arguments the tool's repair and Pi's validator accept, in the
// order Pi applies them, and that the lens's policy allows. Read from the assistant entry that started the round,
// which never changes, so every call of the round and every replay admits the same calls.
async function reachingCalls(tx: Tx, taskId: TaskId, lens: LensPolicy): Promise<Set<string>> {
	const input = (await tx.task(taskId))?.input as ToolTaskInput | undefined;
	const entry = input === undefined ? undefined : await tx.entry(AssistantEntry, input.assistant);
	const message = entry?.model?.[0];
	const calls = message?.role === "assistant" ? message.content.filter((each) => each.type === "toolCall") : [];
	return new Set(calls.filter((call) => reaches(lens, call)).map((call) => call.id));
}

function reaches(lens: LensPolicy, call: ToolCall): boolean {
	const tool = lensTools.find((each) => each.name === call.name);
	if (tool === undefined) return false;
	try {
		const prepared = tool.prepareArguments === undefined ? call.arguments : tool.prepareArguments(call.arguments);
		const args: unknown = validateToolArguments(tool, { ...call, arguments: prepared as ToolCall["arguments"] });
		return refusal(lens, { name: call.name, arguments: args }) === undefined;
	} catch {
		return false;
	}
}

// Which budget ends a round, from what every call of the round reads alike: the tokens used before it, or a read in a
// round that starts with the tools budget already used. The round that crosses the tools budget goes on, its excess
// reads refused, so the lens sees the reads that ran and can report what they showed.
function spentBy(lens: LensPolicy, calls: readonly number[], { round, reads, used }: Round): Spent | undefined {
	const { tokens, tools } = lens.limits ?? {};
	if (tokens !== undefined && used >= tokens) return "tokens";
	const earlier = calls.filter((id) => !round.includes(id)).length;
	return tools !== undefined && reads && earlier >= tools ? "tools" : undefined;
}

// Whether the round of this call ends the conversation, read without writing, as a hook must. A hook cannot read the
// round's other calls, so it counts every call by name; a call it lets through that the tools' count leaves out is
// refused by its tool.
async function roundEnds(api: DocumentReader & { conversationId: ConversationId }, lens: LensPolicy, context: Context) {
	if (lens.limits?.tokens === undefined && lens.limits?.tools === undefined) return false;
	const round = roundOf(lens, await roundState(api, api.conversationId, context), () => true);
	const calls = (await api.snapshot(LensDocument, api.conversationId, context))?.spend?.calls ?? [];
	return spentBy(lens, calls, round) !== undefined;
}

// Counts a call by its task and decides, from durable state alone, its number against the tools budget and whether its
// round ends the conversation. The round's calls that reach a tool are numbered in call order, so a call's number and
// its round's ending never depend on which call commits first.
async function meter(
	api: ToolExecutionApi,
	lens: LensPolicy,
	call: "read" | "report",
	context: Context,
): Promise<Metered> {
	const { tokens, tools } = lens.limits ?? {};
	if (tokens === undefined && tools === undefined) return { position: 0 };
	const state = await roundState(api, api.conversationId, context);
	return api.commit(async (tx) => {
		const reaching = await reachingCalls(tx, api.taskId, lens);
		const round = roundOf(lens, state, (slot) => reaching.has(slot.callId));
		const document = await tx.doc(LensDocument, api.conversationId);
		// Read back through the document: the object assigned is copied in, and changes to it afterwards would be lost.
		document.spend ??= { calls: [] };
		const { spend } = document;
		const earlier = spend.calls.filter((id) => !round.round.includes(id)).length;
		// A call its policy refuses is in no position: its tool refuses it, and it never counts.
		const index = round.round.indexOf(api.taskId);
		const position = earlier + index + 1;
		const past = index !== -1 && tools !== undefined && position > tools;
		const spent = spentBy(lens, spend.calls, round);
		if (spent !== undefined) spend.ended ??= spent;
		// A refused read is reduced coverage, recorded now: a lens that follows the refusal note never reads again.
		if (call === "read" && past) spend.ended ??= "tools";
		// Only a call within the budget counts, so the count a budget's end reports never passes its limit.
		const counts = spent === undefined && index !== -1 && !past;
		if (counts && !spend.calls.includes(api.taskId)) spend.calls.push(api.taskId);
		return { position, ...(spent === undefined ? {} : { spent }) };
	}, context);
}

type ToolResult = {
	content?: { type: "text"; text: string }[];
	isError?: boolean;
	diagnostics?: { severity: "error"; code: string; message: string }[];
};

// A throw ends a call with no result to carry the budget's ending, so an error becomes a result, rendered as Pi
// renders a throw.
function failed(error: unknown, context: Context): ToolResult {
	if (context.abortSignal?.aborted) throw error;
	const message = error instanceof Error ? error.message : String(error);
	return { isError: true, diagnostics: [{ severity: "error", code: "tool_error", message }] };
}

function toolCalls(count: number | undefined): string {
	return `${count} tool ${count === 1 ? "call" : "calls"}, report_finding included`;
}

const budgetEnds = "The review ends after this round with the findings reported so far.";

// A spent budget ends the conversation after this round. Pi ends a run when every call of a round asks to `terminate`,
// or when any one hands off, so a handoff ends it whatever the round's other calls returned.
function ending(result: ToolResult, lens: LensPolicy, spent: Spent | undefined) {
	if (spent === undefined) return result;
	const why =
		spent === "tokens"
			? `this lens has used its budget of ${lens.limits?.tokens?.toLocaleString("en-AU")} tokens`
			: `this lens has used its budget of ${toolCalls(lens.limits?.tools)}`;
	const note = `[${why}. ${budgetEnds}]`;
	return {
		...result,
		content: [...(result.content ?? []), { type: "text" as const, text: note }],
		control: { handoff: note },
	};
}

// What the lens's policy refuses in `call`, or undefined: a tool it does not list, and for `report_finding`, a severity
// or a rule outside its own. An injection attempt at P1 always passes, because the injection policy orders every lens
// to report one at P1, whatever severities the lens declares.
function refusal(lens: LensPolicy, call: { name: string; arguments: unknown }): string | undefined {
	const allowed: readonly string[] = [...lens.tools, "report_finding"];
	if (!allowed.includes(call.name)) return `lens ${lens.name} may call only ${allowed.join(", ")}`;
	if (call.name !== "report_finding") return undefined;
	const { severity, rule } = (call.arguments ?? {}) as { severity?: unknown; rule?: unknown };
	const injection = rule === injectionAttemptRule.id && severity === injectionSeverity;
	if (!injection && !lens.severities.includes(severity as Severity)) {
		return `severity ${String(severity)} is outside this lens's severities: ${lens.severities.join(", ")}`;
	}
	if (!lens.rules.some((each) => each.id === rule)) {
		const rules = lens.rules.map((each) => `${each.id} (${each.description})`).join("; ");
		return `rule ${String(rule)} is not one of this lens's rules: ${rules}`;
	}
	return undefined;
}

// Runs a read-only tool within the lens's policy and budgets: counted, refused past the tools budget or in a round that
// ends the conversation, and ending it once a budget is spent, whatever the read does.
async function budgeted(
	api: ToolExecutionApi,
	context: Context,
	name: LensToolName,
	read: (review: ReviewState) => Promise<ToolResult>,
) {
	const lens = await lensOf(api, api.conversationId, context);
	const { position, spent } = await meter(api, lens, "read", context);
	const tools = lens.limits?.tools;
	const problem = refusal(lens, { name, arguments: {} });
	if (problem !== undefined) return ending(failed(new Error(problem), context), lens, spent);
	if (spent !== undefined) return ending(text("[not run]"), lens, spent);
	if (tools !== undefined && position > tools) {
		return text(
			`[not run: this lens may make ${toolCalls(tools)}, and this was call ${position}. The tools budget has ended this review: report what you have confirmed; another read ends the conversation.]`,
		);
	}
	const result = await read(lens.revision).catch((error: unknown) => failed(error, context));
	if (tools === undefined || position < tools) return result;
	const last = `[that was the last of this lens's ${toolCalls(tools)}. Report what you have confirmed; another read ends the review.]`;
	return { ...result, content: [...(result.content ?? []), { type: "text" as const, text: last }] };
}

// The budget that ended a lens's conversation, from what its tools recorded and Pi's usage: which budget, its limit, and
// the tokens and counted tool calls the lens had used. `undefined` when no budget ended it.
export async function budgetEnded(
	reader: DocumentReader,
	conversationId: ConversationId,
	context: Context,
): Promise<StoredBudgetEnd | undefined> {
	const document = await reader.snapshot(LensDocument, conversationId, context);
	const ended = document?.spend?.ended;
	const limit = ended === undefined ? undefined : document?.lens?.limits?.[ended];
	if (ended === undefined || limit === undefined) return undefined;
	const tokens = tokensUsed(await reader.snapshot(UsageDoc, conversationId, context));
	return { budget: ended, limit, tokens, tools: document?.spend?.calls.length ?? 0 };
}

// Core's BudgetEnd as a JSON type, for task results and stored check records.
export type StoredBudgetEnd = { budget: "tokens" | "tools"; limit: number; tokens: number; tools: number };

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
	execute: (args, api, context) =>
		budgeted(api, context, "read_file", async (review) => {
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
				end < lines.length
					? `[lines ${end + 1} onward not shown; read again with startLine ${end + 1}]`
					: undefined,
				file.truncated ? `[the file is ${file.size} bytes; only the first part was read]` : undefined,
				start > lines.length ? `[the file has ${lines.length} lines]` : undefined,
			].filter((note) => note !== undefined);
			return text([quoteUntrusted("file", body, review.nonce), ...notes].join("\n"));
		}),
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
	execute: (args, api, context) =>
		budgeted(api, context, "search", async (review) => {
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
		}),
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
	execute: (args, api, context) =>
		budgeted(api, context, "list_files", async (review) => {
			const { entries, truncated } = await listRevisionFiles(review.repoRoot, review.head, args);
			if (entries.length === 0) return text("Empty.");
			const { body, count } = fitting(entries.map(describeEntry));
			const listing = quoteUntrusted("listing", body, review.nonce);
			return text(
				[listing, ...(truncated || count < entries.length ? ["[more entries not shown]"] : [])].join("\n"),
			);
		}),
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

// Every hunk a proving `cause` location falls on, by file then index, so the order the model listed its evidence in
// never changes which hunk an affected finding's trigger names. A rename proves without a hunk, and adds none.
function provingHunks(
	evidence: readonly EvidenceLocation[],
	review: ReviewState,
	revision: Revision,
	findingFile: string,
): ReviewHunk[] {
	const proven = evidence.flatMap((location) => {
		const overlap = location.proves === true ? revision.causeOverlap(location, findingFile) : undefined;
		return overlap?.kind === "hunk" ? [overlap.hunk] : [];
	});
	return review.files
		.flatMap((file) => file.hunks)
		.filter((hunk) => proven.some((each) => each.file === hunk.file && each.index === hunk.index))
		.sort((a, b) => (a.file === b.file ? a.index - b.index : a.file < b.file ? -1 : 1));
}

// A hunk as the proof of an affected finding names it: its file, and its added and removed lines hashed whole.
function provingHunk(hunk: ReviewHunk): ProvingHunk {
	return { file: hunk.file, hash: snippetHash(hunk.changes ?? hunk.added) };
}

// An affected finding's trigger: the first proving hunk, showing its added lines, and every proving hunk as its proof,
// which the findings document unions across sightings, so a dismissal reopens only when one of those hunks changes.
function affectedTrigger(proving: readonly ReviewHunk[]): FindingTrigger | undefined {
	const [first] = proving;
	if (first === undefined) return undefined;
	return { file: first.file, index: first.index, snippet: capSnippet(first.added), proof: proving.map(provingHunk) };
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
async function evidenceFrom(
	args: ReportFindingInput["evidence"],
	review: ReviewState,
	changed: Revision,
	findingFile: string,
): Promise<EvidenceLocation[]> {
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
			const site = { file, startLine: line, endLine, role, revision };
			const deleted = revision === "base" && changed.changeOverlap(site, findingFile) !== undefined;
			const proves = changed.causeOverlap(site, findingFile) !== undefined;
			return {
				file,
				startLine: line,
				...(last === undefined ? {} : { endLine }),
				role,
				revision,
				...(deleted ? { deleted } : {}),
				...(proves ? { proves } : {}),
				snippet: capSnippet(snippet),
			};
		}),
	);
}

// The snippet comes from the head revision at the reported lines, never from the model, so a finding's ID does not
// depend on how the model quoted the code.
async function findingFromCall(args: ReportFindingInput, lens: LensPolicy, review: ReviewState): Promise<Finding> {
	const path = repositoryPath(args.file);
	if (!lensCovers(lens.coverage, path)) {
		throw new Error(`${path} is outside the paths lens ${lens.name} reviews; report only within them`);
	}
	const endLine = args.endLine ?? args.line;
	const { content, snippet } = await linesAt(review, "head", path, args.line, endLine);
	// The lens tools never read a hunk's text, so the review state does not keep it.
	const revision = Revision.from({
		base: review.base,
		head: review.head,
		files: review.files.map((file) => ({
			...file,
			hunks: file.hunks.map(({ added: _, changes: __, ...hunk }) => ({ ...hunk, header: "", text: "" })),
		})),
	});
	const evidence = await evidenceFrom(args.evidence, review, revision, path);
	const location = { file: path, startLine: args.line, endLine };
	const cause = revision.classifyCause(location, evidence);
	const changed = review.files.find((file) => file.path === path);
	const introducing = cause === "introduced" ? overlapping(changed, args.line, endLine) : undefined;
	const proving = cause === "affected" ? provingHunks(evidence, review, revision, path) : [];
	// An introduced finding's trigger hashes its hunk's added lines whole, so a dismissal reopens only when that code
	// changes, however long it is.
	const trigger: FindingTrigger | undefined =
		introducing === undefined
			? affectedTrigger(proving)
			: {
					file: introducing.file,
					index: introducing.index,
					snippet: capSnippet(introducing.added),
					hash: snippetHash(introducing.added),
				};
	const { severity } = args;
	return Finding.create({
		rule: args.rule,
		message: args.explanation.what,
		file: path,
		startLine: args.line,
		...(args.endLine === undefined ? {} : { endLine }),
		snippet,
		occurrence: snippetOccurrence(content, snippet, { startLine: args.line, endLine }),
		cause,
		failureScenario: args.failureScenario,
		evidence,
		...(trigger === undefined ? {} : { trigger }),
		severity,
		explanation: {
			what: args.explanation.what,
			whyHere: args.explanation.why,
			whatToDo: args.explanation.fix,
		},
		source: lensSource(lens.name, lens.version, lens.level),
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
		const { spent } = await meter(api, lens, "report", context);
		const result = await recordFinding(args, api, lens, context).catch((error: unknown) => failed(error, context));
		return ending(result, lens, spent);
	},
});

// Every tool a lens may be offered, which `reaches` checks a call against as Pi would.
const lensTools: readonly ToolRegistration[] = [...Object.values(lensReadTools), reportFinding];

// How many times a lens may correct one finding it reported.
const maxCorrections = 3;

async function recordFinding(args: ReportFindingInput, api: ToolExecutionApi, lens: LensPolicy, context: Context) {
	const problem = refusal(lens, { name: "report_finding", arguments: args });
	if (problem !== undefined) throw new Error(problem);
	const review = lens.revision;
	const finding = await findingFromCall(args, lens, review);
	const id = finding.properties.id;
	const { refuted } = args;
	const recorded = await api.commit(async (tx) => {
		// One storage holds every review of a changeset, so the budget counts this lens's sightings at its own revision.
		// The lens task that runs this conversation: its policy names it, and for a conversation an older Melian spawned,
		// before policies did, the task that created it does. Read first: a commit reads no table after it writes.
		const runner = lens.task ?? (await tx.conversation(api.conversationId))?.owner?.taskId;
		const state = await tx.doc(FindingsDocument, lens.review);
		const { source } = finding.properties;
		const at = revisionKey(review);
		// A later review of the revision replaced this lens's run, and cleared its sightings; one written now would
		// count in a verdict whose record says the replacement ran.
		const entry = (await tx.doc(ReviewIndex, lens.review)).reviews[at];
		if (runner !== undefined && entry !== undefined && entry.task !== runner) {
			throw new Error("superseded: a later review of this revision replaced this run; stop reporting and finish");
		}
		const own = hasSighting(state, id, at, source);
		if (refuted === undefined && !own && sightingCount(state, at, source) >= lens.budget) {
			throw new Error(`budget reached: this lens may report ${lens.budget} findings; stop reporting and finish`);
		}
		// Each report reads the code at every location it cites, and quotes it back, so corrections are capped.
		const document = await tx.doc(LensDocument, api.conversationId);
		document.spend ??= { calls: [] };
		document.spend.reports ??= {};
		const calls = document.spend.reports[id] ?? [];
		if (!calls.includes(api.taskId)) {
			if (calls.length > maxCorrections) return false;
			document.spend.reports[id] = [...calls, api.taskId];
		}
		// A refutation stores no sighting: the lens says the finding an earlier run reported, by the ID it was given, is
		// not a defect, so the refutation never depends on reproducing that finding's snippet.
		if (refuted !== undefined) {
			const listed = document.spend.refuted ?? [];
			if (!listed.includes(refuted)) document.spend.refuted = [...listed, refuted];
			return true;
		}
		await upsertFinding(
			tx,
			lens.review,
			finding,
			at,
			review.files.flatMap((file) => file.hunks.map(provingHunk)),
		);
		return true;
	}, context);
	if (recorded && refuted !== undefined) return text(`recorded that finding ${refuted} is not a defect`);
	if (!recorded) {
		return text(
			`[not recorded: this lens has corrected finding ${id} ${maxCorrections} times, the most it may; report another finding or finish]`,
		);
	}
	const { cause, evidence = [] } = finding.properties;
	const unproven =
		cause === "pre-existing"
			? ": it is outside the change, and no cause location overlaps lines the change added, modified, or deleted, or names a file it only renamed while the finding's own file is one it edited or left alone"
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
}

// Enforces each lens's policy before a tool call runs: only the tools the lens lists plus `report_finding`, and only
// its severities and rules. `report_finding` checks the budget inside its commit, where it can tell a new finding from
// a correction of one the lens already reported. Calls in conversations that are not lenses pass untouched.
//
// Pi gives a blocked call no result that can end the run, so in a round that spends a budget a refused call goes on to
// its tool, which refuses it there and ends the run.
export const lensPolicyHook = hook(ToolTask, {
	beforeTool: async (call, api, context) => {
		const lens = (await api.snapshot(LensDocument, api.conversationId, context))?.lens;
		if (lens === undefined) return undefined;
		const problem = refusal(lens, call);
		if (problem === undefined || (await roundEnds(api, lens, context))) return undefined;
		return { block: problem };
	},
});
