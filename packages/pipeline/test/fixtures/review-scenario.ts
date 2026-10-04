import type { Lens } from "@melian-agent/core";
import { baseAndHead, lines } from "./repo.ts";

export { count, readEvents, record } from "./spike.ts";

// A user whose manager the change stops guarding, so line 7 dereferences a value that may be undefined.
export function crashRepository(): string {
	const user = (body: string) =>
		lines(
			"export interface User {",
			"\tname: string;",
			"\tmanager?: User;",
			"}",
			"",
			"export function managerName(user: User): string {",
			body,
			"}",
		);
	return baseAndHead(
		{ "src/user.ts": user('\treturn user.manager?.name ?? "none";') },
		{ "src/user.ts": user("\treturn user.manager.name;") },
	);
}

export const crashFinding = {
	file: "src/user.ts",
	line: 7,
	rule: "null-dereference",
	severity: "P1",
	explanation: {
		what: "managerName reads name from a manager that may be undefined.",
		why: "This change dropped the optional chain, so a user without a manager throws.",
		fix: "Restore user.manager?.name with a fallback.",
	},
	failureScenario: 'managerName({ name: "Ada" }) throws a TypeError reading name of undefined.',
	evidence: [{ file: "src/user.ts", line: 7, role: "cause" }],
};

// crashFinding as an older Melian's report_finding took it: one evidence location, and no failure scenario.
export const legacyCrashFinding = {
	file: crashFinding.file,
	line: crashFinding.line,
	rule: crashFinding.rule,
	severity: crashFinding.severity,
	explanation: crashFinding.explanation,
	evidence: { file: "src/user.ts", line: 7 },
};

// The correctness lens may report one finding, so the crashed review dies at exactly its full budget.
export function crashLenses(lenses: readonly Lens[]): Lens[] {
	return lenses.map((lens) => (lens.name === "correctness" ? { ...lens, budget: { findings: 1 } } : lens));
}
