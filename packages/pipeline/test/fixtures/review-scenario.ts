import { defaultConfig, Lens, type LensBudget } from "@melian-agent/core";
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

// `lens` with `budget` over its careful level's, the level every lens runs at until triage chooses another.
export function withBudget(lens: Lens, budget: Partial<LensBudget>): Lens {
	const { careful } = lens.levels;
	return Lens.from({
		...lens.toJSON(),
		levels: { ...lens.levels, careful: { ...careful, budget: { ...careful.budget, ...budget } } },
	});
}

// The correctness lens may report one finding, so the crashed review dies at exactly its full budget.
export function crashLenses(lenses: readonly Lens[]): Lens[] {
	return lenses.map((lens) => (lens.name === "correctness" ? withBudget(lens, { findings: 1 }) : lens));
}

// The correctness lens held to `budget`: by default two tool calls, so a replayed call counted twice would leave the
// lens a call short.
export function budgetLenses(lenses: readonly Lens[], budget: Partial<LensBudget> = { tools: 2 }): Lens[] {
	return lenses.map((lens) => (lens.name === "correctness" ? withBudget(lens, budget) : lens));
}

// The budgets the crash scenarios that end a lens hold it to: `spent` one tool call, so its second read ends it, and
// `tokens` one token, which its first response spends.
export const endingBudgets = { spent: { tools: 1 }, tokens: { tokens: 1 } } as const;

// The crash scenarios script correctness and contracts; the default full tier's other lenses have goldens of their own.
export const twoLensTiers = { ...defaultConfig.tiers, full: ["standard", "lens.contracts"] };
