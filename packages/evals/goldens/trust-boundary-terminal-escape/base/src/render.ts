export interface Finding {
	readonly path: string;
	readonly line: number;
	readonly message: string;
}

// Paths and messages come from the change under review, so every character a terminal could act on is escaped.
function printable(text: string): string {
	return text.replace(/[^\x20-\x7e]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`);
}

/** The findings as terminal lines, one per finding. */
export function renderFindings(findings: readonly Finding[]): string {
	return findings.map((finding) => `${printable(finding.path)}:${finding.line}  ${printable(finding.message)}`).join("\n");
}
