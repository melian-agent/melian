import { readFileSync } from "node:fs";
import {
	capSnippet,
	createFinding,
	createFindingsLog,
	type Finding,
	FindingError,
	findingId,
	findingsLogSchema,
	levelForSeverity,
	maxEvidenceLocations,
	maxFailureScenarioLength,
	maxSnippetBytes,
	normaliseSnippet,
	parseFinding,
	reportFindingInputSchema,
	snippetHash,
	snippetOccurrence,
	upgradeStoredFinding,
} from "@melian-agent/core";
import Schema from "typebox/schema";
import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { evalInput, minimalInput } from "./fixtures/findings.ts";

// The OASIS SARIF 2.1.0 schema as published in microsoft/sarif-sdk (MIT): src/Sarif/Schemata/sarif-2.1.0.json.
const sarifSchema = JSON.parse(
	readFileSync(new URL("./fixtures/sarif-schema-2.1.0.json", import.meta.url), "utf8"),
) as Schema.XSchema;

const evalCall = { file: "src/run.ts", rule: "no-eval", snippet: "eval(input)", occurrence: 0 };

function rejection(value: unknown): FindingError {
	try {
		parseFinding(value);
	} catch (error) {
		expect(error).toBeInstanceOf(FindingError);
		return error as FindingError;
	}
	throw new Error("parseFinding accepted an invalid finding");
}

describe("findingId", () => {
	it("is 16 lowercase hex characters", () => {
		expect(findingId(evalCall)).toMatch(/^[0-9a-f]{16}$/);
	});

	// Pinned so that a change to the normalisation, which would orphan every stored finding, fails here first.
	it("hashes the file, rule, normalised snippet, and occurrence", () => {
		expect(findingId(evalCall)).toBe("c0dc5445aa6ee891");
	});

	// Pinned for the same reason, with code as a formatter really rewraps it.
	it("gives a call chain and its formatter rewrap one pinned ID", () => {
		const chain = { ...evalCall, snippet: "const rows = items.filter((item) => item.open).map(toRow);" };
		const rewrapped = {
			...evalCall,
			snippet: "const rows = items\n\t.filter((item) => item.open)\n\t.map(toRow);",
		};
		expect(findingId(rewrapped)).toBe(findingId(chain));
		expect(findingId(chain)).toBe("315b591698a6f2e9");
	});

	it("ignores whitespace beside punctuation, so one argument per line is the same call", () => {
		expect(findingId({ ...evalCall, snippet: "foo(\n  a,\n  b\n)" })).toBe(
			findingId({ ...evalCall, snippet: "foo(a, b)" }),
		);
	});

	it("keeps one space between words, so return x is not returnx", () => {
		expect(normaliseSnippet("return   x")).toBe("return x");
		expect(normaliseSnippet(" a  +\n b ")).toBe("a+b");
		expect(normaliseSnippet("café  naïve")).toBe("café naïve");
	});

	it("ignores reindenting and rewrapping the flagged code", () => {
		const reflowed = { ...evalCall, snippet: "\n\t  eval(\n\t\tinput\n\t)  " };
		expect(findingId({ ...evalCall, snippet: "eval( input )" })).toBe(findingId(reflowed));
		expect(findingId({ ...evalCall, snippet: "  eval(input)\n" })).toBe(findingId(evalCall));
	});

	it("changes when one token of the flagged code changes", () => {
		expect(findingId({ ...evalCall, snippet: "eval(body)" })).not.toBe(findingId(evalCall));
	});

	it("changes with the file or the rule", () => {
		expect(findingId({ ...evalCall, file: "src/main.ts" })).not.toBe(findingId(evalCall));
		expect(findingId({ ...evalCall, rule: "no-implied-eval" })).not.toBe(findingId(evalCall));
	});

	it("keeps fields apart, so text cannot move from one field to the next", () => {
		expect(findingId({ file: "a", rule: "bc", snippet: "d", occurrence: 0 })).not.toBe(
			findingId({ file: "ab", rule: "c", snippet: "d", occurrence: 0 }),
		);
	});

	it("keeps fields apart even when one contains NUL", () => {
		expect(findingId({ file: "a\0b", rule: "c", snippet: "d", occurrence: 0 })).not.toBe(
			findingId({ file: "a", rule: "b\0c", snippet: "d", occurrence: 0 }),
		);
	});

	it("tells identical snippets in one file apart by occurrence", () => {
		expect(findingId({ ...evalCall, occurrence: 1 })).not.toBe(findingId(evalCall));
	});

	it("needs an occurrence with a snippet and a discriminator without one", () => {
		const missing = (input: Parameters<typeof findingId>[0]) => {
			try {
				findingId(input);
			} catch (error) {
				expect(error).toBeInstanceOf(FindingError);
				return (error as FindingError).code;
			}
			throw new Error("findingId accepted a finding it cannot tell apart");
		};
		expect(missing({ ...evalCall, occurrence: undefined })).toBe("missingDiscriminator");
		expect(missing({ ...evalCall, occurrence: -1 })).toBe("missingDiscriminator");
		expect(missing({ file: "src/total.ts", rule: "prefer-const", snippet: "  " })).toBe("missingDiscriminator");
		expect(findingId({ file: "src/total.ts", rule: "prefer-const", snippet: "", discriminator: "total" })).toMatch(
			/^[0-9a-f]{16}$/,
		);
	});
});

describe("snippetOccurrence", () => {
	const source = ["function run(input) {", "  eval(input);", "  log();", "  return eval(input);", "}"].join("\n");
	const shifted = `import { log } from "./log";\n\n${source}`;

	function id(text: string, startLine: number): string {
		const occurrence = snippetOccurrence(text, "eval(input)", { startLine });
		return createFinding({ ...evalInput, startLine, occurrence, trigger: undefined }).properties.id;
	}

	it("counts identical normalised snippets above the region", () => {
		expect(snippetOccurrence(source, "eval(input)", { startLine: 2 })).toBe(0);
		expect(snippetOccurrence(source, " eval(input)\n", { startLine: 4 })).toBe(1);
		const wrapped = "f(a, b);\nf(\n  a,\n  b\n);";
		expect(snippetOccurrence(wrapped, "f(a, b)", { startLine: 2, endLine: 5 })).toBe(1);
	});

	it("gives identical snippets at two lines different IDs", () => {
		expect(id(source, 2)).not.toBe(id(source, 4));
	});

	it("keeps both IDs when lines are inserted above them", () => {
		expect([id(shifted, 4), id(shifted, 6)]).toEqual([id(source, 2), id(source, 4)]);
	});

	it("tells two snippets on one line apart by column", () => {
		const twice = "f(x); f(x);";
		expect(snippetOccurrence(twice, "f(x)", { startLine: 1 })).toBe(0);
		expect(snippetOccurrence(twice, "f(x)", { startLine: 1, startColumn: 7 })).toBe(1);
	});

	it("refuses a snippet that does not start in the region", () => {
		expect(() => snippetOccurrence(source, "eval(input)", { startLine: 3 })).toThrow(
			expect.objectContaining({ code: "snippetNotFound" }),
		);
		expect(() => snippetOccurrence(source, "eval(body)", { startLine: 2 })).toThrow(FindingError);
		expect(() => snippetOccurrence(source, " ", { startLine: 2 })).toThrow(FindingError);
	});
});

describe("reportFindingInputSchema", () => {
	const report = {
		file: "src/run.ts",
		line: 12,
		rule: "no-eval",
		severity: "P1",
		explanation: { what: "eval runs input", why: "this change routes input to it", fix: "parse it" },
		failureScenario: "A request whose body is `process.exit()` stops the server.",
		evidence: [{ file: "src/run.ts", line: 12, role: "cause" }],
	};

	it("accepts a location, rule, severity, explanation, failure scenario, and evidence", () => {
		expect(Value.Check(reportFindingInputSchema, report)).toBe(true);
		const evidence = [
			{ file: "src/api.ts", line: 3, endLine: 4, role: "cause" },
			{ file: "src/api.ts", line: 9, role: "context", revision: "base" },
		];
		expect(Value.Check(reportFindingInputSchema, { ...report, endLine: 14, evidence })).toBe(true);
	});

	it("requires a failure scenario of bounded, non-blank prose", () => {
		const { failureScenario: _, ...without } = report;
		expect(Value.Check(reportFindingInputSchema, without)).toBe(false);
		expect(Value.Check(reportFindingInputSchema, { ...report, failureScenario: "  \n" })).toBe(false);
		const long = "x".repeat(maxFailureScenarioLength + 1);
		expect(Value.Check(reportFindingInputSchema, { ...report, failureScenario: long })).toBe(false);
	});

	it("requires at least one evidence location, each with a role", () => {
		const { evidence: _, ...without } = report;
		expect(Value.Check(reportFindingInputSchema, without)).toBe(false);
		expect(Value.Check(reportFindingInputSchema, { ...report, evidence: [] })).toBe(false);
		const roleless = [{ file: "src/run.ts", line: 12 }];
		expect(Value.Check(reportFindingInputSchema, { ...report, evidence: roleless })).toBe(false);
		const blamed = [{ file: "src/run.ts", line: 12, role: "blame" }];
		expect(Value.Check(reportFindingInputSchema, { ...report, evidence: blamed })).toBe(false);
		const tooMany = Array.from({ length: maxEvidenceLocations + 1 }, () => report.evidence[0]);
		expect(Value.Check(reportFindingInputSchema, { ...report, evidence: tooMany })).toBe(false);
	});

	it("refuses prose as evidence, and a lens-quoted snippet", () => {
		expect(Value.Check(reportFindingInputSchema, { ...report, evidence: "src/api.ts:3 renames id" })).toBe(false);
		const quoted = [{ ...report.evidence[0], snippet: "eval(input)" }];
		expect(Value.Check(reportFindingInputSchema, { ...report, evidence: quoted })).toBe(false);
	});

	it.each(["snippet", "cause", "resolution", "status", "source"])("refuses a lens-chosen %s", (key) => {
		expect(Value.Check(reportFindingInputSchema, { ...report, [key]: "x" })).toBe(false);
	});
});

describe("capSnippet", () => {
	it("keeps a snippet that fits in 2 KiB whole", () => {
		const fits = "x".repeat(maxSnippetBytes);
		expect(capSnippet(fits)).toBe(fits);
	});

	it("cuts a longer one at a character boundary and marks the cut", () => {
		for (const unit of ["x", "€", "😀"]) {
			const text = capSnippet(unit.repeat(maxSnippetBytes + 1));
			const kept = text.slice(0, -" [cut at 2 KiB]".length);
			expect(text.endsWith(" [cut at 2 KiB]")).toBe(true);
			expect(kept).toBe(unit.repeat(kept.length / unit.length));
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxSnippetBytes);
			expect(Buffer.byteLength(text)).toBeGreaterThan(maxSnippetBytes - 4);
		}
	});
});

describe("snippetHash", () => {
	it("hashes two snippets that normalise alike alike, and a changed token apart", () => {
		expect(snippetHash("foo(a, b)")).toMatch(/^[0-9a-f]{64}$/);
		expect(snippetHash("\tfoo(\n\t\ta,\n\t\tb\n\t)")).toBe(snippetHash("foo(a, b)"));
		expect(snippetHash("foo(a, c)")).not.toBe(snippetHash("foo(a, b)"));
	});
});

describe("levelForSeverity", () => {
	it("maps P0 and P1 to error, P2 to warning, and P3 and nit to note", () => {
		const severities = ["P0", "P1", "P2", "P3", "nit"] as const;
		expect(severities.map(levelForSeverity)).toEqual(["error", "error", "warning", "note", "note"]);
	});
});

describe("createFinding", () => {
	it("builds a SARIF result with Melian's extensions in its property bag", () => {
		expect(createFinding(evalInput)).toEqual({
			ruleId: "no-eval",
			level: "error",
			message: { text: "eval runs request input" },
			partialFingerprints: { "melian/v1": findingId(evalCall) },
			locations: [
				{
					physicalLocation: {
						artifactLocation: { uri: "src/run.ts" },
						region: {
							startLine: 12,
							endLine: 12,
							startColumn: 3,
							endColumn: 14,
							snippet: { text: "eval(input)" },
						},
					},
				},
			],
			properties: {
				id: findingId(evalCall),
				path: "src/run.ts",
				occurrence: 0,
				cause: "introduced",
				trigger: { file: "src/run.ts", index: 0 },
				severity: "P1",
				confidence: 0.9,
				resolution: "block",
				status: "new",
				explanation: evalInput.explanation,
				source: { check: "lens.security", version: "1" },
			},
		});
	});

	it("leaves absent optional fields out rather than storing undefined", () => {
		const finding = createFinding(minimalInput);
		expect(finding.locations[0]!.physicalLocation.region).toEqual({ startLine: 4 });
		expect(Object.keys(finding.properties).sort()).toEqual(
			["cause", "discriminator", "explanation", "id", "path", "resolution", "severity", "source", "status"].sort(),
		);
		expect(finding.properties.id).toBe(
			findingId({ file: "src/total.ts", rule: "prefer-const", snippet: "", discriminator: "total" }),
		);
	});

	it("refuses a finding without a snippet or a discriminator", () => {
		expect(() => createFinding({ ...minimalInput, discriminator: undefined })).toThrow(
			expect.objectContaining({ code: "missingDiscriminator" }),
		);
	});

	it("stores evidence with canonical paths, and keeps the ID free of evidence and failure scenario", () => {
		const evidence = [
			{
				file: "./src//api.ts",
				startLine: 3,
				role: "cause" as const,
				revision: "head" as const,
				snippet: "export function load(userId: string) {",
			},
			{
				file: "src/run.ts",
				startLine: 12,
				role: "context" as const,
				revision: "head" as const,
				snippet: "eval(input)",
			},
		];
		const failureScenario = "load(42) passes a number where a string is now required.";
		const affected = createFinding({ ...evalInput, cause: "affected", evidence, failureScenario });
		expect(affected.properties.cause).toBe("affected");
		expect(affected.properties.failureScenario).toBe(failureScenario);
		expect(affected.properties.evidence).toEqual([{ ...evidence[0], file: "src/api.ts" }, evidence[1]]);
		expect(affected.properties.id).toBe(createFinding(evalInput).properties.id);
		const other = createFinding({ ...evalInput, evidence: [evidence[1]!], failureScenario: "Something else." });
		expect(other.properties.id).toBe(affected.properties.id);
		expect(createFinding(evalInput).properties).not.toHaveProperty("evidence");
		expect(() => createFinding({ ...evalInput, evidence: [{ ...evidence[0]!, snippet: "" }] })).toThrow(FindingError);
		expect(() => createFinding({ ...evalInput, evidence: [{ ...evidence[0]!, endLine: 2 }] })).toThrow(
			expect.objectContaining({ code: "invalidRegion", path: "/properties/evidence/0" }),
		);
	});

	it("makes a finding affected only with a cause location", () => {
		const context = {
			file: "src/api.ts",
			startLine: 3,
			role: "context" as const,
			revision: "head" as const,
			snippet: "x",
		};
		expect(() => createFinding({ ...evalInput, cause: "affected" })).toThrow(
			expect.objectContaining({ code: "missingEvidence" }),
		);
		expect(() => createFinding({ ...evalInput, cause: "affected", evidence: [context] })).toThrow(
			expect.objectContaining({ code: "missingEvidence" }),
		);
	});

	it("rejects a region that ends before it starts", () => {
		for (const region of [
			{ startLine: 12, endLine: 3 },
			{ startLine: 12, endLine: 12, startColumn: 9, endColumn: 2 },
			{ startLine: 12, endLine: undefined, startColumn: 9, endColumn: 2 },
		]) {
			expect(() => createFinding({ ...evalInput, ...region })).toThrow(
				expect.objectContaining({ code: "invalidRegion", path: "/locations/0/physicalLocation/region" }),
			);
		}
		expect(createFinding({ ...evalInput, startLine: 12, endLine: 13, startColumn: 9, endColumn: 2 })).toBeDefined();
	});

	it("drops undefined-valued keys at any depth", () => {
		const finding = createFinding({ ...evalInput, trigger: { file: "src/run.ts", index: 0, snippet: undefined } });
		expect(Object.keys(finding.properties.trigger!)).toEqual(["file", "index"]);
		const nested = { ...finding, message: { text: "eval runs request input", markdown: undefined } };
		expect(parseFinding(nested)).toEqual(JSON.parse(JSON.stringify(nested)));
		expect(parseFinding(nested).message).not.toHaveProperty("markdown");
	});

	it("takes its ID from the whole of a snippet over 2 KiB and stores it cut, so a reindent keeps the ID", () => {
		const cells = Array.from({ length: 300 }, (_, index) => `"cell${index}"`);
		const whole = `const table = [${cells.join(", ")}];`;
		const finding = createFinding({ ...evalInput, snippet: whole });
		const stored = finding.locations[0]!.physicalLocation.region.snippet!.text;
		expect(finding.properties.id).toBe(findingId({ ...evalInput, snippet: whole }));
		expect(stored).toBe(capSnippet(whole));
		expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(maxSnippetBytes);
		expect(parseFinding(JSON.parse(JSON.stringify(finding)))).toEqual(finding);
		const reindented = createFinding({ ...evalInput, snippet: `\t\t${whole.replaceAll(", ", ",\n\t\t\t")}` });
		expect(reindented.properties.id).toBe(finding.properties.id);
		const changedPastTheCut = createFinding({ ...evalInput, snippet: whole.replace("cell299", "cell300") });
		expect(changedPastTheCut.locations[0]!.physicalLocation.region.snippet!.text).toBe(stored);
		expect(changedPastTheCut.properties.id).not.toBe(finding.properties.id);
	});

	it("rejects an input the schema would not accept", () => {
		expect(() => createFinding({ ...evalInput, startLine: 0 })).toThrow(FindingError);
		expect(() => createFinding({ ...evalInput, confidence: 1.5 })).toThrow(FindingError);
	});
});

describe("a findings log", () => {
	const log = createFindingsLog([createFinding(evalInput), createFinding(minimalInput)]);

	it("is valid SARIF 2.1.0", () => {
		const [valid, errors] = Schema.Errors(sarifSchema, log);
		expect(errors).toEqual([]);
		expect(valid).toBe(true);
	});

	it("matches the findings log schema", () => {
		expect(Value.Errors(findingsLogSchema, log)).toEqual([]);
	});

	it("keeps Melian's extensions through a JSON round trip", () => {
		const parsed = JSON.parse(JSON.stringify(log)) as typeof log;
		expect(parsed).toEqual(log);
		const findings = parsed.runs[0]!.results.map(({ ruleIndex: _, ...finding }) => parseFinding(finding));
		expect(findings).toEqual([createFinding(evalInput), createFinding(minimalInput)]);
	});

	it("lists each rule once and points every result at its rule", () => {
		const twice = createFindingsLog([
			createFinding(evalInput),
			createFinding(minimalInput),
			createFinding(evalInput),
		]);
		const [run] = twice.runs;
		expect(run!.tool.driver.rules).toEqual([{ id: "no-eval" }, { id: "prefer-const" }]);
		for (const result of run!.results) expect(run!.tool.driver.rules[result.ruleIndex]!.id).toBe(result.ruleId);
		expect(Schema.Errors(sarifSchema, twice)[1]).toEqual([]);
	});

	it("carries each finding's ID as a partial fingerprint for GitHub code scanning", () => {
		for (const result of log.runs[0]!.results) {
			expect(result.partialFingerprints).toEqual({ "melian/v1": result.properties.id });
		}
	});

	it.each([
		["a space", "docs/release notes.md", "docs/release%20notes.md"],
		["a percent sign", "src/100%.ts", "src/100%25.ts"],
		["a hash", "src/#private.ts", "src/%23private.ts"],
		["a question mark", "src/why?.ts", "src/why%3F.ts"],
		["non-ASCII", "src/café/naïve.ts", "src/caf%C3%A9/na%C3%AFve.ts"],
		["a colon in the first segment", "c:/run.ts", "c%3A/run.ts"],
	])("encodes a path with %s as a valid URI and keeps the raw path", (_, file, uri) => {
		const finding = createFinding({ ...evalInput, file, trigger: undefined });
		const location = finding.locations[0]!.physicalLocation.artifactLocation;
		expect(location.uri).toBe(uri);
		expect(location.uri.split("/").map(decodeURIComponent).join("/")).toBe(file);
		expect(finding.properties.path).toBe(file);
		expect(finding.properties.id).toBe(findingId({ ...evalCall, file }));
		expect(Schema.Errors(sarifSchema, createFindingsLog([finding]))[1]).toEqual([]);
	});

	it("is not valid SARIF once an extension moves out of the property bag", () => {
		const finding = createFinding(evalInput);
		const moved = { ...finding, severity: finding.properties.severity };
		expect(Schema.Check(sarifSchema, createFindingsLog([moved as Finding]))).toBe(false);
	});
});

describe("parseFinding", () => {
	const finding = createFinding(evalInput);

	it.each([
		["absolute", "/etc/passwd"],
		["escaping the repository", "../outside.ts"],
		["escaping from inside", "src/../../outside.ts"],
		["empty", ""],
		["only dots", "./"],
		["Windows-style", "src\\run.ts"],
	])("refuses a path that is %s", (_, file) => {
		expect(() => createFinding({ ...evalInput, file, trigger: undefined })).toThrow(
			expect.objectContaining({ code: "invalidPath", path: "/properties/path" }),
		);
	});

	it("refuses a trigger in a file outside the repository", () => {
		const trigger = { ...evalInput.trigger!, file: "../run.ts" };
		expect(() => createFinding({ ...evalInput, trigger })).toThrow(
			expect.objectContaining({ code: "invalidPath", path: "/properties/trigger/file" }),
		);
	});

	it("canonicalises a path, so one file has one ID", () => {
		for (const file of ["./src/run.ts", "src//run.ts", "src/./run.ts", "src/run.ts/"]) {
			const finding = createFinding({ ...evalInput, file, trigger: { ...evalInput.trigger!, file } });
			expect(finding.properties.path).toBe("src/run.ts");
			expect(finding.properties.trigger?.file).toBe("src/run.ts");
			expect(finding.properties.id).toBe(createFinding(evalInput).properties.id);
		}
	});

	it("refuses a stored path that is not canonical", () => {
		const finding = createFinding(evalInput);
		const value = { ...finding, properties: { ...finding.properties, path: "./src/run.ts" } };
		expect(rejection(value).code).toBe("invalidPath");
	});

	it("refuses a URI that does not encode the path", () => {
		const moved = structuredClone(finding);
		moved.locations[0]!.physicalLocation.artifactLocation.uri = "src/other.ts";
		expect(rejection(moved).code).toBe("invalidPath");
	});

	it("rejects an unknown key in the property bag, so a misspelt optional key is not lost", () => {
		const error = rejection({ ...finding, properties: { ...finding.properties, confidance: 0.5 } });
		expect(error.code).toBe("invalidFinding");
		expect(error.path).toBe("/properties/confidance");
		expect(error.message).toBe("finding has an unknown key at /properties/confidance");
	});

	it.each([
		["the result", (value: Record<string, unknown>) => Object.assign(value, { kind: "fail" }), "/kind"],
		["the message", (value: Finding) => Object.assign(value.message, { markdown: "**x**" }), "/message/markdown"],
		[
			"the region",
			(value: Finding) => Object.assign(value.locations[0]!.physicalLocation.region, { byteOffset: 0 }),
			"/locations/0/physicalLocation/region/byteOffset",
		],
		[
			"the artifact location",
			(value: Finding) =>
				Object.assign(value.locations[0]!.physicalLocation.artifactLocation, { uriBaseId: "%SRCROOT%" }),
			"/locations/0/physicalLocation/artifactLocation/uriBaseId",
		],
		[
			"the snippet",
			(value: Finding) => Object.assign(value.locations[0]!.physicalLocation.region.snippet!, { binary: "AA==" }),
			"/locations/0/physicalLocation/region/snippet/binary",
		],
	])("rejects an unknown member of %s", (_, add, path) => {
		const value = structuredClone(finding);
		add(value as Finding & Record<string, unknown>);
		const error = rejection(value);
		expect(error.code).toBe("invalidFinding");
		expect(error.path).toBe(path);
	});

	it("rejects an affected finding without a cause location, and accepts evidence on any cause", () => {
		const evidence = [
			{ file: "src/api.ts", startLine: 3, role: "cause" as const, revision: "head" as const, snippet: "rename(id)" },
		];
		const affected = createFinding({ ...evalInput, cause: "affected", evidence });
		const { evidence: _, ...bare } = affected.properties;
		expect(rejection({ ...affected, properties: bare }).code).toBe("missingEvidence");
		expect(parseFinding({ ...finding, properties: { ...finding.properties, evidence } }).properties.evidence).toEqual(
			evidence,
		);
		const empty = rejection({ ...finding, properties: { ...finding.properties, evidence: [] } });
		expect(empty.code).toBe("invalidFinding");
		expect(empty.path).toBe("/properties/evidence");
	});

	it("rejects a finding without a location", () => {
		const error = rejection({ ...finding, locations: [] });
		expect(error.code).toBe("invalidFinding");
		expect(error.path).toBe("/locations");
	});

	it("rejects a level that does not follow the severity", () => {
		const error = rejection({ ...finding, level: "warning" });
		expect(error.code).toBe("levelMismatch");
		expect(error.message).toBe("a P1 finding has level error, not warning");
	});

	it("rejects a fingerprint that is not the finding's ID", () => {
		const error = rejection({ ...finding, partialFingerprints: { "melian/v1": "0123456789abcdef" } });
		expect(error.code).toBe("idMismatch");
		expect(error.path).toBe("/partialFingerprints/melian~1v1");
	});

	it("rejects an ID that is not the finding's stable ID", () => {
		const error = rejection({ ...finding, ruleId: "no-implied-eval" });
		expect(error.code).toBe("idMismatch");
		expect(error.path).toBe("/properties/id");
	});
});

describe("upgradeStoredFinding", () => {
	it("reads a single old-shape evidence location as one cause at head", () => {
		const evidence = [
			{ file: "src/api.ts", startLine: 3, role: "cause" as const, revision: "head" as const, snippet: "rename(id)" },
		];
		const current = createFinding({ ...evalInput, cause: "affected", evidence });
		const { role: _, revision: __, ...old } = evidence[0]!;
		const stored = { ...current, properties: { ...current.properties, evidence: old } };
		expect(upgradeStoredFinding(stored)).toEqual(current);
		expect(parseFinding(upgradeStoredFinding(stored))).toEqual(current);
	});

	it("leaves a finding without evidence, or with a list, as it is", () => {
		const plain = createFinding(evalInput);
		expect(upgradeStoredFinding(plain)).toBe(plain);
		expect(upgradeStoredFinding(plain).properties).not.toHaveProperty("failureScenario");
		const evidence = [
			{
				file: "src/run.ts",
				startLine: 12,
				role: "context" as const,
				revision: "head" as const,
				snippet: "eval(input)",
			},
		];
		const listed = createFinding({ ...evalInput, evidence });
		expect(upgradeStoredFinding(listed)).toBe(listed);
	});
});
