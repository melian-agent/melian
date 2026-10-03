import { readFileSync } from "node:fs";
import {
	createFinding,
	createFindingsLog,
	type Finding,
	FindingError,
	findingId,
	findingsLogSchema,
	levelForSeverity,
	parseFinding,
} from "@melian-agent/core";
import Schema from "typebox/schema";
import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { evalInput, minimalInput } from "./fixtures/findings.ts";

// The OASIS SARIF 2.1.0 schema as published in microsoft/sarif-sdk (MIT): src/Sarif/Schemata/sarif-2.1.0.json.
const sarifSchema = JSON.parse(
	readFileSync(new URL("./fixtures/sarif-schema-2.1.0.json", import.meta.url), "utf8"),
) as Schema.XSchema;

const evalCall = { file: "src/run.ts", rule: "no-eval", snippet: "eval(input)" };

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
	it("hashes the file, rule, and normalised snippet", () => {
		expect(findingId(evalCall)).toBe("8dd0822422207e29");
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
		expect(findingId({ file: "a", rule: "bc", snippet: "d" })).not.toBe(
			findingId({ file: "ab", rule: "c", snippet: "d" }),
		);
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
			["cause", "explanation", "id", "resolution", "severity", "source", "status"].sort(),
		);
		expect(finding.properties.id).toBe(findingId({ file: "src/total.ts", rule: "prefer-const", snippet: "" }));
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

	it("is not valid SARIF once an extension moves out of the property bag", () => {
		const finding = createFinding(evalInput);
		const moved = { ...finding, severity: finding.properties.severity };
		expect(Schema.Check(sarifSchema, createFindingsLog([moved as Finding]))).toBe(false);
	});
});

describe("parseFinding", () => {
	const finding = createFinding(evalInput);

	it("rejects an unknown key in the property bag, so a misspelt optional key is not lost", () => {
		const error = rejection({ ...finding, properties: { ...finding.properties, confidance: 0.5 } });
		expect(error.code).toBe("invalidFinding");
		expect(error.path).toBe("/properties/confidance");
		expect(error.message).toBe("finding has an unknown key at /properties/confidance");
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
