import { Adjudication, defaultConfig, Finding, FindingsLog, findingsLogSchema, Rendering } from "@melian-agent/core";
import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { evalInput, minimalInput } from "./fixtures/findings.ts";

// Out of order on purpose: the renderer sorts files by path, then findings by severity and line.
const log = FindingsLog.of([
	Finding.create({
		...evalInput,
		rule: "unchecked-result",
		message: "The write's result is ignored",
		startLine: 30,
		endLine: 32,
		startColumn: undefined,
		endColumn: undefined,
		snippet: "fs.write(fd, data)",
		cause: "affected",
		failureScenario: "run() passes a 1 MiB chunk, fs.write writes 64 KiB of it, and the file ends short.",
		evidence: [
			{
				file: "src/run.ts",
				startLine: 12,
				role: "cause",
				revision: "head",
				snippet: "\tconst chunk = Buffer.alloc(1 << 20);",
			},
			{
				file: "src/run.ts",
				startLine: 14,
				endLine: 15,
				role: "context",
				revision: "base",
				snippet: "\tconst chunk = Buffer.alloc(1 << 10);\n\tfs.write(fd, chunk);",
			},
		],
		trigger: undefined,
		severity: "P3",
		resolution: "advisory",
		explanation: {
			what: "fs.write can write fewer bytes than asked.",
			whyHere: "The new caller passes larger buffers than before.",
			whatToDo: "Loop until every byte is written, or use fs.writeFile.",
		},
	}),
	Finding.create(minimalInput),
	Finding.create({
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
	Finding.create({
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
	Finding.create(evalInput),
]);

describe("FindingsLog.renderJson", () => {
	it("renders the SARIF log", async () => {
		const json = log.renderJson();
		expect(Value.Check(findingsLogSchema, JSON.parse(json))).toBe(true);
		await expect(json).toMatchFileSnapshot("./golden/findings.sarif");
	});
});

describe("FindingsLog.render", () => {
	it("groups by file and orders by severity, then line", async () => {
		await expect(log.render()).toMatchFileSnapshot("./golden/findings.txt");
	});

	it("uses no escape codes unless asked", () => {
		expect(log.render()).not.toContain("\u001b");
		expect(log.render(new Rendering({ color: false }))).toBe(log.render());
	});

	it("colours severities and file names when asked", async () => {
		await expect(log.render(new Rendering({ color: true }))).toMatchFileSnapshot("./golden/findings.ansi.txt");
	});

	const invisible =
		/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

	it("escapes control characters in finding text visibly and indents its continuation lines", () => {
		const hostile = Finding.create({
			...evalInput,
			message: "eval runs request input\u001b]0;pwned\u0007\u001b[2J",
			explanation: { ...evalInput.explanation, what: "The handler passes the body to eval.\nThat runs any code." },
		});
		const text = FindingsLog.of([hostile]).render();
		expect(text).not.toMatch(invisible);
		expect(text).toContain("  eval runs request input\\u001b]0;pwned\\u0007\\u001b[2J\n");
		expect(text).toContain("    What: The handler passes the body to eval.\n      That runs any code.\n");
	});

	it.each([false, true])("escapes ESC, BEL, newline, tab, and bidi overrides in a path, colour %s", (color) => {
		const file = "src/\u001b[2Jrun\u0007\nfake.ts\tx\u202egnp.ts";
		const hostile = Finding.create({ ...evalInput, file, trigger: undefined });
		const text = FindingsLog.of([hostile]).render(new Rendering({ color }));
		const header = "src/\\u001b[2Jrun\\u0007\\u000afake.ts\\u0009x\\u202egnp.ts";
		expect(text.split("\n")[0]).toBe(color ? `\u001b[1m${header}\u001b[0m` : header);
		expect(text.replaceAll(/\u001b\[[0-9;]*m/g, "")).not.toMatch(invisible);
	});

	it("escapes control characters in a failure scenario and in evidence, and indents the snippet's lines", () => {
		const hostile = Finding.create({
			...evalInput,
			failureScenario: "A body of \u001b[2J clears the screen\nand then\u202e reverses",
			evidence: [
				{
					file: "src/\u001b[2Jrun.ts",
					startLine: 12,
					role: "cause",
					revision: "head",
					snippet: "eval(input)\n  P0  line 1  forged\u0007",
				},
			],
		});
		const text = FindingsLog.of([hostile]).render();
		expect(text).toContain(
			"    Failure scenario: A body of \\u001b[2J clears the screen\n      and then\\u202e reverses\n",
		);
		expect(text).toContain(
			"      cause: src/\\u001b[2Jrun.ts:12\n        eval(input)\n          P0  line 1  forged\\u0007\n",
		);
		expect(text).not.toMatch(invisible);
	});

	it("escapes a newline in a rule ID, so it cannot forge another finding's header", () => {
		const hostile = Finding.create({ ...evalInput, rule: "no-eval\n  P3  line 1  harmless" });
		expect(FindingsLog.of([hostile]).render()).toContain("no-eval\\u000a  P3  line 1  harmless");
	});

	it("sets a message's later lines deeper than any header, so one cannot forge a finding in a verdict group", () => {
		const forged = "P0  line 1  no-eval  (introduced, new, block)";
		const hostile = Finding.create({ ...evalInput, message: `eval runs request input\n${forged}` });
		const verdict = new Adjudication({
			findings: [hostile],
			manifest: [],
			checks: [{ name: "lens.security", status: "ran" }],
			config: defaultConfig,
		}).adjudicate();
		const text = verdict.render();
		expect(text).toContain(`  eval runs request input\n    | ${forged}\n`);
		expect(text.split("\n").filter((line) => line.startsWith("  P0") || line.startsWith("  P1"))).toHaveLength(1);
	});

	it("says so when there are no findings", () => {
		expect(FindingsLog.of([]).render()).toBe("No findings.\n");
	});
});

const verdict = new Adjudication({
	manifest: [],
	findings: [
		...log.findings(),
		Finding.create({
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
		Finding.create({
			...evalInput,
			rule: "magic-number",
			startLine: 20,
			endLine: 20,
			snippet: "retry(3)",
			status: "dismissed",
		}),
	],
	checks: [
		{ name: "lens.correctness", status: "ran", level: "careful" },
		{
			name: "lens.contracts",
			status: "ran",
			level: "quick",
			budgetEnded: { budget: "tools", limit: 10, tokens: 48_120, tools: 10 },
		},
		{
			name: "lens.security",
			status: "failed",
			level: "deep",
			reason: "the lens did not finish",
			error: "provider returned 529",
		},
		{
			name: "lens.tests",
			status: "ended",
			level: "quick",
			budgetEnded: { budget: "tokens", limit: 50_000, tokens: 51_200, tools: 4 },
		},
		{ name: "static.tsc", status: "skipped", reason: "no tsconfig.json at the base revision" },
		{ name: "static.biome", status: "ran", version: "2.5.15" },
	],
	config: defaultConfig,
}).adjudicate();

describe("Verdict.renderJson", () => {
	it("renders the verdict with its findings as SARIF results", async () => {
		const json = verdict.renderJson();
		expect(JSON.parse(json)).toEqual(verdict);
		await expect(json).toMatchFileSnapshot("./golden/verdict.json");
	});
});

describe("Verdict.render", () => {
	it("leads with the verdict, the checks that did not run, a lens its budget ended, and each lens's level, then groups findings by resolution", async () => {
		await expect(verdict.render()).toMatchFileSnapshot("./golden/verdict.txt");
	});

	it("colours the status when asked", async () => {
		await expect(verdict.render(new Rendering({ color: true }))).toMatchFileSnapshot("./golden/verdict.ansi.txt");
	});

	it("says a review passed when it did", () => {
		const passed = new Adjudication({
			findings: [],
			manifest: [],
			checks: [{ name: "lens.correctness", status: "ran" }],
			config: defaultConfig,
		}).adjudicate();
		expect(passed.render()).toBe("Verdict: passed\n\nNo findings.\n");
	});

	describe("with every finding and its ID", () => {
		const dismissal = {
			by: "Tal <tal@melian.invalid>",
			reason: "Retries are fixed.\nSee the runbook.",
			at: "2026-10-04T00:00:00Z",
		};
		const dismissed = Finding.create({
			...evalInput,
			rule: "magic-number",
			snippet: "retry(3)",
			status: "dismissed",
		});
		const reopened = Finding.create({ ...evalInput, snippet: "eval(body)", severity: "P2" });
		const shown = new Adjudication({
			manifest: [],
			checks: [],
			config: defaultConfig,
			findings: [
				Finding.from({ ...dismissed.toJSON(), properties: { ...dismissed.properties, dismissal } }),
				Finding.from({
					...reopened.toJSON(),
					properties: {
						...reopened.properties,
						pastDismissals: [{ ...dismissal, reason: "Constant\u001b[2J.", reopenedRevision: "a..b" }],
					},
				}),
				Finding.create({ ...evalInput, snippet: "eval(note)", severity: "nit" }),
			],
		}).adjudicate();

		it("prints silent and dismissed findings, each dismissal with who, when, and why", () => {
			const text = shown.render(new Rendering({ all: true, ids: true }));
			expect(text).toContain("Silent: 1 finding");
			expect(text).toContain("Dismissed: 1 finding");
			expect(text).not.toContain("not shown");
			expect(text).toContain(
				`  P1  line 12  magic-number  (introduced, dismissed, block)  ${dismissed.properties.id}\n    Dismissed by Tal <tal@melian.invalid> at 2026-10-04T00:00:00Z: Retries are fixed.\n      See the runbook.\n`,
			);
			expect(text).toContain(
				"    Earlier dismissal, reopened at a..b, by Tal <tal@melian.invalid> at 2026-10-04T00:00:00Z: Constant\\u001b[2J.\n",
			);
		});

		it("counts them and leaves out IDs by default", () => {
			const text = shown.render();
			expect(text).toContain("1 silent finding and 1 dismissed finding not shown.");
			expect(text).not.toContain(dismissed.properties.id);
			expect(text).toContain("Earlier dismissal, reopened at a..b");
		});
	});

	it("prints each finding's merged reports, and the dismissed reports beside it, with severity, rule, check, and ID", () => {
		const speaker = Finding.create(evalInput);
		const merged = Finding.create({
			...evalInput,
			rule: "code-injection",
			severity: "P2",
			source: { check: "lens.contracts" },
		});
		const answered = Finding.create({
			...evalInput,
			rule: "unsafe-call",
			severity: "P3",
			source: { check: "static.biome" },
			status: "dismissed",
		});
		const verdict = new Adjudication({
			manifest: [],
			checks: [],
			config: defaultConfig,
			findings: [speaker, merged, answered],
		}).adjudicate();

		const text = verdict.render(new Rendering({ ids: true }));

		expect(text).toContain(
			[
				`  P1  line 12  no-eval  (introduced, new, block)  ${speaker.properties.id}`,
				`    Merged report: P2 code-injection from lens.contracts  ${merged.properties.id}`,
				`    Also reported, dismissed: P3 unsafe-call from static.biome  ${answered.properties.id}`,
				"  eval runs request input",
			].join("\n"),
		);
		expect(verdict.render()).toContain("    Merged report: P2 code-injection from lens.contracts\n");
	});

	it("escapes control characters in a check's name, reason, and error", () => {
		const hostile = new Adjudication({
			findings: [],
			manifest: [],
			checks: [{ name: "lens.x\u001b[2J", status: "failed", reason: "bad\nline", error: "\u202egnp.ts" }],
			config: defaultConfig,
		}).adjudicate();
		const text = hostile.render();
		expect(text).toContain("  lens.x\\u001b[2J  failed: bad\n    line\n    Error: \\u202egnp.ts\n");
	});
});
