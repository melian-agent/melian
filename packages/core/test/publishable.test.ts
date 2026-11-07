import {
	Adjudication,
	defaultConfig,
	Finding,
	type StoredCheckRecord,
	type StoredFinding,
	Verdict,
	withheldToolText,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const token = "ghpFAKEoutsideTOKEN281";
const said = withheldToolText("static.tsc", "tsc/TS2322");
const verification = {
	verdict: "plausible" as const,
	reason: token,
	correction: token,
	lowered: { from: "P1" as const, to: "P2" as const, reason: token },
	executor: "llm" as const,
	model: "faux/judge",
	version: "1",
};
const source = { check: "static.tsc", version: "7.0.2" };

// A tsc finding that holds a token in every field a caller, a verifier or an older build could have written.
function stored(check = source): StoredFinding {
	return {
		ruleId: "tsc/TS2322",
		level: "error",
		message: { text: token },
		partialFingerprints: { "melian/v1": "0123456789abcdef" },
		locations: [
			{
				physicalLocation: {
					artifactLocation: { uri: "src/a.ts" },
					region: { startLine: 2, startColumn: 3, endLine: 4, endColumn: 5, snippet: { text: token } },
				},
			},
		],
		properties: {
			id: "0123456789abcdef",
			path: "src/a.ts",
			occurrence: 0,
			discriminator: token,
			cause: "introduced",
			failureScenario: token,
			evidence: [{ file: "src/a.ts", startLine: 2, endLine: 2, role: "cause", revision: "head", snippet: token }],
			trigger: { file: "src/a.ts", index: 0, snippet: token },
			severity: "P2",
			originalSeverity: "P1",
			confidence: 0.5,
			verification,
			resolution: "block",
			decidedBy: {
				check: "static.tsc",
				rule: token,
				file: token,
				requirement: { entry: "table", key: "resolution.P2" },
				trustFloor: [
					{
						id: "0123456789abcdef",
						source,
						ruleId: "tsc/TS2322",
						path: "src/a.ts",
						severity: "P2",
						action: "lowered",
						minimum: "block",
						verification,
					},
				],
				floor: "lowered-trust",
			},
			status: "new",
			dismissal: { by: "Maintainer", reason: "Checked", at: "2026-11-07T00:00:00Z" },
			pastDismissals: [{ by: "Maintainer", reason: "Earlier", at: "2026-11-06T00:00:00Z" }],
			explanation: { what: token, whyHere: token, whatToDo: token },
			source: check,
			reportedBy: [check],
			alsoReportedAs: [{ id: "fedcba9876543210", ruleId: "tsc/TS2322", check: "static.tsc" }],
			otherClaims: [{ id: "fedcba9876543210", ruleId: "lens/x", source, failureScenario: token, verification }],
		},
	} as StoredFinding;
}

const kept = (
	check = source,
	whyHere = "tsc reports this at head but not at the base, so this change introduced it.",
) => ({
	ruleId: "tsc/TS2322",
	level: "error",
	message: { text: said },
	partialFingerprints: { "melian/v1": "0123456789abcdef" },
	locations: [
		{
			physicalLocation: {
				artifactLocation: { uri: "src/a.ts" },
				region: { startLine: 2, startColumn: 3, endLine: 4, endColumn: 5 },
			},
		},
	],
	properties: {
		id: "0123456789abcdef",
		path: "src/a.ts",
		occurrence: 0,
		cause: "introduced",
		severity: "P2",
		originalSeverity: "P1",
		resolution: "block",
		decidedBy: { check: "static.tsc", requirement: { entry: "table", key: "resolution.P2" } },
		status: "new",
		dismissal: { by: "Maintainer", reason: "Checked", at: "2026-11-07T00:00:00Z" },
		pastDismissals: [{ by: "Maintainer", reason: "Earlier", at: "2026-11-06T00:00:00Z" }],
		explanation: { what: said, whyHere, whatToDo: "Change the code so tsc no longer reports tsc/TS2322." },
		source: check,
		reportedBy: [check],
		alsoReportedAs: [{ id: "fedcba9876543210", ruleId: "tsc/TS2322", check: "static.tsc" }],
		otherClaims: [{ id: "fedcba9876543210", ruleId: "lens/x", source }],
	},
});

describe("Finding.publishable", () => {
	it("keeps only a tsc finding's rule, place, severity, resolution and identity, with Melian's sentence", () => {
		expect(Finding.from(stored()).publishable().toJSON()).toEqual(kept());
	});

	it("words a pre-existing result as one the base has too", () => {
		const before = stored();
		before.properties.cause = "pre-existing";
		const expected = kept(source, "tsc reports this at the base too, so it predates this change.");
		expected.properties.cause = "pre-existing";
		expect(Finding.from(before).publishable().toJSON()).toEqual(expected);
	});

	it("writes Biome's own sentence for a Biome finding", () => {
		const biome = { check: "static.biome", version: "2.5.15" };
		const sentence = withheldToolText("static.biome", "tsc/TS2322");
		const result = Finding.from(stored(biome)).publishable().toJSON();
		expect(result.message.text).toBe(sentence);
		expect(result.properties.explanation).toEqual({
			what: sentence,
			whyHere: "biome reports this at head but not at the base, so this change introduced it.",
			whatToDo: "Change the code so biome no longer reports tsc/TS2322.",
		});
	});

	it("adds no optional field the finding lacks", () => {
		const bare = stored();
		bare.locations[0]!.physicalLocation.region = { startLine: 2 };
		const {
			occurrence: _o,
			originalSeverity: _s,
			resolution: _r,
			decidedBy: _d,
			dismissal: _m,
			pastDismissals: _p,
			reportedBy: _b,
			alsoReportedAs: _a,
			otherClaims: _c,
			...properties
		} = bare.properties;
		bare.properties = properties as StoredFinding["properties"];
		const {
			occurrence: _ko,
			originalSeverity: _ks,
			resolution: _kr,
			decidedBy: _kd,
			dismissal: _km,
			pastDismissals: _kp,
			reportedBy: _kb,
			alsoReportedAs: _ka,
			otherClaims: _kc,
			...rest
		} = kept().properties;
		expect(Finding.from(bare).publishable().toJSON()).toStrictEqual({
			...kept(),
			locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 2 } } }],
			properties: rest,
		});
	});

	it("returns any other check's finding as it is", () => {
		const lens = Finding.create(evalInput);
		expect(lens.publishable()).toBe(lens);
		const enola = Finding.from(stored({ check: "static.enola", version: "1" }));
		expect(enola.publishable()).toBe(enola);
	});
});

describe("Verdict.publishable", () => {
	it("makes every finding publishable and gives each Biome or tsc check that did not run a fixed reason", () => {
		const failed: StoredCheckRecord = {
			name: "static.tsc",
			status: "failed",
			reason: token,
			error: token,
			version: "7",
		};
		const skipped: StoredCheckRecord = { name: "static.biome", status: "skipped", reason: token };
		const ran: StoredCheckRecord = { name: "static.biome", status: "ran", reason: token, version: "2" };
		const other: StoredCheckRecord = {
			name: "static.mutation",
			status: "failed",
			reason: "toolFailed",
			error: "tail",
		};
		const verdict = new Adjudication({
			findings: [],
			manifest: ["static.tsc", "static.biome", "static.mutation"],
			checks: [failed, skipped, other],
			config: defaultConfig,
		})
			.adjudicate()
			.toJSON();
		const withFindings = Verdict.from({
			...verdict,
			findings: { ...verdict.findings, block: [stored()] },
			dismissed: [stored()],
			refuted: [stored()],
			ran: [ran],
		});
		const publishable = withFindings.publishable().toJSON();
		expect(publishable.findings.block).toEqual([kept()]);
		expect(publishable.dismissed).toEqual([kept()]);
		expect(publishable.refuted).toEqual([kept()]);
		expect(publishable.notRun).toStrictEqual([
			{
				name: "static.tsc",
				status: "failed",
				version: "7",
				reason: "the tool failed; Melian keeps none of its text",
			},
			{ name: "static.biome", status: "skipped", reason: "the tool did not run; Melian keeps none of its reason" },
			other,
		]);
		expect(publishable.ran).toEqual([{ name: "static.biome", status: "ran", version: "2" }]);
		expect(JSON.stringify(publishable)).not.toContain(token);
	});

	it("leaves out the lists a verdict does not hold", () => {
		const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate();
		const { ran: _, refuted: __, ...legacy } = verdict.toJSON();
		const publishable = Verdict.from(legacy).publishable().toJSON();
		expect(publishable).not.toHaveProperty("ran");
		expect(publishable).not.toHaveProperty("refuted");
	});
});
