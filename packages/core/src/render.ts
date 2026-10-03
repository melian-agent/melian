import type { Severity } from "./config.ts";
import type { Finding, FindingsLog } from "./findings.ts";

/** Options for {@link renderFindingsTerminal}. */
export interface TerminalRenderOptions {
	/** Colour severities and file names with ANSI escape codes. Off by default. */
	readonly color?: boolean;
}

/** Renders a findings log as SARIF JSON, indented by two spaces and ending in a newline. */
export function renderFindingsJson(log: FindingsLog): string {
	return `${JSON.stringify(log, null, 2)}\n`;
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

function region(finding: Finding) {
	return finding.locations[0]!.physicalLocation.region;
}

function compare(a: Finding, b: Finding): number {
	const { severity: left, id: leftId } = a.properties;
	const { severity: right, id: rightId } = b.properties;
	return rank[left] - rank[right] || region(a).startLine - region(b).startLine || ordinal(leftId, rightId);
}

function lineSpan(finding: Finding): string {
	const { startLine, endLine } = region(finding);
	return endLine === undefined || endLine === startLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function block(finding: Finding, paint: (code: string, text: string) => string): string {
	const { severity, cause, evidence, status, explanation, resolution } = finding.properties;
	return [
		`  ${paint(severityColor[severity], severity)}  ${lineSpan(finding)}  ${visibleText(finding.ruleId)}  (${cause}, ${status}, ${resolution ?? "unresolved"})`,
		`  ${prose(finding.message.text, "  ")}`,
		`    What: ${prose(explanation.what, "      ")}`,
		`    Why here: ${prose(explanation.whyHere, "      ")}`,
		...(evidence === undefined
			? []
			: [
					`    Evidence: ${visibleText(evidence.file)}:${evidence.startLine}${evidence.endLine === undefined || evidence.endLine === evidence.startLine ? "" : `-${evidence.endLine}`}`,
					`      ${prose(evidence.snippet, "      ")}`,
				]),
		`    What to do: ${prose(explanation.whatToDo, "      ")}`,
	].join("\n");
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Renders a findings log as plain text for a terminal: grouped by file in path order, and within a file by severity,
 * then line. Each finding is one block with its rule, cause, status, message, the explanation's three parts, and the
 * evidence of an `affected` finding.
 */
export function renderFindingsTerminal(log: FindingsLog, options: TerminalRenderOptions = {}): string {
	const paint = (code: string, text: string) => (options.color ? `\u001b[${code}m${text}\u001b[0m` : text);
	const findings = log.runs.flatMap((run) => run.results);
	if (findings.length === 0) return "No findings.\n";
	const byFile = new Map<string, Finding[]>();
	for (const finding of findings) {
		const file = finding.properties.path;
		byFile.set(file, [...(byFile.get(file) ?? []), finding]);
	}
	const files = [...byFile.keys()].sort(ordinal);
	const sections = files.map((file) =>
		[
			paint("1", visibleText(file)),
			...byFile
				.get(file)!
				.sort(compare)
				.map((finding) => block(finding, paint)),
		].join("\n\n"),
	);
	const summary = `${plural(findings.length, "finding")} in ${plural(files.length, "file")}.`;
	return `${[...sections, summary].join("\n\n")}\n`;
}
