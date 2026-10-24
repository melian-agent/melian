import type { BudgetEnd, CheckLineage, VerdictStatus } from "./adjudication.ts";
import type { Severity } from "./config.ts";
import { Mark } from "./emoji.ts";
import type { DecidedBy, EvidenceLocation } from "./findings.ts";

/** How a {@link Rendering} renders for a terminal. */
export interface TerminalRenderOptions {
	/** Colour severities and file names with ANSI escape codes. Off by default. */
	readonly color?: boolean;
	/** End each finding's first line, and each line naming another report of its defect, with its ID, which `melian dismiss` takes. Off by default. */
	readonly ids?: boolean;
	/** Print a verdict's silent and dismissed findings too, rather than count them. Off by default. */
	readonly all?: boolean;
	/** Name, under each finding, the file and entry that decided its resolution. Off by default. */
	readonly decided?: boolean;
	/** Omit instructions that act on the current review when showing a saved round. Off by default. */
	readonly historical?: boolean;
	/** Print each mark's emoji beside its word. Off by default, which prints the words alone. */
	readonly emoji?: boolean;
	/** The emoji each repository lens declares, by its check name, `lens.<name>`. */
	readonly lensEmojis?: Readonly<Record<string, string>>;
}

export const severityColor: Readonly<Record<Severity, string>> = { P0: "31", P1: "31", P2: "33", P3: "36", nit: "2" };

// Finding text and paths come from the change under review, which its author controls, so they may carry escape
// sequences that rewrite the terminal or bidi overrides that reorder what it shows. Print each as a visible \uXXXX.
const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * `text` with every control character, C1 control, line or paragraph separator, and bidi control written as a visible
 * `\uXXXX`, so a path or line from an untrusted change cannot rewrite a terminal, forge a line, or reorder what a
 * reader sees.
 */
export function visibleText(text: string): string {
	return text.replace(unsafe, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Prose keeps its line breaks as indented continuation lines, so a multi-line explanation stays inside its block.
export function prose(text: string, indent: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => visibleText(line.replace(/\t/g, "  ")))
		.join(`\n${indent}`);
}

// A message's first line sits at a finding header's indent, so its later lines sit deeper, behind a marker: a line
// reading `P0  line 1  forged` must not pass for another finding's header.
export const messageContinuation = "    | ";

export function evidenceLines(evidence: readonly EvidenceLocation[]): string[] {
	return evidence.flatMap(({ file, startLine, endLine = startLine, role, revision, snippet }) => [
		`      ${role}: ${visibleText(file)}:${startLine}${endLine === startLine ? "" : `-${endLine}`}${revision === "base" ? " at base" : ""}`,
		`        ${prose(snippet, "        ")}`,
	]);
}

export function plural(count: number, noun: string, nouns = `${noun}s`): string {
	return `${count.toLocaleString("en-AU")} ${count === 1 ? noun : nouns}`;
}

export const statusLabel: Readonly<Record<VerdictStatus, [color: string, label: string]>> = {
	passed: ["32", "passed"],
	findings: ["33", "findings"],
	"not-reviewed": ["31", "not reviewed"],
};

export const shownResolutions = ["block", "acknowledge", "advisory"] as const;

export function capitalised(text: string): string {
	return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

const entryNames: Readonly<Record<NonNullable<DecidedBy["ceiling"]>["entry"], string>> = {
	rule: "the rule entry",
	check: "the check entry",
	table: "the table",
	"lens-default": "the lens's default",
	"built-in": "the built-in table",
};

const capNames: Readonly<Record<NonNullable<DecidedBy["cap"]>, string>> = {
	"pre-existing": "capped as pre-existing",
	"unproven-cause": "capped at advisory, since no cause location proves the change broke it",
	unverified: "capped at advisory, since no verifier judged it",
};

const floorNames: Readonly<Record<NonNullable<DecidedBy["floor"]>, string>> = {
	"policy-change": "held at acknowledge as a change to policy",
	"injection-attempt": "held at acknowledge as an injection attempt",
	"pre-existing-important": "held at advisory as pre-existing and important",
	"lowered-trust": "held for a maintainer after a protected lowering",
	"refuted-trust": "held for a maintainer after a protected refutation",
};

/**
 * Says which file and entry decided a finding's resolution, for an author: "services/payments/melian.yaml:
 * resolution.P1, the table", or "lens cleanup's default: the built-in table, under the ceiling resolution.ceiling".
 * It names the report it decided for when `own`, the finding's own check and rule, is another, and the cap or floor
 * that then moved the result.
 */
export function describeDecision(by: DecidedBy, own: { readonly check: string; readonly rule: string }): string {
	const who = by.file ?? (by.lens === undefined ? undefined : `lens ${by.lens}'s default`);
	const { entry, key } = by.requirement;
	// A guardrail finding is decided under one of its configured rules, `guardrail/<name>/<rule>`, which is its own.
	const rule = by.rule ?? own.rule;
	const requirement = key === undefined ? entryNames[entry] : `${key}, ${entryNames[entry]}`;
	return [
		`${who === undefined ? "" : `${who}: `}${requirement}${by.ceiling === undefined ? "" : `, under the ceiling ${by.ceiling.key}`}`,
		...(by.check === own.check && (rule === own.rule || rule.startsWith(`${own.rule}/`))
			? []
			: [`as ${by.check} reported it${by.rule === undefined ? "" : ` under ${by.rule}`}`]),
		...(by.cap === undefined
			? []
			: [`${capNames[by.cap]}${by.capBy === undefined ? "" : ` by ${by.capBy.file}'s ${by.capBy.key}`}`]),
		...(by.floor === undefined ? [] : [floorNames[by.floor]]),
	].join("; ");
}

const budgetNames: Readonly<Record<BudgetEnd["budget"], string>> = { tokens: "token", tools: "tool call" };

/**
 * Says which budget ended a lens and what it had used, for an author: "its token budget of 50,000 ran out after 4 tool
 * calls and 51,200 tokens".
 */
export function describeBudgetEnd({ budget, limit, tokens, tools }: BudgetEnd): string {
	const used = `${plural(tools, "tool call")} and ${plural(tokens, "token")}`;
	return `its ${budgetNames[budget]} budget of ${limit.toLocaleString("en-AU")} ran out after ${used}`;
}

/**
 * Says what put a check on the model it ran on, for an author: "on openai/gpt-5.5, set by melian.local.yaml, where
 * policy wants anthropic/claude-opus-5-5 and does not accept openai/gpt-5.5".
 */
export function describeLineage({ model, wanted, by, moved, outside, thinking }: CheckLineage): string {
	const routed = by === "derived" ? "derived, since no model of its route has credentials" : `set by ${by}`;
	const why =
		moved === undefined ? routed : `moved from ${moved.from} to ${moved.to} by ${moved.by}, whose route is ${routed}`;
	const policy = wanted === undefined ? "where policy" : `where policy wants ${wanted} and`;
	const reasoning =
		thinking === undefined
			? ""
			: `; thinking ${thinking.level} set by ${thinking.by}; policy wants ${thinking.wanted}`;
	return `on ${model}, ${why}, ${policy} ${outside ? "does not accept" : "accepts"} ${model}${reasoning}`;
}

/**
 * The options every terminal rendering of a finding, a findings log, or a verdict shares, as `finding.render()`,
 * `log.render()`, and `verdict.render()` read them.
 */
export class Rendering {
	/** End each finding's first line, and each line naming another report of its defect, with its ID. */
	readonly ids: boolean;
	/** Print a verdict's silent and dismissed findings too, rather than count them. */
	readonly all: boolean;
	/** Name, under each finding, the file and entry that decided its resolution. */
	readonly decided: boolean;
	/** Render a saved round without current-review instructions. */
	readonly historical: boolean;
	/** Print each mark's emoji beside its word. */
	readonly emoji: boolean;
	readonly #color: boolean;
	readonly #lensEmojis: Readonly<Record<string, string>>;

	constructor(options: TerminalRenderOptions = {}) {
		this.#color = options.color === true;
		this.ids = options.ids === true;
		this.all = options.all === true;
		this.decided = options.decided === true;
		this.historical = options.historical === true;
		this.emoji = options.emoji === true;
		this.#lensEmojis = options.lensEmojis ?? {};
	}

	/** `mark` as this rendering shows it: its word, after its emoji when emojis are on. */
	show(mark: Mark): string {
		return mark.show(this.emoji);
	}

	/** The mark of the check `check`, reporting under `rule`, with the emoji its lens declares. */
	check(check: string, rule: string): Mark {
		return Mark.check(check, rule, Object.hasOwn(this.#lensEmojis, check) ? this.#lensEmojis[check] : undefined);
	}

	/** `text` coloured with the ANSI code `code`, or as it is when colour is off. */
	paint(code: string, text: string): string {
		return this.#color ? `\u001b[${code}m${text}\u001b[0m` : text;
	}
}
