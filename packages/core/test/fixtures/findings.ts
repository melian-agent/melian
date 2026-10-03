import type { FindingInput } from "@melian-agent/core";

export const evalInput: FindingInput = {
	rule: "no-eval",
	message: "eval runs request input",
	file: "src/run.ts",
	startLine: 12,
	endLine: 12,
	startColumn: 3,
	endColumn: 14,
	snippet: "eval(input)",
	occurrence: 0,
	cause: "introduced",
	trigger: { file: "src/run.ts", oldStart: 11, oldLines: 1, newStart: 12, newLines: 1 },
	severity: "P1",
	confidence: 0.9,
	resolution: "block",
	explanation: {
		what: "The handler passes the request body to eval.",
		whyHere: "This change routes the body into run() without parsing it.",
		whatToDo: "Parse the body with JSON.parse and validate it.",
	},
	source: { check: "lens.security", version: "1" },
};

export const minimalInput: FindingInput = {
	rule: "prefer-const",
	message: "total is never reassigned",
	file: "src/total.ts",
	startLine: 4,
	discriminator: "total",
	cause: "pre-existing",
	severity: "nit",
	resolution: "silent",
	explanation: {
		what: "total is declared with let but never reassigned.",
		whyHere: "The file is open in this change, but the line predates it.",
		whatToDo: "Declare it with const.",
	},
	source: { check: "static.biome" },
};
