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
			decidedBy: { file: "services/melian.yaml", cap: "pre-existing" },
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
