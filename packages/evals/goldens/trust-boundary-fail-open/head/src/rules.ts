export interface Rule {
	readonly name: string;
	readonly pattern: RegExp;
	readonly message: string;
}

/** The patterns no added line may match. A match blocks the pull request. */
export const rules: readonly Rule[] = [
	{ name: "focused-test", pattern: /^\s*(?:describe|it|test)\.only\(/, message: "a focused test skips the rest of the suite" },
	{ name: "debugger", pattern: /\bdebugger\b/, message: "a debugger statement stops the process" },
];
