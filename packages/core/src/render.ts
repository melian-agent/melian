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

function region(finding: Finding) {
	return finding.locations[0]!.physicalLocation.region;
}

function fileOf(finding: Finding): string {
	return finding.locations[0]!.physicalLocation.artifactLocation.uri;
}

function compare(a: Finding, b: Finding): number {
	const { severity: left, id: leftId } = a.properties;
	const { severity: right, id: rightId } = b.properties;
	return rank[left] - rank[right] || region(a).startLine - region(b).startLine || (leftId < rightId ? -1 : 1);
}

function lineSpan(finding: Finding): string {
	const { startLine, endLine } = region(finding);
	return endLine === undefined || endLine === startLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function block(finding: Finding, paint: (code: string, text: string) => string): string {
	const { severity, cause, status, explanation } = finding.properties;
	return [
		`  ${paint(severityColor[severity], severity)}  ${lineSpan(finding)}  ${finding.ruleId}  (${cause}, ${status})`,
		`  ${finding.message.text}`,
		`    What: ${explanation.what}`,
		`    Why here: ${explanation.whyHere}`,
		`    What to do: ${explanation.whatToDo}`,
	].join("\n");
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Renders a findings log as plain text for a terminal: grouped by file in path order, and within a file by severity,
 * then line. Each finding is one block with its rule, cause, status, message, and the explanation's three parts.
 */
export function renderFindingsTerminal(log: FindingsLog, options: TerminalRenderOptions = {}): string {
	const paint = (code: string, text: string) => (options.color ? `\u001b[${code}m${text}\u001b[0m` : text);
	const findings = log.runs.flatMap((run) => run.results);
	if (findings.length === 0) return "No findings.\n";
	const byFile = new Map<string, Finding[]>();
	for (const finding of findings) {
		const file = fileOf(finding);
		byFile.set(file, [...(byFile.get(file) ?? []), finding]);
	}
	const files = [...byFile.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const sections = files.map((file) =>
		[
			paint("1", file),
			...byFile
				.get(file)!
				.sort(compare)
				.map((finding) => block(finding, paint)),
		].join("\n\n"),
	);
	const summary = `${plural(findings.length, "finding")} in ${plural(files.length, "file")}.`;
	return `${[...sections, summary].join("\n\n")}\n`;
}
