import { readFileSync } from "node:fs";
import {
	createFinding,
	createFindingsLog,
	type Finding,
	FindingError,
	findingId,
	findingsLogSchema,
	levelForSeverity,
	normaliseSnippet,
	parseFinding,
	snippetOccurrence,
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
				trigger: { file: "src/run.ts", oldStart: 11, oldLines: 1, newStart: 12, newLines: 1 },
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

	it("makes a finding affected only through evidence", () => {
		const evidence = "src/api.ts:3 renames the id parameter to userId, which this call still passes positionally.";
		const affected = createFinding({ ...evalInput, cause: { evidence } });
		expect(affected.properties.cause).toBe("affected");
		expect(affected.properties.evidence).toBe(evidence);
		expect(createFinding(evalInput).properties).not.toHaveProperty("evidence");
		expect(() => createFinding({ ...evalInput, cause: { evidence: "" } })).toThrow(FindingError);
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
		expect(parsed.runs[0]!.results.map(parseFinding)).toEqual(log.runs[0]!.results);
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

	it("rejects an affected finding without evidence, and evidence on any other", () => {
		const affected = createFinding({ ...evalInput, cause: { evidence: "src/api.ts:3 renames id." } });
		const { evidence: _, ...bare } = affected.properties;
		expect(rejection({ ...affected, properties: bare }).code).toBe("missingEvidence");
		const stray = rejection({ ...finding, properties: { ...finding.properties, evidence: "src/api.ts:3" } });
		expect(stray.code).toBe("invalidFinding");
		expect(stray.path).toBe("/properties/evidence");
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

	it("rejects an ID that is not the finding's stable ID", () => {
		const error = rejection({ ...finding, ruleId: "no-implied-eval" });
		expect(error.code).toBe("idMismatch");
		expect(error.path).toBe("/properties/id");
	});
});
