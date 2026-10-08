import {
	CheckError,
	mutationNotJudged,
	mutationSkipHasLeave,
	mutationSkips,
	mutationUnmutated,
	mutationUnmutatedLog,
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
	outsideTests?: boolean;
}

interface StrykerConfig {
	ignoreStatic?: boolean;
	mutator?: { excludedMutations?: string[] };
}

// What the check's own stryker.config.json asks for, as Stryker writes it into the report.
const configured: StrykerConfig = { ignoreStatic: true, mutator: { excludedMutations: ["StringLiteral"] } };

function report(files: Record<string, Mutant[]>, config: StrykerConfig | null = configured): string {
	return JSON.stringify({
		schemaVersion: "1.0",
		...(config === null ? {} : { config }),
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
						...(mutant.outsideTests === undefined ? {} : { static: mutant.outsideTests }),
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
function read(files: Record<string, Mutant[]>, config: StrykerConfig | null = configured) {
	const asked = Object.entries(input.lines).filter(([path]) => Object.hasOwn(files, path));
	return normaliseMutationReport(report(files, config), {
		...input,
		lines: Object.fromEntries(asked),
	});
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

	describe("a survivor that code outside any test also reaches", () => {
		const warning = "Stryker also reached this line outside any test";
		const adviceOf = (mutant: Mutant) => read({ "src/a.ts": [mutant] }).log.runs[0].results[0]!.advice!.whatToDo;

		it("is told that the call may sit in a hook, a describe body, or module level", () => {
			expect(adviceOf({ status: "Survived", line: 10, outsideTests: true })).toContain(warning);
			expect(adviceOf({ status: "Survived", line: 10, outsideTests: true })).toMatch(
				/^Add or tighten a test in test\/a\.test\.ts /,
			);
		});

		it.each([
			["a survivor Stryker did not reach outside a test", { status: "Survived", line: 10, outsideTests: false }],
			["a survivor with no static flag", { status: "Survived", line: 10 }],
			["a mutant with no coverage", { status: "NoCoverage", line: 10, outsideTests: true }],
		])("is not told so for %s", (_name, mutant) => {
			expect(adviceOf(mutant)).not.toContain(warning);
		});
	});

	const ignoredText = (reason: string) =>
		`Stryker ignored the mutants of this changed line, so no test was asked about them (${reason}).`;
	// The reason Stryker 10.0.0 gives for a static mutant under ignoreStatic. A comment can carry the same text.
	const staticReason = 'Static mutant (and "ignoreStatic" was enabled)';

	it("reports a comment-ignored mutant on a changed line as one ignored-mutant result per line, with Stryker's reason, and nothing off the changed lines", () => {
		const { log, notes } = read({
			"src/a.ts": [
				{ status: "Killed", line: 10 },
				{ status: "Ignored", line: 12, reason: "Ignored using a comment" },
				{ status: "Ignored", line: 11, reason: "Needs a network" },
				{ status: "Ignored", line: 11, reason: "Another reason" },
				{ status: "Ignored", line: 99, reason: "Ignored using a comment" },
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
			["ignored-mutant", "error", 11, ignoredText("Needs a network")],
			["ignored-mutant", "error", 12, ignoredText("Ignored using a comment")],
		]);
		expect(notes).toEqual([]);
		expect(log.runs[0].results[0]!.advice).toEqual({
			whyHere:
				"The head's own text told Stryker not to judge this changed line, so a guard here would stay unproven.",
			whatToDo:
				"Remove the comment that excludes this line and test the behaviour, or acknowledge the exclusion if it is deliberate.",
		});
	});

	it("makes the static mutants ignoreStatic skips one unmutated finding per file naming the lines, and an excluded mutator's a note", () => {
		const { log, notes } = read({
			"src/a.ts": [
				{ status: "Ignored", line: 12, outsideTests: true },
				{ status: "Ignored", line: 10, outsideTests: true },
				{ status: "Ignored", line: 10, outsideTests: true },
				{ status: "Ignored", line: 11, mutatorName: "StringLiteral" },
				{ status: "Ignored", line: 99, outsideTests: true },
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
				"unmutated",
				"error",
				10,
				"Stryker did not judge lines 10, 12 of src/a.ts: its mutants are static, meaning they run when the module loads, such as a constant, a regular expression, or a table, and the run's ignoreStatic setting skips them, so no test was asked about them.",
			],
		]);
		expect(notes).toEqual([
			"src/a.ts line(s) 11 hold mutants Stryker ignored by a setting in its configuration (an excluded mutation), so no test was asked about them.",
		]);
	});

	it("joins neighbouring static lines into one range, and names a single line as a line", () => {
		const text = (lines: number[]) =>
			read({
				"src/a.ts": lines.map((line) => ({ status: "Ignored", line, outsideTests: true })),
			}).log.runs[0].results.map((result) => result.message.text.split(": ")[0]);
		expect(text([10, 11, 12])).toEqual(["Stryker did not judge lines 10-12 of src/a.ts"]);
		expect(text([10])).toEqual(["Stryker did not judge line 10 of src/a.ts"]);
		expect(text([12, 10])).toEqual(["Stryker did not judge lines 10, 12 of src/a.ts"]);
	});

	it("keeps a static finding per file, in path order, and a comment-ignored mutant on the same line a finding as well", () => {
		const { log } = read({
			"src/b c.ts": [{ status: "Ignored", line: 1, outsideTests: true }],
			"src/a.ts": [
				{ status: "Ignored", line: 10, outsideTests: true },
				{ status: "Ignored", line: 10, reason: "Ignored using a comment" },
			],
		});
		expect(
			log.runs[0].results.map((result) => [
				result.ruleId,
				result.locations[0]!.physicalLocation.artifactLocation.uri,
			]),
		).toEqual([
			["unmutated", "src/a.ts"],
			["ignored-mutant", "src/a.ts"],
			["unmutated", "src/b%20c.ts"],
		]);
	});

	it("notes only an Ignored mutant, whatever else another status carries", () => {
		const { log, notes } = read({
			"src/a.ts": [
				{ status: "Killed", line: 10, outsideTests: true },
				{ status: "Timeout", line: 11, outsideTests: true },
			],
		});
		expect(log.runs[0].results).toEqual([]);
		expect(notes).toEqual([expect.stringContaining("1 Timeout mutant(s)")]);
	});

	describe("a comment that copies the reason a setting gives", () => {
		const forged = [
			["the static reason", staticReason],
			["the exclusion reason", 'Ignored because of excluded mutation "StringLiteral"'],
			["text before the exclusion reason", 'x Ignored because of excluded mutation "ConditionalExpression"'],
		] as const;

		it.each(forged)(
			"is a finding when the mutant is not static and its mutator is not excluded: %s",
			(_name, reason) => {
				const { log, notes } = read({ "src/a.ts": [{ status: "Ignored", line: 10, reason }] });
				expect(log.runs[0].results.map((result) => result.ruleId)).toEqual(["ignored-mutant"]);
				expect(notes).toEqual([]);
			},
		);

		it("is a finding for a static mutant when the run did not enable ignoreStatic", () => {
			for (const config of [null, {}, { ignoreStatic: false }, { mutator: { excludedMutations: [] } }]) {
				const { log, notes } = read(
					{ "src/a.ts": [{ status: "Ignored", line: 10, reason: staticReason, outsideTests: true }] },
					config,
				);
				expect(log.runs[0].results.map((result) => result.ruleId)).toEqual(["ignored-mutant"]);
				expect(notes).toEqual([]);
			}
		});

		it("is a finding for a mutant of an excluded mutator's neighbour, not of the excluded one", () => {
			const { log } = read(
				{
					"src/a.ts": [
						{ status: "Ignored", line: 10, reason: "Ignored using a comment", mutatorName: "StringLiteralX" },
					],
				},
				{ mutator: { excludedMutations: ["StringLiteral"] } },
			);
			expect(log.runs[0].results.map((result) => result.ruleId)).toEqual(["ignored-mutant"]);
		});

		it("is a note when the report's configuration does exclude the mutator, whatever the reason says", () => {
			const { log, notes } = read(
				{
					"src/a.ts": [
						{ status: "Ignored", line: 10, reason: "Ignored using a comment", mutatorName: "StringLiteral" },
					],
				},
				{ mutator: { excludedMutations: ["StringLiteral"] } },
			);
			expect(log.runs[0].results).toEqual([]);
			expect(notes).toHaveLength(1);
		});
	});

	it("fails closed to a finding naming Stryker's silence for an Ignored mutant that carries no reason", () => {
		const { log, notes } = read({ "src/a.ts": [{ status: "Ignored", line: 10 }] });
		expect(log.runs[0].results.map((result) => result.message.text)).toEqual([
			ignoredText("Stryker gives no reason"),
		]);
		expect(notes).toEqual([]);
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

	it("gives a skip leave to pass only for the causes of a change with nothing to mutate, an untrusted writer, no sandbox, or a timeout", () => {
		for (const cause of ["noProductionLines", "untrustedWriter", "noSandbox", "timeout"])
			expect(mutationSkipHasLeave(cause), cause).toBe(true);
		for (const cause of ["unmutated", "", "Timeout", "static.mutation.enabled is false", mutationSkips.timeout(3600)])
			expect(mutationSkipHasLeave(cause), cause).toBe(false);
		expect(mutationSkipHasLeave(undefined)).toBe(false);
	});

	it("words each skip reason as the review shows it", () => {
		expect(mutationSkips.noProductionLines).toBe("the change adds or edits no production TypeScript lines");
		expect(mutationSkips.untrustedWriter("octocat has read permission")).toBe(
			"the writer is not a trusted one (octocat has read permission), so Stryker did not run: static.mutation executes the head's own tests",
		);
		expect(mutationSkips.noSandbox).toBe(
			"the host offers no sandbox (sandbox-exec on macOS, bwrap on Linux), so Stryker did not run: static.mutation executes the head's own tests and runs them only confined",
		);
		expect(mutationSkips.timeout(7)).toBe("Stryker ran past static.mutation.timeout of 7 seconds before it finished");
		expect(mutationSkips.unmutated(["src/a.ts", "src/b.ts"])).toBe(
			"the change adds or edits lines of production TypeScript files that Stryker is not asked to mutate (src/a.ts, src/b.ts), so none of them was judged",
		);
	});

	it("reads an ignored mutant against a configuration that has a mutator section with no exclusions, or none at all", () => {
		for (const config of [{ mutator: {} }, { ignoreStatic: true, mutator: {} }, {}]) {
			const { log } = read(
				{ "src/a.ts": [{ status: "Ignored", line: 10, reason: "Ignored using a comment" }] },
				config,
			);
			expect(log.runs[0].results.map((result) => result.ruleId)).toEqual(["ignored-mutant"]);
		}
	});

	describe("mutationNotJudged", () => {
		const lines = { "src/b.ts": [[7, 9]], "src/a c.ts": [[3, 4]] } as Record<string, [number, number][]>;

		it("is one unmutated result at the first changed line of the first file, naming every file", () => {
			const log = mutationNotJudged({ version: "10.0.0", lines }, "it ran too long");
			expect(log.runs[0].tool.driver).toEqual({ name: "Stryker", version: "10.0.0" });
			expect(log.runs[0].results).toHaveLength(1);
			const [result] = log.runs[0].results;
			expect(result!.ruleId).toBe("unmutated");
			expect(result!.level).toBe("error");
			expect(result!.message.text).toBe(
				"Stryker did not judge the changed lines of src/a c.ts, src/b.ts: it ran too long.",
			);
			expect(result!.locations[0]!.physicalLocation).toEqual({
				artifactLocation: { uri: "src/a%20c.ts" },
				region: { startLine: 3 },
			});
			expect(Value.Check(toolLogSchema, log)).toBe(true);
		});

		it("is a log with no result when no file was asked for", () => {
			expect(mutationNotJudged({ version: "10.0.0", lines: {} }, "x").runs[0].results).toEqual([]);
		});
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

it("retains the driver, location and advice of unmutated binary and bounded files", () => {
	const files = [
		{ path: "src/binary.ts", ranges: [] as [number, number][], ...mutationUnmutated.binary },
		{ path: "src/bounded.ts", ranges: [[4, 6]] as [number, number][], ...mutationUnmutated.pastBound(3) },
	];
	const log = mutationUnmutatedLog("10.0.0", files);
	expect(normaliseMutationReport(report({}), { ...input, lines: {}, unmutated: files }).log).toEqual(log);
	expect(log.runs[0].tool).toEqual({ driver: { name: "Stryker", version: "10.0.0" } });
	expect(
		log.runs[0].results.map((result) => ({ advice: result.advice, location: result.locations[0]!.physicalLocation })),
	).toEqual(
		files.map((file, index) => ({
			advice: {
				whyHere: "Stryker was not asked about these changed lines, so a guard here would stay unproven.",
				whatToDo: file.whatToDo,
			},
			location: { artifactLocation: { uri: file.path }, region: { startLine: index === 0 ? 1 : 4 } },
		})),
	);
	expect(Value.Check(toolLogSchema, log)).toBe(true);
});

it("sorts excluded-mutator notes by path and sorts their lines numerically", () => {
	const lines = { "src/a.ts!b.ts": [[1, 12]], "src/a.ts": [[1, 12]] } as Record<string, [number, number][]>;
	const files = Object.fromEntries(
		Object.keys(lines).map((path) => [
			path,
			[10, 2].map((line) => ({ status: "Ignored", line, mutatorName: "StringLiteral" })),
		]),
	);
	const { notes } = normaliseMutationReport(report(files), { ...input, lines });
	expect(notes).toEqual(
		Object.keys(lines)
			.reverse()
			.map(
				(path) =>
					`${path} line(s) 2, 10 hold mutants Stryker ignored by a setting in its configuration (an excluded mutation), so no test was asked about them.`,
			),
	);
});
