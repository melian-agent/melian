import {
	adjudicate,
	createFinding,
	createFindingsLog,
	defaultConfig,
	findingsLogSchema,
	renderFindingsJson,
	renderFindingsTerminal,
	renderVerdictJson,
} from "@melian-agent/core";
import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { evalInput, minimalInput } from "./fixtures/findings.ts";

// Out of order on purpose: the renderer sorts files by path, then findings by severity and line.
const log = createFindingsLog([
	createFinding({
		...evalInput,
		rule: "unchecked-result",
		message: "The write's result is ignored",
		startLine: 30,
		endLine: 32,
		startColumn: undefined,
		endColumn: undefined,
		snippet: "fs.write(fd, data)",
		cause: { evidence: { file: "src/run.ts", startLine: 12, snippet: "\tconst chunk = Buffer.alloc(1 << 20);" } },
		trigger: undefined,
		severity: "P3",
		resolution: "advisory",
		explanation: {
			what: "fs.write can write fewer bytes than asked.",
			whyHere: "The new caller passes larger buffers than before.",
			whatToDo: "Loop until every byte is written, or use fs.writeFile.",
		},
	}),
	createFinding(minimalInput),
	createFinding({
		...evalInput,
		rule: "sql-injection",
		message: "The query interpolates the user's name",
		startLine: 40,
		endLine: 40,
		snippet: `db.query("SELECT * FROM users WHERE name = '" + name + "'")`,
		severity: "P0",
		// Not yet adjudicated, so the renderer says it is unresolved.
		resolution: undefined,
		explanation: {
			what: "The query splices the name into SQL text.",
			whyHere: "This change passes the name straight from the request.",
			whatToDo: "Pass the name as a bound parameter.",
		},
	}),
	createFinding({
		...evalInput,
		rule: "no-eval",
		message: "eval runs a stored template",
		startLine: 50,
		endLine: 50,
		snippet: "eval(template)",
		explanation: {
			what: "The renderer evaluates a template from the database.",
			whyHere: "This change lets users edit that template.",
			whatToDo: "Render the template with a sandboxed engine.",
		},
	}),
	createFinding(evalInput),
]);

describe("renderFindingsJson", () => {
	it("renders the SARIF log", async () => {
		const json = renderFindingsJson(log);
		expect(Value.Check(findingsLogSchema, JSON.parse(json))).toBe(true);
		await expect(json).toMatchFileSnapshot("./golden/findings.sarif");
	});
});

describe("renderFindingsTerminal", () => {
	it("groups by file and orders by severity, then line", async () => {
		await expect(renderFindingsTerminal(log)).toMatchFileSnapshot("./golden/findings.txt");
	});

	it("uses no escape codes unless asked", () => {
		expect(renderFindingsTerminal(log)).not.toContain("\u001b");
		expect(renderFindingsTerminal(log, { color: false })).toBe(renderFindingsTerminal(log));
	});

	it("colours severities and file names when asked", async () => {
		await expect(renderFindingsTerminal(log, { color: true })).toMatchFileSnapshot("./golden/findings.ansi.txt");
	});

	const invisible =
		/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

	it("escapes control characters in finding text visibly and indents its continuation lines", () => {
		const hostile = createFinding({
			...evalInput,
			message: "eval runs request input\u001b]0;pwned\u0007\u001b[2J",
			explanation: { ...evalInput.explanation, what: "The handler passes the body to eval.\nThat runs any code." },
		});
		const text = renderFindingsTerminal(createFindingsLog([hostile]));
		expect(text).not.toMatch(invisible);
		expect(text).toContain("  eval runs request input\\u001b]0;pwned\\u0007\\u001b[2J\n");
		expect(text).toContain("    What: The handler passes the body to eval.\n      That runs any code.\n");
	});

	it.each([false, true])("escapes ESC, BEL, newline, tab, and bidi overrides in a path, colour %s", (color) => {
		const file = "src/\u001b[2Jrun\u0007\nfake.ts\tx\u202egnp.ts";
		const hostile = createFinding({ ...evalInput, file, trigger: undefined });
		const text = renderFindingsTerminal(createFindingsLog([hostile]), { color });
		const header = "src/\\u001b[2Jrun\\u0007\\u000afake.ts\\u0009x\\u202egnp.ts";
		expect(text.split("\n")[0]).toBe(color ? `\u001b[1m${header}\u001b[0m` : header);
		expect(text.replaceAll(/\u001b\[[0-9;]*m/g, "")).not.toMatch(invisible);
	});

	it("escapes a newline in a rule ID, so it cannot forge another finding's header", () => {
		const hostile = createFinding({ ...evalInput, rule: "no-eval\n  P3  line 1  harmless" });
		expect(renderFindingsTerminal(createFindingsLog([hostile]))).toContain("no-eval\\u000a  P3  line 1  harmless");
	});

	it("says so when there are no findings", () => {
		expect(renderFindingsTerminal(createFindingsLog([]))).toBe("No findings.\n");
	});
});

const verdict = adjudicate({
	manifest: [],
	findings: [
		...log.runs[0]!.results.map(({ ruleIndex: _, ...finding }) => finding),
		createFinding({
			...evalInput,
			rule: "missing-test",
			message: "No test covers the new branch",
			file: "src/total.ts",
			startLine: 9,
			endLine: 9,
			snippet: "if (total > limit) return limit;",
			severity: "P2",
			explanation: {
				what: "The new limit branch has no test.",
				whyHere: "This change adds the branch.",
				whatToDo: "Add a test with a total above the limit.",
			},
		}),
		createFinding({
			...evalInput,
			rule: "magic-number",
			startLine: 20,
			endLine: 20,
			snippet: "retry(3)",
			status: "dismissed",
		}),
	],
	checks: [
		{ name: "lens.correctness", status: "ran" },
		{ name: "lens.security", status: "failed", reason: "the lens did not finish", error: "provider returned 529" },
		{ name: "static.tsc", status: "skipped", reason: "no tsconfig.json at the base revision" },
	],
	config: defaultConfig,
});

describe("renderVerdictJson", () => {
	it("renders the verdict with its findings as SARIF results", async () => {
		const json = renderVerdictJson(verdict);
		expect(JSON.parse(json)).toEqual(verdict);
		await expect(json).toMatchFileSnapshot("./golden/verdict.json");
	});
});

describe("renderFindingsTerminal with a verdict", () => {
	it("leads with the verdict and the checks that did not run, then groups findings by resolution", async () => {
		await expect(renderFindingsTerminal(verdict)).toMatchFileSnapshot("./golden/verdict.txt");
	});

	it("colours the status when asked", async () => {
		await expect(renderFindingsTerminal(verdict, { color: true })).toMatchFileSnapshot("./golden/verdict.ansi.txt");
	});

	it("says a review passed when it did", () => {
		const passed = adjudicate({
			findings: [],
			manifest: [],
			checks: [{ name: "lens.correctness", status: "ran" }],
			config: defaultConfig,
		});
		expect(renderFindingsTerminal(passed)).toBe("Verdict: passed\n\nNo findings.\n");
	});

	it("escapes control characters in a check's name, reason, and error", () => {
		const hostile = adjudicate({
			findings: [],
			manifest: [],
			checks: [{ name: "lens.x\u001b[2J", status: "failed", reason: "bad\nline", error: "\u202egnp.ts" }],
			config: defaultConfig,
		});
		const text = renderFindingsTerminal(hostile);
		expect(text).toContain("  lens.x\\u001b[2J  failed: bad\n    line\n    Error: \\u202egnp.ts\n");
	});
});
