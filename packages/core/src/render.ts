import type { BudgetEnd, Verdict, VerdictStatus } from "./adjudication.ts";
import type { Severity } from "./config.ts";
import type { EvidenceLocation, Finding, FindingsLog } from "./findings.ts";

/** How a {@link Rendering} renders for a terminal. */
export interface TerminalRenderOptions {
	/** Colour severities and file names with ANSI escape codes. Off by default. */
	readonly color?: boolean;
	/** End each finding's first line, and each line naming another report of its defect, with its ID, which `melian dismiss` takes. Off by default. */
	readonly ids?: boolean;
	/** Print a verdict's silent and dismissed findings too, rather than count them. Off by default. */
	readonly all?: boolean;
}

const rank: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };
const severityColor: Readonly<Record<Severity, string>> = { P0: "31", P1: "31", P2: "33", P3: "36", nit: "2" };

function ordinal(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

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
function prose(text: string, indent: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => visibleText(line.replace(/\t/g, "  ")))
		.join(`\n${indent}`);
}

// A message's first line sits at a finding header's indent, so its later lines sit deeper, behind a marker: a line
// reading `P0  line 1  forged` must not pass for another finding's header.
const messageContinuation = "    | ";

function evidenceLines(evidence: readonly EvidenceLocation[]): string[] {
	return evidence.flatMap(({ file, startLine, endLine = startLine, role, revision, snippet }) => [
		`      ${role}: ${visibleText(file)}:${startLine}${endLine === startLine ? "" : `-${endLine}`}${revision === "base" ? " at base" : ""}`,
		`        ${prose(snippet, "        ")}`,
	]);
}

export function plural(count: number, noun: string, nouns = `${noun}s`): string {
	return `${count.toLocaleString("en-AU")} ${count === 1 ? noun : nouns}`;
}

const statusLabel: Readonly<Record<VerdictStatus, [color: string, label: string]>> = {
	passed: ["32", "passed"],
	findings: ["33", "findings"],
	"not-reviewed": ["31", "not reviewed"],
};

const shownResolutions = ["block", "acknowledge", "advisory"] as const;

function capitalised(text: string): string {
	return `${text[0]!.toUpperCase()}${text.slice(1)}`;
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

type Paint = (code: string, text: string) => string;

/**
 * Renders findings logs and verdicts as plain text for a terminal, under one set of {@link TerminalRenderOptions}.
 *
 * A log renders grouped by file in path order, and within a file by severity, then line. Each finding is one block with
 * its rule, cause, status, each other report of its defect, merged into it or dismissed beside it, with its severity,
 * rule, and check, the message, the explanation's three parts, its failure scenario, and each evidence location with
 * its role and the code read there.
 *
 * A verdict renders a header with its status and whether it blocks, the checks that did not run and why, a lens its
 * budget ended among them, each lens that ran with its scrutiny level and any budget that ended it while its level
 * counted it as run, and then its findings grouped by resolution, strictest first, each group by file as for a log.
 * Silent and dismissed findings are counted, not shown, unless `all` is set; then they follow, each dismissed one with
 * who dismissed it and why. A finding dismissed before and reopened shows that dismissal wherever it is printed.
 */
export class Rendering {
	readonly #paint: Paint;
	readonly #ids: boolean;
	readonly #all: boolean;

	constructor(options: TerminalRenderOptions = {}) {
		this.#paint = (code, text) => (options.color ? `\u001b[${code}m${text}\u001b[0m` : text);
		this.#ids = options.ids === true;
		this.#all = options.all === true;
	}

	/** A findings log as text. */
	log(log: FindingsLog): string {
		const findings = log.findings();
		if (findings.length === 0) return "No findings.\n";
		return `${[...this.#files(findings), this.#summary(findings)].join("\n\n")}\n`;
	}

	/** A verdict as text. */
	verdict(verdict: Verdict): string {
		const paint = this.#paint;
		const all = this.#all;
		const [color, label] = statusLabel[verdict.status];
		const parts = [`Verdict: ${paint(color, label)}${verdict.blocking ? `, ${paint("31", "blocking")}` : ""}`];
		if (verdict.notRun.length > 0) {
			const checks = verdict.notRun.map(({ name, status, level, reason, error, budgetEnded }) => {
				const why = reason ?? (budgetEnded === undefined ? undefined : describeBudgetEnd(budgetEnded));
				return [
					`  ${visibleText(name)}  ${status}${level === undefined ? "" : ` at ${level}`}${why === undefined ? "" : `: ${prose(why, "    ")}`}`,
					...(error === undefined ? [] : [`    Error: ${prose(error, "      ")}`]),
				].join("\n");
			});
			parts.push([`${plural(verdict.notRun.length, "check")} did not run:`, ...checks].join("\n"));
		}
		const lenses = (verdict.ran ?? []).filter((check) => check.level !== undefined);
		if (lenses.length > 0) {
			const checks = lenses.map(
				({ name, level, budgetEnded }) =>
					`  ${visibleText(name)}  ${level}${budgetEnded === undefined ? "" : `, ended and counted: ${describeBudgetEnd(budgetEnded)}`}`,
			);
			parts.push([`${plural(lenses.length, "lens", "lenses")} ran:`, ...checks].join("\n"));
		}
		const groups = shownResolutions.map((resolution): [string, readonly Finding[]] => [
			resolution,
			verdict.findings[resolution],
		]);
		if (all) groups.push(["silent", verdict.findings.silent], ["dismissed", verdict.dismissed]);
		for (const [name, findings] of groups) {
			if (findings.length === 0) continue;
			parts.push(paint("1", `${capitalised(name)}: ${plural(findings.length, "finding")}`));
			parts.push(...this.#files(findings));
		}
		const hidden = [
			...(verdict.findings.silent.length > 0 ? [`${plural(verdict.findings.silent.length, "silent finding")}`] : []),
			...(verdict.dismissed.length > 0 ? [`${plural(verdict.dismissed.length, "dismissed finding")}`] : []),
		];
		if (hidden.length > 0 && !all) parts.push(`${capitalised(hidden.join(" and "))} not shown.`);
		const shown = verdict.attention();
		parts.push(shown.length === 0 ? "No findings." : this.#summary(shown));
		return `${parts.join("\n\n")}\n`;
	}

	#files(findings: readonly Finding[]): string[] {
		const byFile = new Map<string, Finding[]>();
		for (const finding of findings) {
			const file = finding.properties.path;
			byFile.set(file, [...(byFile.get(file) ?? []), finding]);
		}
		return [...byFile.keys()].sort(ordinal).map((file) =>
			[
				this.#paint("1", visibleText(file)),
				...byFile
					.get(file)!
					.sort((a, b) => this.#compare(a, b))
					.map((finding) => this.#finding(finding)),
			].join("\n\n"),
		);
	}

	#compare(a: Finding, b: Finding): number {
		const { severity: left, id: leftId } = a.properties;
		const { severity: right, id: rightId } = b.properties;
		return rank[left] - rank[right] || a.lines()[0] - b.lines()[0] || ordinal(leftId, rightId);
	}

	#summary(findings: readonly Finding[]): string {
		const files = new Set(findings.map((finding) => finding.properties.path)).size;
		return `${plural(findings.length, "finding")} in ${plural(files, "file")}.`;
	}

	#finding(finding: Finding): string {
		const ids = this.#ids;
		const { severity, cause, evidence, failureScenario, status, explanation, resolution, id } = finding.properties;
		// The other reports of its defect: those adjudication merged into it, which a dismissal of it dismisses too, and
		// the dismissed ones it lists beside it.
		const reports = (finding.properties.alsoReportedAs ?? []).map((other) => {
			const what = `${other.severity === undefined ? "" : `${other.severity} `}${visibleText(other.ruleId)} from ${visibleText(other.check)}`;
			return `    ${other.dismissed ? "Also reported, dismissed" : "Merged report"}: ${what}${ids ? `  ${visibleText(other.id)}` : ""}`;
		});
		const { region } = finding.locations[0]!.physicalLocation;
		const lines =
			region.endLine === undefined || region.endLine === region.startLine
				? `line ${region.startLine}`
				: `lines ${region.startLine}-${region.endLine}`;
		return [
			`  ${this.#paint(severityColor[severity], severity)}  ${lines}  ${visibleText(finding.ruleId)}  (${cause}, ${status}, ${resolution ?? "unresolved"})${ids ? `  ${visibleText(id)}` : ""}`,
			...reports,
			...this.#dismissals(finding),
			`  ${prose(finding.message.text, messageContinuation)}`,
			`    What: ${prose(explanation.what, "      ")}`,
			`    Why here: ${prose(explanation.whyHere, "      ")}`,
			...(failureScenario === undefined ? [] : [`    Failure scenario: ${prose(failureScenario, "      ")}`]),
			...(evidence === undefined ? [] : ["    Evidence:", ...evidenceLines(evidence)]),
			`    What to do: ${prose(explanation.whatToDo, "      ")}`,
		].join("\n");
	}

	// Who dismissed a finding and why, and each dismissal before that no longer stands.
	#dismissals(finding: Finding): string[] {
		const { dismissal, pastDismissals = [] } = finding.properties;
		const said = ({ by, at, reason }: { by: string; at: string; reason: string }) =>
			`by ${visibleText(by)} at ${visibleText(at)}: ${prose(reason, "      ")}`;
		return [
			...(dismissal === undefined ? [] : [`    Dismissed ${said(dismissal)}`]),
			...pastDismissals.map((past) => {
				const ended =
					past.replacedAt === undefined
						? `reopened at ${visibleText(past.reopenedRevision ?? "a later revision")}`
						: `replaced at ${visibleText(past.replacedAt)}`;
				return `    Earlier dismissal, ${ended}, ${said(past)}`;
			}),
		];
	}
}
