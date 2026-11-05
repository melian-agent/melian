// Raises every committed lens's top-level budget to the round budget AGENTS.md's "Three reviews before ready" sets,
// in a throwaway checkout. The design lens keeps its own, which already exceeds it.
// Usage: node scripts/round-budgets.mjs <lenses directory>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const roundBudget = "budget: { findings: 8, tokens: 600000, tools: 90 }";
const kept = new Set(["design"]);

// Only the top-level line: a level's own budget stays, as the coordinator's rounds leave it.
export function withBudget(text, budget) {
	const lines = text.split("\n");
	if (lines[0] !== "---") throw new Error("a LENS.md must open with front matter");
	const end = lines.indexOf("---", 1);
	if (end === -1) throw new Error("a LENS.md front matter has no closing ---");
	const at = lines.slice(1, end).findIndex((line) => line.startsWith("budget:"));
	if (at === -1) lines.splice(end, 0, budget);
	else if (/^budget: \{.*\}$/.test(lines[at + 1])) lines[at + 1] = budget;
	else throw new Error("a top-level budget must be one flow mapping on one line");
	return lines.join("\n");
}

export function raiseBudgets(directory) {
	const raised = [];
	for (const name of readdirSync(directory).sort()) {
		if (kept.has(name)) continue;
		const path = join(directory, name, "LENS.md");
		writeFileSync(path, withBudget(readFileSync(path, "utf8"), roundBudget));
		raised.push(name);
	}
	return raised;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const directory = process.argv[2];
	if (directory === undefined) {
		process.stderr.write("usage: node scripts/round-budgets.mjs <lenses directory>\n");
		process.exit(64);
	}
	process.stdout.write(`raised: ${raiseBudgets(directory).join(", ")}\n`);
}
