import {
	Adjudication,
	type ConfigFor,
	defaultConfig,
	type FileResolution,
	Finding,
	type FindingInput,
	type PolicyAt,
	type Verification,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const scenario = "run('1') evaluates the request body.";
const report = (input: Partial<FindingInput>) =>
	Finding.create({ ...evalInput, trigger: undefined, resolution: undefined, failureScenario: scenario, ...input });
const confirmed: Verification = {
	verdict: "confirmed",
	reason: "Traced the code.",
	executor: "llm",
	model: "faux/judge",
	version: "1",
};
const refuted: Verification = { ...confirmed, verdict: "refuted" };
// Two checks on one snippet at one occurrence report one defect.
const cleanup = (input: Partial<FindingInput> = {}) =>
	report({ rule: "reuse", source: { check: "lens.cleanup", version: "1" }, verification: confirmed, ...input });
const biome = (input: Partial<FindingInput> = {}) =>
	report({
		rule: "biome/security/noGlobalEval",
		source: { check: "static.biome" },
		failureScenario: undefined,
		...input,
	});

const policy = (resolution: FileResolution, rest: Partial<PolicyAt> = {}): PolicyAt => ({
	resolution: defaultConfig.resolution,
	ruleAliases: {},
	layers: [{ file: "melian.yaml", resolution }],
	...rest,
});
const decide = (findings: Finding[], config: PolicyAt | ConfigFor, verificationRan = true) =>
	new Adjudication({ findings, manifest: [], checks: [], config, verificationRan }).adjudicate();
const only = (findings: Finding[], config: PolicyAt | ConfigFor, verificationRan = true) => {
	const all = decide(findings, config, verificationRan).all();
	expect(all).toHaveLength(1);
	return all[0]!;
};

describe("a merged defect resolves each report under its own check, rule, and severity", () => {
	const opposite = {
		P1: "block",
		checks: { "lens.cleanup": { ceiling: "advisory" }, "static.biome": { P1: "acknowledge" } },
	} as const;

	it("takes the strictest result among its reports, in either input order", () => {
		for (const findings of [
			[cleanup(), biome()],
			[biome(), cleanup()],
		]) {
			const defect = only(findings, policy(opposite));
			expect(defect.properties.alsoReportedAs).toHaveLength(1);
			expect(defect.properties.resolution).toBe("acknowledge");
			expect(defect.properties.decidedBy).toEqual({
				file: "melian.yaml",
				check: "static.biome",
				rule: "biome/security/noGlobalEval",
				requirement: { entry: "check", key: "resolution.checks.static.biome.P1" },
			});
		}
	});

	it("does not depend on which report speaks, whether severity or ruleAliases chose it", () => {
		const severe = only([cleanup({ severity: "P0" }), biome()], policy({ ...opposite, P0: "block" }));
		expect(severe.ruleId).toBe("reuse");
		expect(severe.properties.resolution).toBe("acknowledge");
		const aliases = { ruleAliases: { reuse: ["biome/security/noGlobalEval"] } };
		const owned = only([biome({ severity: "P0" }), cleanup({ severity: "P2" })], policy(opposite, aliases));
		expect(owned.ruleId).toBe("reuse");
		expect(owned.properties.severity).toBe("P0");
		// The Biome report is a P0, which the file leaves to the built-in table; the cleanup report is capped.
		expect(owned.properties.resolution).toBe("block");
		expect(owned.properties.decidedBy).toMatchObject({ check: "static.biome", requirement: { entry: "built-in" } });
		const other = { ruleAliases: { "biome/security/noGlobalEval": ["reuse"] } };
		const reversed = only([biome({ severity: "P0" }), cleanup({ severity: "P2" })], policy(opposite, other));
		expect(reversed.ruleId).toBe("biome/security/noGlobalEval");
		expect(reversed.properties.resolution).toBe("block");
	});

	it("keeps the speaker's decision when two reports resolve alike", () => {
		const alike = policy(
			{ P0: "acknowledge", P2: "acknowledge" },
			{ ruleAliases: { reuse: ["biome/security/noGlobalEval"] } },
		);
		const defect = only([biome({ severity: "P0" }), cleanup({ severity: "P2" })], alike);
		expect(defect.ruleId).toBe("reuse");
		expect(defect.properties.decidedBy?.check).toBe("lens.cleanup");
	});

	const proof = {
		file: "src/api.ts",
		startLine: 3,
		role: "cause",
		revision: "head",
		snippet: "load(userId)",
	} as const;

	it("never lowers what blocks: one report's severity and another's cause combine, in either order", () => {
		// A cause location another, marked location outranks proves nothing.
		const affected = cleanup({ severity: "P0", cause: "affected", evidence: [proof] });
		const unproven = Finding.from({
			...affected.toJSON(),
			properties: { ...affected.properties, evidence: [{ ...proof, role: "context", proves: true }, proof] },
		});
		const rows = [
			[cleanup({ severity: "P0", cause: "pre-existing" }), biome({ severity: "P3" }), "introduced"],
			[
				unproven,
				biome({ severity: "P3", cause: "affected", evidence: [{ ...proof, startLine: 9, proves: true }] }),
				"affected",
			],
		] as const;
		for (const [severe, proven, cause] of rows) {
			// Alone, the severe report is capped: nothing shows the change caused it.
			expect(only([severe], policy({})).properties.resolution).toBe("advisory");
			expect(only([proven], policy({})).properties.resolution).toBe("advisory");
			for (const findings of [
				[severe, proven],
				[proven, severe],
			]) {
				const defect = only(findings, policy({}));
				expect(defect.properties).toMatchObject({ severity: "P0", cause, resolution: "block" });
				expect(defect.properties.decidedBy).toMatchObject({
					check: "lens.cleanup",
					requirement: { entry: "built-in" },
				});
				expect(defect.properties.decidedBy?.cap).toBeUndefined();
			}
		}
	});

	it("marks a defect as resolved at the lens's severity only when the finding that speaks stands lowered", () => {
		const lowered = cleanup({ severity: "P1" }).verifiedAs({
			...confirmed,
			lowered: { from: "P1", to: "P2", reason: "One caller validates." },
		});
		// The cleanup entry silences P2, so the lowered report resolves at P1 and blocks.
		const quiet = policy({
			P1: "block",
			checks: { "lens.cleanup": { P2: "silent" }, "static.biome": { P1: "acknowledge" } },
		});
		const alone = only([lowered], quiet);
		expect(alone.properties).toMatchObject({ severity: "P2", resolution: "block", resolvedAtOriginal: true });
		// Beside an unlowered P1 the defect stands at P1, so nothing needs explaining.
		const defect = only([biome(), lowered], quiet);
		expect(defect.properties).toMatchObject({
			severity: "P1",
			resolution: "block",
			decidedBy: { check: "lens.cleanup" },
		});
		expect(defect.properties).not.toHaveProperty("resolvedAtOriginal");
		expect(only([cleanup()], quiet).properties).not.toHaveProperty("resolvedAtOriginal");
	});

	it("still caps a report under its own ceiling, whatever cause the defect merged", () => {
		const capped = policy({ checks: { "lens.cleanup": { ceiling: "advisory" } } });
		const defect = only([cleanup({ severity: "P0", cause: "pre-existing" }), biome({ severity: "P3" })], capped);
		expect(defect.properties).toMatchObject({ severity: "P0", cause: "introduced", resolution: "advisory" });
	});

	it("caps every report of a defect no report ties to the change", () => {
		const old = [
			cleanup({ severity: "P0", cause: "pre-existing" }),
			biome({ severity: "P1", cause: "pre-existing" }),
		];
		expect(only(old, policy({})).properties).toMatchObject({
			cause: "pre-existing",
			resolution: "advisory",
			decidedBy: { cap: "pre-existing" },
		});
	});

	it("caps the lens report no verifier judged, and never the static report beside it", () => {
		const unjudged = cleanup({ verification: undefined });
		expect(only([unjudged, biome()], policy({})).properties.resolution).toBe("block");
		expect(only([unjudged, biome()], policy({})).properties.decidedBy?.check).toBe("static.biome");
		const alone = only([unjudged], policy({}));
		expect(alone.properties).toMatchObject({ resolution: "advisory", decidedBy: { cap: "unverified" } });
		expect(only([unjudged], policy({}), false).properties.resolution).toBe("block");
		const other = report({
			rule: "no-eval",
			source: { check: "lens.security", version: "1" },
			verification: confirmed,
		});
		expect(only([unjudged, other], policy({})).properties.resolution).toBe("block");
	});

	it("leaves a refuted report out beside one that stands, and resolves a wholly refuted defect by all", () => {
		const wrong = cleanup({ verification: refuted });
		const right = report({
			rule: "no-eval",
			severity: "P3",
			source: { check: "lens.security", version: "1" },
			verification: confirmed,
		});
		const defect = only([wrong, right], policy({}));
		// The refuted P1 never sets the headline while the P3 stands.
		expect(defect.properties).toMatchObject({ severity: "P3", resolution: "advisory" });
		expect(defect.properties.decidedBy?.check).toBe("lens.security");
		const verdict = decide([wrong], policy({}));
		expect(verdict.refuted?.[0]?.properties.resolution).toBe("block");
	});

	it("applies the floors to the defect, whichever report speaks", () => {
		const injection = report({
			rule: "melian/injection-attempt",
			severity: "P2",
			source: { check: "lens.cleanup", version: "1" },
			verification: confirmed,
		});
		const quiet = policy({ P1: "silent", checks: { "lens.cleanup": { ceiling: "advisory" } } });
		const defect = only([biome(), injection], quiet);
		expect(defect.ruleId).toBe("biome/security/noGlobalEval");
		expect(defect.properties).toMatchObject({ resolution: "acknowledge", decidedBy: { floor: "injection-attempt" } });
		expect(only([biome()], quiet).properties.resolution).toBe("silent");
	});

	it("reads the important floor from the merged defect, never from a pre-existing report within it", () => {
		const silent = policy({ P0: "silent", P2: "silent" });
		const old = cleanup({ severity: "P0", cause: "pre-existing" });
		// Alone, the pre-existing P0 is a member, and the floor holds it at advisory.
		expect(only([old], silent).properties).toMatchObject({ resolution: "advisory", cause: "pre-existing" });
		// Beside an introduced report the defect is introduced, so it is no member and stays silent, in either order.
		for (const findings of [
			[old, biome({ severity: "P2" })],
			[biome({ severity: "P2" }), old],
		]) {
			const defect = only(findings, silent);
			expect(defect.properties).toMatchObject({ resolution: "silent", cause: "introduced" });
			expect(defect.properties.decidedBy?.floor).toBeUndefined();
		}
	});

	it("asks the policy for each report's own rule", () => {
		const asked: string[] = [];
		const configFor: ConfigFor = (path, rule) => {
			asked.push(`${path} ${rule}`);
			return policy(rule === "reuse" ? { P1: "silent" } : { P1: "acknowledge" });
		};
		expect(only([cleanup(), biome()], configFor).properties.resolution).toBe("acknowledge");
		expect(asked).toContain("src/run.ts reuse");
		expect(asked).toContain("src/run.ts biome/security/noGlobalEval");
	});

	it("applies a lens's declared default to its report alone", () => {
		const declared = {
			resolution: defaultConfig.resolution,
			ruleAliases: {},
			layers: [],
			lensDefaults: { cleanup: { ceiling: "silent" as const } },
		};
		expect(only([cleanup()], declared).properties).toMatchObject({
			resolution: "silent",
			decidedBy: { lens: "cleanup", ceiling: { entry: "lens-default", key: "resolution.ceiling" } },
		});
		expect(only([cleanup(), biome({ severity: "P3" })], declared).properties.resolution).toBe("advisory");
	});

	it("leaves a member the important floor holds at advisory out of the status, and counts one a stricter floor holds", () => {
		const silent = policy({ P0: "silent" });
		const old = cleanup({ severity: "P0", cause: "pre-existing" });
		const verdict = decide([old], silent);
		expect(verdict.status).toBe("passed");
		expect(verdict.findings.advisory[0]?.properties.decidedBy?.floor).toBe("pre-existing-important");
		const injected = cleanup({ rule: "melian/injection-attempt", severity: "P0", cause: "pre-existing" });
		expect(decide([injected], silent).status).toBe("findings");
	});
});

describe("Defect.silentAt", () => {
	it("lists a severity any report of the defect resolves silent, whichever speaks", () => {
		const quiet = policy({ checks: { "lens.cleanup": { P2: "silent" }, "static.biome": { P3: "silent" } } });
		for (const findings of [
			[cleanup(), biome()],
			[biome(), cleanup()],
		]) {
			const [defect] = new Adjudication({ findings, manifest: [], checks: [], config: quiet }).defects();
			expect(defect!.silentAt(() => quiet)).toEqual(["P2", "P3", "nit"]);
		}
		const [alone] = new Adjudication({ findings: [biome()], manifest: [], checks: [], config: quiet }).defects();
		expect(alone!.silentAt(() => quiet)).toEqual(["P3", "nit"]);
	});

	it("asks the policy for each report's own rule", () => {
		const asked: string[] = [];
		const [defect] = new Adjudication({
			findings: [cleanup(), biome()],
			manifest: [],
			checks: [],
			config: policy({}),
		}).defects();
		defect!.silentAt((path, rule) => {
			asked.push(`${path} ${rule}`);
			return policy({});
		});
		expect(asked.sort()).toEqual(["src/run.ts biome/security/noGlobalEval", "src/run.ts reuse"]);
	});
});

describe("Verdict.fingerprint", () => {
	it("leaves out which file and entry decided each finding", () => {
		const table = decide([biome()], policy({ P1: "acknowledge" }));
		const entry = decide([biome()], policy({ checks: { "static.biome": { P1: "acknowledge" } } }));
		expect(table.findings.acknowledge[0]!.properties.decidedBy).not.toEqual(
			entry.findings.acknowledge[0]!.properties.decidedBy,
		);
		expect(table.fingerprint()).toBe(entry.fingerprint());
		expect(decide([biome()], policy({ P1: "block" })).fingerprint()).not.toBe(table.fingerprint());
	});

	it("leaves out what a guardrail finding matched, which its message already says", () => {
		const notice = (matched?: FindingInput["guardrail"]) =>
			report({
				rule: "guardrail/forbidden-patterns",
				source: { check: "guardrails" },
				failureScenario: undefined,
				...(matched === undefined ? {} : { guardrail: matched }),
			});
		const before = decide([notice()], policy({}));
		const after = decide([notice({ rules: ["focused-test"] })], policy({}));
		expect(after.findings.block[0]!.properties.guardrail).toEqual({ rules: ["focused-test"] });
		expect(after.fingerprint()).toBe(before.fingerprint());
	});
});
