import {
	defaultConfig,
	type FileResolution,
	Finding,
	type FindingInput,
	type ResolutionSource,
	type Verification,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const finding = (input: Partial<FindingInput> = {}) =>
	Finding.create({ ...evalInput, trigger: undefined, resolution: undefined, ...input });
const layered = (layers: Record<string, FileResolution>, rest: Partial<ResolutionSource> = {}): ResolutionSource => ({
	resolution: defaultConfig.resolution,
	layers: Object.entries(layers).map(([file, resolution]) => ({ file, resolution })),
	...rest,
});
const verification: Verification = {
	verdict: "confirmed",
	reason: "Traced the code.",
	executor: "llm",
	model: "faux/judge",
	version: "1",
};
const guardrail = (input: Partial<FindingInput>) =>
	finding({ rule: "guardrail/forbidden-patterns", severity: "P2", source: { check: "guardrails" }, ...input });
const cause = { file: "src/api.ts", startLine: 3, role: "cause", revision: "head", snippet: "load(userId)" } as const;

describe("Finding.decision", () => {
	it("resolves under its check and rule, and names the file and entry that decided", () => {
		const source = layered({
			"services/melian.yaml": {
				checks: { "lens.security": { rules: { "no-eval": { P1: "acknowledge" } } } },
			},
			"melian.yaml": { P1: "block" },
		});
		expect(finding().decision(source)).toEqual({
			resolution: "acknowledge",
			decidedBy: {
				file: "services/melian.yaml",
				check: "lens.security",
				rule: "no-eval",
				requirement: { entry: "rule", key: "resolution.checks.lens.security.rules.no-eval.P1" },
			},
		});
		expect(finding({ rule: "sql-injection" }).decision(source).decidedBy).toEqual({
			file: "melian.yaml",
			check: "lens.security",
			rule: "sql-injection",
			requirement: { entry: "table", key: "resolution.P1" },
		});
	});

	it("names a lens's default and its ceiling when no file speaks", () => {
		const source = layered({}, { lensDefaults: { security: { ceiling: "advisory" } } });
		expect(finding().decision(source)).toEqual({
			resolution: "advisory",
			decidedBy: {
				lens: "security",
				check: "lens.security",
				rule: "no-eval",
				requirement: { entry: "built-in" },
				ceiling: { entry: "lens-default", key: "resolution.ceiling" },
			},
		});
	});

	it("resolves a lens report under the default of the version its source names", () => {
		const source = layered(
			{},
			{
				lensDefaults: { security: { ceiling: "silent" } },
				lensVariants: { "security@1": { ceiling: "acknowledge" } },
			},
		);
		expect(finding().resolve(source)).toBe("acknowledge");
		expect(finding({ source: { check: "lens.security", version: "2" } }).resolve(source)).toBe("silent");
		expect(finding({ source: { check: "lens.security" } }).resolve(source)).toBe("silent");
	});

	it("resolves a finding two checks reported under each, and keeps the strictest", () => {
		const twice = Finding.from({
			...finding().toJSON(),
			properties: {
				...finding().properties,
				reportedBy: [
					{ check: "lens.security", version: "1" },
					{ check: "lens.security", version: "2" },
					{ check: "lens.correctness", version: "1" },
				],
			},
		});
		expect(twice.decision(defaultConfig).decidedBy.check).toBe("lens.security");
		const lenient = layered({ "melian.yaml": { checks: { "lens.security": { ceiling: "advisory" } } } });
		expect(twice.decision(lenient)).toMatchObject({ resolution: "block", decidedBy: { check: "lens.correctness" } });
		const both = layered({
			"melian.yaml": {
				checks: { "lens.security": { ceiling: "advisory" }, "lens.correctness": { ceiling: "silent" } },
			},
		});
		expect(twice.decision(both)).toMatchObject({ resolution: "advisory", decidedBy: { check: "lens.security" } });
	});

	// The stated limit: sightings of one ID are merged before adjudication, at the highest severity. Step 21 of the plan,
	// "Resolution per sighting", would resolve each at its own.
	it("resolves one ID two lenses sighted at the highest severity, under the strictest of their policies", () => {
		// lens.security sighted a P1 and lens.tests a P3; the findings document hands adjudication one P1 finding.
		const merged = Finding.from({
			...finding({ severity: "P1" }).toJSON(),
			properties: {
				...finding({ severity: "P1" }).properties,
				reportedBy: [
					{ check: "lens.security", version: "1" },
					{ check: "lens.tests", version: "1" },
				],
			},
		});
		const opposite = layered({
			"melian.yaml": {
				checks: { "lens.security": { P1: "silent", P3: "silent" }, "lens.tests": { P1: "block", P3: "silent" } },
			},
		});
		// Each alone would be silent: security's P1, and tests' P3. Together the P1 meets the tests entry's P1.
		expect(merged.decision(opposite)).toMatchObject({ resolution: "block", decidedBy: { check: "lens.tests" } });
		const reversed = layered({
			"melian.yaml": {
				checks: { "lens.security": { P1: "block", P3: "silent" }, "lens.tests": { P1: "silent", P3: "silent" } },
			},
		});
		expect(merged.decision(reversed)).toMatchObject({ resolution: "block", decidedBy: { check: "lens.security" } });
	});

	it("sets the resolution and what decided it on a resolved copy, replacing any it carries", () => {
		const resolved = finding({ resolution: "silent" }).resolved(defaultConfig);
		expect(resolved.properties.resolution).toBe("block");
		expect(resolved.properties.decidedBy).toEqual({
			check: "lens.security",
			rule: "no-eval",
			requirement: { entry: "table", key: "resolution.P1" },
		});
		expect(Finding.parse(resolved.toJSON())).toEqual(resolved);
	});
});

describe("the caps", () => {
	it("caps a pre-existing finding at its severity's preExisting cap, advisory unless a folder opted in", () => {
		const strict = { ...defaultConfig.resolution, P0: "block", P1: "block" } as const;
		const capped = { resolution: { ...strict, preExisting: { P0: "acknowledge" } } } as const;
		expect(finding({ severity: "P0", cause: "pre-existing" }).decision(capped)).toMatchObject({
			resolution: "acknowledge",
			decidedBy: { requirement: { entry: "table", key: "resolution.P0" }, cap: "pre-existing" },
		});
		expect(finding({ severity: "P1", cause: "pre-existing" }).decision(capped)).toMatchObject({
			resolution: "advisory",
			decidedBy: { cap: "pre-existing" },
		});
		// One configuration for every path names no file, so the cap names none either.
		expect(finding({ severity: "P0", cause: "pre-existing" }).decision(capped).decidedBy.capBy).toBeUndefined();
		expect(finding({ severity: "P0", cause: "pre-existing" }).resolve({ resolution: strict })).toBe("advisory");
		expect(finding({ severity: "P0" }).decision(capped)).toEqual({
			resolution: "block",
			decidedBy: finding({ severity: "P0" }).decision({ resolution: strict }).decidedBy,
		});
	});

	it("never raises a pre-existing finding to its cap", () => {
		const advisory = {
			resolution: { ...defaultConfig.resolution, P0: "advisory", preExisting: { P0: "acknowledge" } },
		};
		const decided = finding({ severity: "P0", cause: "pre-existing" }).decision(advisory as ResolutionSource);
		expect(decided.resolution).toBe("advisory");
		expect(decided.decidedBy.cap).toBeUndefined();
	});

	it("reads the cap from the merged table, whichever file speaks about the finding", () => {
		const source = layered(
			{ "services/melian.yaml": { P0: "block" }, "melian.yaml": { preExisting: { P0: "acknowledge" } } },
			{ resolution: { ...defaultConfig.resolution, preExisting: { P0: "acknowledge" } } },
		);
		expect(finding({ severity: "P0", cause: "pre-existing" }).decision(source)).toMatchObject({
			resolution: "acknowledge",
			decidedBy: {
				file: "services/melian.yaml",
				cap: "pre-existing",
				capBy: { file: "melian.yaml", key: "resolution.preExisting.P0" },
			},
		});
		// A severity no file caps takes the default, which no file set.
		const uncapped = layered({
			"services/melian.yaml": { P1: "block" },
			"melian.yaml": { preExisting: { P0: "acknowledge" } },
		});
		const p1 = finding({ severity: "P1", cause: "pre-existing" }).decision(uncapped);
		expect(p1).toMatchObject({ resolution: "advisory", decidedBy: { cap: "pre-existing" } });
		expect(p1.decidedBy.capBy).toBeUndefined();
	});

	it("reads the cap at the severity the mapping was read at, the lens's when a lowering would fall silent", () => {
		const lowered = finding({
			severity: "P1",
			cause: "pre-existing",
			failureScenario: "run('1') evaluates input.",
		}).verifiedAs({
			...verification,
			lowered: { from: "P1", to: "P2", reason: "One caller validates." },
		});
		expect(lowered.properties).toMatchObject({ severity: "P2", originalSeverity: "P1" });
		const source = layered({ "melian.yaml": { P1: "block", P2: "silent", preExisting: { P1: "acknowledge" } } });
		// P2 is silent, so the finding resolves at P1, and the cap is P1's too: acknowledge, where P2's would be advisory.
		expect(lowered.decision(source)).toMatchObject({
			resolution: "acknowledge",
			decidedBy: { requirement: { key: "resolution.P1" }, capBy: { key: "resolution.preExisting.P1" } },
		});
		// A floor that then raises the result keeps the note that the lens's severity was read.
		const hushed = layered({ "melian.yaml": { P1: "silent", P2: "silent" } });
		expect(lowered.decision(hushed)).toMatchObject({
			resolution: "advisory",
			decidedBy: { floor: "pre-existing-important" },
			resolvedAtOriginal: true,
		});
		const audible = layered({ "melian.yaml": { P1: "block", P2: "block", preExisting: { P1: "acknowledge" } } });
		expect(lowered.decision(audible)).toMatchObject({ resolution: "advisory", decidedBy: { cap: "pre-existing" } });
	});

	it("names only the cap that decided when a later cap lowers further", () => {
		const source = layered({ "melian.yaml": { preExisting: { P0: "acknowledge" } } });
		const old = finding({ severity: "P0", cause: "pre-existing" });
		expect(old.capped(source).decidedBy).toMatchObject({ cap: "pre-existing", capBy: { file: "melian.yaml" } });
		const unjudged = old.capped(source, { unverified: true });
		expect(unjudged).toMatchObject({ resolution: "advisory", decidedBy: { cap: "unverified" } });
		expect(unjudged.decidedBy.capBy).toBeUndefined();
	});

	it("takes the nearest file's cap for a severity, in either direction", () => {
		const old = finding({ severity: "P0", cause: "pre-existing" });
		const stricterRoot = layered({
			"services/melian.yaml": { P0: "block", preExisting: { P0: "advisory" } },
			"melian.yaml": { preExisting: { P0: "acknowledge" } },
		});
		expect(old.decision(stricterRoot)).toMatchObject({
			resolution: "advisory",
			decidedBy: { capBy: { file: "services/melian.yaml", key: "resolution.preExisting.P0" } },
		});
		const stricterNear = layered({
			"services/melian.yaml": { P0: "block", preExisting: { P0: "acknowledge" } },
			"melian.yaml": { preExisting: { P0: "advisory" } },
		});
		expect(old.decision(stricterNear)).toMatchObject({
			resolution: "acknowledge",
			decidedBy: { capBy: { file: "services/melian.yaml", key: "resolution.preExisting.P0" } },
		});
	});

	it("caps an affected finding at advisory only when no cause location proves it", () => {
		const proven = finding({ cause: "affected", evidence: [{ ...cause, proves: true }] });
		expect(proven.decision(defaultConfig).resolution).toBe("block");
		const unproven = finding({ cause: "affected", evidence: [{ ...cause, proves: true }, cause] });
		const marked = Finding.from({
			...unproven.toJSON(),
			properties: { ...unproven.properties, evidence: [{ ...cause, role: "context", proves: true }, cause] },
		});
		expect(marked.decision(defaultConfig)).toMatchObject({
			resolution: "advisory",
			decidedBy: { cap: "unproven-cause" },
		});
	});

	it("caps a lens finding no verifier judged at advisory, only when asked and only a lens's", () => {
		expect(finding().capped(defaultConfig, { unverified: true })).toMatchObject({
			resolution: "advisory",
			decidedBy: { cap: "unverified" },
		});
		expect(finding().capped(defaultConfig).resolution).toBe("block");
		const judged = finding({ failureScenario: "run('1') evaluates input.", verification });
		expect(judged.capped(defaultConfig, { unverified: true }).resolution).toBe("block");
		const unjudged = finding({ failureScenario: "run('1') evaluates input." });
		expect(unjudged.capped(defaultConfig, { unverified: true }).resolution).toBe("advisory");
		const tool = finding({ source: { check: "static.biome" } });
		expect(tool.capped(defaultConfig, { unverified: true }).resolution).toBe("block");
	});

	it("applies the floors after the caps", () => {
		const quiet = { resolution: { ...defaultConfig.resolution, P0: "block" } } as const;
		const injection = finding({ rule: "melian/injection-attempt", severity: "P0", cause: "pre-existing" });
		expect(injection.capped(quiet).resolution).toBe("advisory");
		expect(injection.decision(quiet)).toMatchObject({
			resolution: "acknowledge",
			decidedBy: { cap: "pre-existing", floor: "injection-attempt" },
		});
	});
});

describe("the floors", () => {
	const quiet = { resolution: { ...defaultConfig.resolution, P1: "silent", P2: "silent" } } as const;
	const notice = { rule: "guardrail/policy-change-review", severity: "P2", source: { check: "guardrails" } } as const;

	it("holds a policy-change notice on a melian.yaml at acknowledge, and marks the floor", () => {
		expect(finding({ ...notice, file: "docs/melian.yaml" }).decision(quiet)).toMatchObject({
			resolution: "acknowledge",
			decidedBy: { floor: "policy-change" },
		});
		expect(finding({ ...notice, file: "AGENTS.md" }).resolve(quiet)).toBe("silent");
		expect(finding({ ...notice, file: "melian.yaml" }).decision(defaultConfig).decidedBy.floor).toBeUndefined();
	});

	it("holds a notice of a changed lens resolution at acknowledge, and no other notice on a LENS.md", () => {
		const file = ".melian/lenses/cleanup/LENS.md";
		const changed = finding({ ...notice, file, guardrail: { notice: "policy", resolution: true } });
		expect(changed.resolve(quiet)).toBe("acknowledge");
		expect(finding({ ...notice, file, guardrail: { notice: "policy" } }).resolve(quiet)).toBe("silent");
		expect(finding({ ...notice, file }).resolve(quiet)).toBe("silent");
		const other = finding({
			file,
			severity: "P2",
			source: { check: "guardrails" },
			guardrail: { notice: "policy", resolution: true },
		});
		expect(other.resolve(quiet)).toBe("silent");
	});

	it("holds an injection attempt at acknowledge, whatever a mapping, a ceiling, or a lens's default says", () => {
		const injection = finding({ rule: "melian/injection-attempt", severity: "P1" });
		expect(injection.resolve(quiet)).toBe("acknowledge");
		const ceiling = layered({ "melian.yaml": { checks: { "lens.security": { ceiling: "advisory" } } } });
		expect(injection.resolve(ceiling)).toBe("acknowledge");
		const declared = layered({}, { lensDefaults: { security: { ceiling: "silent" } } });
		expect(injection.decision(declared)).toMatchObject({
			resolution: "acknowledge",
			decidedBy: { lens: "security", floor: "injection-attempt" },
		});
		expect(injection.decision(defaultConfig)).toMatchObject({ resolution: "block" });
		expect(injection.decision(defaultConfig).decidedBy.floor).toBeUndefined();
	});

	it("holds a defect one of whose reports is an injection attempt, whichever speaks", () => {
		const speaker = finding({ severity: "P1" });
		const capped = speaker.capped(quiet);
		expect(speaker.floored(capped).resolution).toBe("silent");
		expect(speaker.floored(capped, ["no-eval", "melian/injection-attempt"]).resolution).toBe("acknowledge");
	});

	it("holds a member of Pre-existing, important at advisory, and marks the floor", () => {
		const silent = { resolution: { ...defaultConfig.resolution, P0: "silent" } } as const;
		const member = finding({ severity: "P0", cause: "pre-existing" });
		expect(member.decision(silent)).toMatchObject({
			resolution: "advisory",
			decidedBy: { floor: "pre-existing-important" },
		});
		expect(member.decision(defaultConfig).decidedBy.floor).toBeUndefined();
		expect(finding({ severity: "P0" }).resolve(silent)).toBe("silent");
		expect(finding({ severity: "P2", cause: "pre-existing" }).resolve(quiet)).toBe("silent");
	});
});

describe("a guardrail finding's keys", () => {
	const rules = (entries: Record<string, { P2?: "block" | "advisory" | "silent"; ceiling?: "advisory" }>) =>
		layered({ "melian.yaml": { checks: { guardrails: { rules: entries } } } });

	it("resolves under each configured rule it matched and keeps the strictest", () => {
		const matched = guardrail({ guardrail: { rules: ["console-log", "focused-test"] } });
		const source = rules({
			"guardrail/forbidden-patterns/console-log": { P2: "silent" },
			"guardrail/forbidden-patterns/focused-test": { P2: "block" },
		});
		expect(matched.decision(source)).toEqual({
			resolution: "block",
			decidedBy: {
				file: "melian.yaml",
				check: "guardrails",
				rule: "guardrail/forbidden-patterns/focused-test",
				requirement: {
					entry: "rule",
					key: "resolution.checks.guardrails.rules.guardrail/forbidden-patterns/focused-test.P2",
				},
			},
		});
		expect(guardrail({ guardrail: { rules: ["console-log"] } }).resolve(source)).toBe("silent");
	});

	it("resolves a finding with no matched rules under its whole guardrail", () => {
		const whole = rules({
			"guardrail/forbidden-patterns": { P2: "advisory" },
			"guardrail/forbidden-patterns/focused-test": { P2: "block" },
		});
		expect(guardrail({}).decision(whole)).toMatchObject({
			resolution: "advisory",
			decidedBy: { rule: "guardrail/forbidden-patterns", requirement: { entry: "check" } },
		});
		expect(guardrail({ guardrail: { rules: ["dynamic-import"] } }).resolve(whole)).toBe("advisory");
	});

	it("keys the two classes of policy-change notice apart", () => {
		const source = rules({
			"guardrail/policy-change-review/analyser": { P2: "block" },
			"guardrail/policy-change-review/policy": { P2: "advisory" },
		});
		const notice = { rule: "guardrail/policy-change-review", file: "AGENTS.md" } as const;
		expect(guardrail({ ...notice, guardrail: { notice: "analyser" } }).resolve(source)).toBe("block");
		expect(guardrail({ ...notice, guardrail: { notice: "policy" } }).resolve(source)).toBe("advisory");
	});

	it("lets no entry under guardrails move a notice of a changed resolution", () => {
		const source = layered({
			"melian.yaml": {
				P2: "block",
				checks: {
					guardrails: {
						ceiling: "advisory",
						rules: { "guardrail/policy-change-review/policy": { P2: "advisory" } },
					},
				},
			},
		});
		const notice = { rule: "guardrail/policy-change-review", file: "services/melian.yaml" } as const;
		expect(guardrail({ ...notice, guardrail: { notice: "policy", resolution: true } }).decision(source)).toEqual({
			resolution: "block",
			decidedBy: { file: "melian.yaml", check: "guardrails", requirement: { entry: "table", key: "resolution.P2" } },
		});
		expect(guardrail({ ...notice, guardrail: { notice: "policy" } }).decision(source)).toMatchObject({
			resolution: "acknowledge",
			decidedBy: { floor: "policy-change" },
		});
	});

	it("keeps what a guardrail finding matched out of its ID", () => {
		expect(guardrail({ guardrail: { rules: ["focused-test"] } }).id).toBe(guardrail({}).id);
		expect(() => guardrail({ guardrail: { rules: [] } })).toThrow(/properties\/guardrail/);
	});
});

describe("Finding.silentAt", () => {
	it("lists the severities a check that reported it resolves silent, before any cap or floor", () => {
		const source = layered({
			"melian.yaml": {
				P3: "silent",
				checks: { "lens.security": { P2: "silent", rules: { "no-eval": { P3: "advisory" } } } },
			},
		});
		expect(finding().silentAt(source)).toEqual(["P2", "nit"]);
		expect(finding({ rule: "sql-injection" }).silentAt(source)).toEqual(["P2", "P3", "nit"]);
		expect(finding({ cause: "pre-existing", severity: "P0" }).silentAt(source)).toEqual(["P2", "nit"]);
		const twice = Finding.from({
			...finding().toJSON(),
			properties: { ...finding().properties, reportedBy: [{ check: "lens.security" }, { check: "lens.tests" }] },
		});
		// lens.tests has no entry, so the table makes P3 silent for it, and the security entry makes P2 silent.
		expect(twice.silentAt(source)).toEqual(["P2", "P3", "nit"]);
	});
});

describe("Finding.unjudged and Finding.refuted", () => {
	it("says whether a verifier judged, or refuted, every claim of a lens finding", () => {
		const scenario = { failureScenario: "run('1') evaluates input." };
		expect(finding().unjudged()).toBe(true);
		expect(finding().refuted()).toBe(false);
		expect(finding({ ...scenario, verification }).unjudged()).toBe(false);
		expect(finding({ ...scenario, verification }).refuted()).toBe(false);
		expect(finding({ ...scenario, verification: { ...verification, verdict: "refuted" } }).refuted()).toBe(true);
		const tool = finding({ ...scenario, source: { check: "static.tsc" } });
		expect(tool.unjudged()).toBe(false);
		expect(tool.refuted()).toBe(false);
	});
});
