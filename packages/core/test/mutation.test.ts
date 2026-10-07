import {
	CheckError,
	mutationSkipHasLeave,
	mutationSkips,
	normaliseMutationReport,
	toolLogSchema,
} from "@melian-agent/core";
import Value from "typebox/value";
import { describe, expect, it } from "vitest";

interface Mutant {
	status: string;
	line: number;
	endLine?: number;
	mutatorName?: string;
	replacement?: string;
	reason?: string;
}

function report(files: Record<string, Mutant[]>): string {
	return JSON.stringify({
		schemaVersion: "1.0",
		files: Object.fromEntries(
			Object.entries(files).map(([path, mutants]) => [
				path,
				{
					language: "typescript",
					source: "",
					mutants: mutants.map((mutant, index) => ({
						id: String(index),
						mutatorName: mutant.mutatorName ?? "ConditionalExpression",
						replacement: mutant.replacement ?? "true",
						status: mutant.status,
						...(mutant.reason === undefined ? {} : { statusReason: mutant.reason }),
						location: {
							start: { line: mutant.line, column: 3 },
							end: { line: mutant.endLine ?? mutant.line, column: 9 },
						},
					})),
				},
			]),
		),
	});
}

const input = {
	version: "10.0.0",
	lines: { "src/a.ts": [[10, 12]], "src/b c.ts": [[1, 1]] } as Record<string, [number, number][]>,
	tests: { "src/a.ts": "test/a.test.ts", "src/b c.ts": "a new test/b c.test.ts" },
};

// What the change asked Stryker to mutate is what the report holds, unless a test says otherwise.
function read(files: Record<string, Mutant[]>) {
	const asked = Object.entries(input.lines).filter(([path]) => Object.hasOwn(files, path));
	return normaliseMutationReport(report(files), { ...input, lines: Object.fromEntries(asked) });
}

function located(files: Record<string, Mutant[]>) {
	return read(files).log.runs[0].results.map((result) => {
		const { artifactLocation, region } = result.locations[0]!.physicalLocation;
		return [artifactLocation.uri, region.startLine, region.endLine];
	});
}

describe("normaliseMutationReport", () => {
	it("turns a survived mutant on a changed line into an untested-behaviour result with the mutator and the mutated text", () => {
		const { log, notes } = read({
			"src/a.ts": [{ status: "Survived", line: 11, mutatorName: "EqualityOperator", replacement: "a >= b" }],
		});
		expect(log.runs[0].tool.driver).toEqual({ name: "Stryker", version: "10.0.0" });
		expect(log.runs[0].results).toEqual([
			{
				ruleId: "untested-behaviour",
				level: "error",
				message: {
					text: "EqualityOperator mutant survived: with this code changed to `a >= b`, every test still passed.",
				},
				advice: {
					whyHere:
						"A mutant of this changed line survived the test run, so no test fails when this behaviour changes.",
					whatToDo:
						"Add or tighten a test in test/a.test.ts so it fails when this code is changed as the mutant changed it, then restore the code.",
				},
				locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 11 } } }],
			},
		]);
		expect(notes).toEqual([]);
	});

	it("writes a log that satisfies the tool log schema, advice and multi-line regions included", () => {
		const { log } = read({
			"src/a.ts": [
				{ status: "Survived", line: 10, endLine: 12 },
				{ status: "NoCoverage", line: 11 },
			],
		});
		expect(log.runs[0].results).toHaveLength(2);
		expect(Value.Errors(toolLogSchema, log)).toEqual([]);
	});

	it("reports a NoCoverage mutant as code no test runs", () => {
		const [result] = read({ "src/a.ts": [{ status: "NoCoverage", line: 10, replacement: "{}" }] }).log.runs[0]
			.results;
		expect(result!.message.text).toBe(
			"ConditionalExpression mutant has no test coverage: no test runs this code, so changing it to `{}` fails nothing.",
		);
		expect(result!.advice!.whyHere).toBe(
			"No test runs this changed line, so no test fails when this behaviour changes.",
		);
	});

	it("takes a mutant on the first and last changed line, and none one line outside", () => {
		const mutants = [9, 10, 12, 13].map((line) => ({ status: "Survived", line }));
		expect(located({ "src/a.ts": mutants })).toEqual([
			["src/a.ts", 10, undefined],
			["src/a.ts", 12, undefined],
		]);
	});

	it("judges a mutant by the line it starts on, and records the lines it spans", () => {
		expect(
			located({
				"src/a.ts": [
					{ status: "Survived", line: 12, endLine: 20 },
					{ status: "Survived", line: 8, endLine: 11 },
				],
			}),
		).toEqual([["src/a.ts", 12, 20]]);
	});

	it("ignores a survivor in a file the change did not touch, whatever the file is called", () => {
		expect(
			located({
				"src/other.ts": [{ status: "Survived", line: 11 }],
				constructor: [{ status: "Survived", line: 1 }],
			}),
		).toEqual([]);
	});

	it("sets aside Timeout, RuntimeError, and CompileError mutants as notes, counted by status", () => {
		const { log, notes } = read({
			"src/a.ts": [
				{ status: "Timeout", line: 10 },
				{ status: "Timeout", line: 11 },
				{ status: "RuntimeError", line: 12 },
				{ status: "CompileError", line: 12 },
				{ status: "Timeout", line: 99 },
			],
		});
		expect(log.runs[0].results).toEqual([]);
		expect(notes).toEqual([
			"2 Timeout mutant(s) on changed lines were set aside: a hang or a crash is not a survivor, so no finding is raised for it.",
			"1 RuntimeError mutant(s) on changed lines were set aside: a hang or a crash is not a survivor, so no finding is raised for it.",
			"1 CompileError mutant(s) on changed lines were set aside: a hang or a crash is not a survivor, so no finding is raised for it.",
		]);
	});

	it("reports an Ignored mutant on a changed line as one ignored-mutant result per line, with Stryker's reason, and nothing off the changed lines", () => {
		const { log, notes } = read({
			"src/a.ts": [
				{ status: "Killed", line: 10 },
				{ status: "Ignored", line: 12, reason: "Ignored by a Stryker disable comment" },
				{ status: "Ignored", line: 11, reason: "Static mutant" },
				{ status: "Ignored", line: 11, reason: "Another reason" },
				{ status: "Ignored", line: 99, reason: "Static mutant" },
			],
		});
		expect(
			log.runs[0].results.map((result) => [
				result.ruleId,
				result.level,
				result.locations[0]!.physicalLocation.region.startLine,
				result.message.text,
			]),
		).toEqual([
			[
				"ignored-mutant",
				"error",
				11,
				"Stryker ignored the mutants of this changed line, so no test was asked about them (Static mutant).",
			],
			[
				"ignored-mutant",
				"error",
				12,
				"Stryker ignored the mutants of this changed line, so no test was asked about them (Ignored by a Stryker disable comment).",
			],
		]);
		expect(notes).toEqual([]);
	});

	it("names an Ignored mutant that carries no reason", () => {
		const { log } = read({ "src/a.ts": [{ status: "Ignored", line: 10 }] });
		expect(log.runs[0].results.map((result) => result.message.text)).toEqual([
			"Stryker ignored the mutants of this changed line, so no test was asked about them (Stryker gives no reason).",
		]);
	});

	it("reports an ignored line in a file with no changed ranges as nothing", () => {
		expect(
			normaliseMutationReport(report({ "src/other.ts": [{ status: "Ignored", line: 1 }] }), input).log.runs[0]
				.results,
		).toEqual([]);
	});

	it("orders results by path, then line, then message, whatever order the report lists them in", () => {
		const order = (files: Record<string, Mutant[]>) =>
			read(files).log.runs[0].results.map((result) => {
				const { artifactLocation, region } = result.locations[0]!.physicalLocation;
				return `${artifactLocation.uri}:${region.startLine}:${result.message.text.split(" ")[0]}`;
			});
		const forward = {
			"src/a.ts": [
				{ status: "Survived", line: 10, mutatorName: "Alpha" },
				{ status: "Survived", line: 10, mutatorName: "Beta" },
				{ status: "Survived", line: 12, mutatorName: "Alpha" },
			],
			"src/b c.ts": [{ status: "Survived", line: 1, mutatorName: "Alpha" }],
		};
		const expected = ["src/a.ts:10:Alpha", "src/a.ts:10:Beta", "src/a.ts:12:Alpha", "src/b%20c.ts:1:Alpha"];
		expect(order(forward)).toEqual(expected);
		expect(
			order({
				"src/b c.ts": forward["src/b c.ts"],
				"src/a.ts": [...forward["src/a.ts"]].reverse(),
			}),
		).toEqual(expected);
		expect(
			order({
				"src/b c.ts": forward["src/b c.ts"],
				"src/a.ts": [forward["src/a.ts"][1]!, forward["src/a.ts"][2]!, forward["src/a.ts"][0]!],
			}),
		).toEqual(expected);
	});

	it("keeps a survivor on each range of a file changed in two places, and drops one between them", () => {
		const { log } = normaliseMutationReport(
			report({
				"src/a.ts": [
					{ status: "Survived", line: 2 },
					{ status: "Survived", line: 6 },
					{ status: "Survived", line: 11 },
					{ status: "Survived", line: 13 },
				],
			}),
			{
				...input,
				lines: {
					"src/a.ts": [
						[2, 3],
						[10, 12],
					],
				},
			},
		);
		expect(log.runs[0].results.map((result) => result.locations[0]!.physicalLocation.region.startLine)).toEqual([
			2, 11,
		]);
	});

	it("notes each requested file the report holds no mutants for, whether it is absent or listed empty", () => {
		const lines = { "src/a.ts": [[10, 12]], "src/b.ts": [[1, 1]], "src/c.ts": [[1, 1]] } as Record<
			string,
			[number, number][]
		>;
		const { notes } = normaliseMutationReport(
			report({ "src/a.ts": [{ status: "Killed", line: 10 }], "src/c.ts": [] }),
			{ ...input, lines },
		);
		expect(notes).toEqual([
			"src/b.ts produced no mutants, so nothing on its changed lines was judged.",
			"src/c.ts produced no mutants, so nothing on its changed lines was judged.",
		]);
	});

	it("gives a skip leave to pass only for a change with nothing to mutate, an untrusted writer, or a timeout", () => {
		for (const reason of [
			mutationSkips.noProductionLines,
			mutationSkips.untrustedWriter("octocat has read permission on the repository"),
			mutationSkips.timeout(3600),
		])
			expect(mutationSkipHasLeave(reason), reason).toBe(true);
		for (const reason of [
			"static.mutation.enabled is false",
			"Stryker is not installed in the checkout",
			`${mutationSkips.noProductionLines}, and more`,
			`a ${mutationSkips.timeout(3600)}`,
			`the change adds or edits 2001 production TypeScript lines, past static.mutation.maxLines of 2000`,
			"the writer is not trusted",
		])
			expect(mutationSkipHasLeave(reason), reason).toBe(false);
	});

	it("refuses a status a finished run does not leave a mutant in, even in a file it does not read", () => {
		expect(() => read({ "src/a.ts": [{ status: "Pending", line: 10 }] })).toThrow(
			expect.objectContaining({ code: "invalidOutput", check: "static.mutation" }),
		);
		expect(() => read({ "src/other.ts": [{ status: "Pending", line: 1 }] })).toThrow(/Pending/);
	});

	it("refuses text that is not JSON or not a report", () => {
		for (const text of ["not json", "{}", JSON.stringify({ files: { "src/a.ts": { mutants: [{}] } } })])
			expect(() => normaliseMutationReport(text, input)).toThrow(CheckError);
		expect(() => normaliseMutationReport("not json", input)).toThrow(/not JSON/);
		expect(() => normaliseMutationReport("not json", input)).toThrow(
			expect.objectContaining({ cause: expect.any(SyntaxError) }),
		);
		expect(() => normaliseMutationReport("{}", input)).toThrow(
			"Stryker wrote a report Melian cannot read:  must have required properties files",
		);
	});

	it("encodes each path segment, orders results by file and line, and names a missing test file generically", () => {
		const unseen = normaliseMutationReport(report({ "src/a.ts": [{ status: "Survived", line: 10 }] }), {
			...input,
			tests: {},
		});
		expect(unseen.log.runs[0].results[0]!.advice!.whatToDo).toContain("Add or tighten a test in a test file so");
		expect(
			located({
				"src/b c.ts": [{ status: "Survived", line: 1 }],
				"src/a.ts": [
					{ status: "Survived", line: 12 },
					{ status: "Survived", line: 10 },
				],
			}),
		).toEqual([
			["src/a.ts", 10, undefined],
			["src/a.ts", 12, undefined],
			["src/b%20c.ts", 1, undefined],
		]);
	});

	it("orders files whichever order the report lists them in", () => {
		const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
		const lines = Object.fromEntries(paths.map((path) => [path, [[1, 1]] as [number, number][]]));
		for (const listed of [paths, [...paths].reverse(), [paths[2]!, paths[0]!, paths[3]!, paths[1]!]]) {
			const text = report(Object.fromEntries(listed.map((path) => [path, [{ status: "Survived", line: 1 }]])));
			const results = normaliseMutationReport(text, { version: "10.0.0", lines, tests: {} }).log.runs[0].results;
			expect(results.map((result) => result.locations[0]!.physicalLocation.artifactLocation.uri)).toEqual(paths);
		}
	});

	it("orders two results on one line by their message, and keeps both", () => {
		const { results } = read({
			"src/a.ts": [
				{ status: "Survived", line: 10, mutatorName: "StringLiteral" },
				{ status: "Survived", line: 10, mutatorName: "ArrayDeclaration" },
			],
		}).log.runs[0];
		expect(results.map((result) => result.message.text.split(" ")[0])).toEqual(["ArrayDeclaration", "StringLiteral"]);
	});

	it("shows the mutated text on one line, short, and without backticks", () => {
		const text = (replacement: string | undefined) =>
			read({ "src/a.ts": [{ status: "Survived", line: 10, replacement }] }).log.runs[0].results[0]!.message.text;
		expect(text("a\n   +  `b`\n")).toContain("changed to `a + 'b'`, every");
		expect(text("x".repeat(160))).toContain(`\`${"x".repeat(160)}\``);
		expect(text("x".repeat(161))).toContain(`\`${"x".repeat(160)}...\``);
		const noReplacement = JSON.parse(report({ "src/a.ts": [{ status: "Survived", line: 10 }] }));
		delete noReplacement.files["src/a.ts"].mutants[0].replacement;
		expect(
			normaliseMutationReport(JSON.stringify(noReplacement), input).log.runs[0].results[0]!.message.text,
		).toContain("changed to something else,");
	});
});
