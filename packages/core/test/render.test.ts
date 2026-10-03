import {
	createFinding,
	createFindingsLog,
	findingsLogSchema,
	renderFindingsJson,
	renderFindingsTerminal,
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
		cause: "affected",
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

	it("strips control characters from finding text and indents its continuation lines", () => {
		const hostile = createFinding({
			...evalInput,
			message: "eval runs request input\u001b]0;pwned\u0007\u001b[2J",
			explanation: { ...evalInput.explanation, what: "The handler passes the body to eval.\nThat runs any code." },
		});
		const text = renderFindingsTerminal(createFindingsLog([hostile]));
		expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
		expect(text).toContain("  eval runs request input]0;pwned[2J\n");
		expect(text).toContain("    What: The handler passes the body to eval.\n      That runs any code.\n");
	});

	it("says so when there are no findings", () => {
		expect(renderFindingsTerminal(createFindingsLog([]))).toBe("No findings.\n");
	});
});
