export type Severity = "error" | "warning" | "note";

export class Finding {
	readonly rule: string;
	readonly severity: Severity;
	readonly file: string;
	readonly line: number;

	constructor(rule: string, severity: Severity, file: string, line: number) {
		this.rule = rule;
		this.severity = severity;
		this.file = file;
		this.line = line;
	}

	/** Whether the finding stops a merge. */
	blocks(): boolean {
		return this.severity === "error";
	}
}
