import {
	Adjudication,
	defaultConfig,
	Finding,
	Lowering,
	type LoweringFields,
	loweringSchema,
	Merge,
	Verdict,
	type Verification,
	VerificationRecord,
	VerificationState,
	verificationAnswersSchema,
	verificationSchema,
} from "@melian-agent/core";
import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const verification: Verification = {
	verdict: "confirmed",
	reason: "Traced the failure.",
	executor: "llm",
	model: "fake/model",
	version: "v1",
};
const finding = (check: string, verdict?: Verification) =>
	Finding.create({
		...evalInput,
		resolution: undefined,
		source: { check, version: "v1@careful" },
		failureScenario: "An empty input fails.",
		verification: verdict,
	});

describe("verification state and schema", () => {
	it("round trips verification without changing identity or confidence", () => {
		const plain = finding("lens.a");
		const verified = finding("lens.a", verification);
		expect(Finding.parse(verified.toJSON()).properties.verification).toEqual(verification);
		expect(verified.id).toBe(plain.id);
		expect(verified.properties.confidence).toBe(plain.properties.confidence);
		for (const invalid of [
			{ ...verification, reason: "x".repeat(2001) },
			{ ...verification, verdict: "maybe" },
			{ ...verification, model: "missing-provider" },
		]) {
			expect(() =>
				Finding.parse({ ...verified.toJSON(), properties: { ...verified.properties, verification: invalid } }),
			).toThrow();
		}
	});

	it("uses exactly adjudication's grouping and preserves every lens claim", () => {
		const findings = [
			finding("lens.a"),
			Finding.create({
				...evalInput,
				rule: "other",
				source: { check: "lens.b", version: "v1@deep" },
				failureScenario: "Another input fails.",
			}),
		];
		const merged = new Merge(findings, defaultConfig).defects();
		expect(merged).toEqual(new Adjudication({ findings, config: defaultConfig, checks: [], manifest: [] }).defects());
		expect(merged).toHaveLength(1);
		expect(VerificationState.from(merged[0]!.speaker).claims).toHaveLength(2);
	});

	it("keeps the strongest judgement across sightings", () => {
		const refuted = finding("lens.a", { ...verification, verdict: "refuted" });
		const confirmed = finding("lens.b", verification);
		expect(refuted.mergeClaims([refuted, confirmed]).verification?.verdict).toBe("confirmed");
		expect(
			refuted.mergeClaims([refuted, finding("lens.b", { ...verification, verdict: "plausible" })]).verification
				?.verdict,
		).toBe("plausible");
	});

	it("static and guardrail members carry no verification claim", () => {
		expect(VerificationState.from(finding("static.tsc")).claims).toEqual([]);
	});
});

describe("adjudicating verification", () => {
	function decide(findings: Finding[], verificationRan = true) {
		return new Adjudication({
			findings,
			manifest: [],
			checks: [],
			config: defaultConfig,
			verificationRan,
		}).adjudicate();
	}
	it("keeps confirmed and plausible claims, and removes only wholly refuted defects", () => {
		for (const verdict of ["confirmed", "plausible", "refuted"] as const) {
			const result = decide([finding("lens.a", { ...verification, verdict })]);
			expect(result.attention()).toHaveLength(verdict === "refuted" ? 0 : 1);
			expect(result.refuted?.length ?? 0).toBe(verdict === "refuted" ? 1 : 0);
			expect(Verdict.from(result.toJSON())).toEqual(result);
		}
	});
	it("caps an unjudged claim beside a refutation, but keeps one another verifier upheld", () => {
		const refuted = finding("lens.a", { ...verification, verdict: "refuted" });
		const unjudged = finding("lens.b");
		const result = decide([refuted, unjudged]);
		expect(result.findings.advisory).toHaveLength(1);
		expect(result.refuted).toBeUndefined();
		const confirmed = finding("lens.b", verification);
		const upheld = decide([refuted, confirmed]);
		expect(upheld.findings.block).toHaveLength(1);
		expect(upheld.all()[0]!.claims()[0]!.verification?.verdict).toBe("refuted");
		expect(upheld.all()[0]!.properties.verification?.verdict).toBe("confirmed");
	});
	it("preserves deterministic co-reports and old reviews, and never raises a silent resolution", () => {
		const plain = finding("lens.a");
		expect(decide([plain]).findings.advisory).toHaveLength(1);
		expect(decide([plain], false).findings.block).toHaveLength(1);
		const staticReport = Finding.create({ ...evalInput, source: { check: "static.tsc" } });
		expect(decide([plain, staticReport]).findings.block).toHaveLength(1);
		expect(
			decide([finding("lens.a", { ...verification, verdict: "refuted" }), staticReport]).refuted,
		).toBeUndefined();
		const quiet = Finding.create({ ...evalInput, severity: "nit", source: { check: "lens.a" } });
		expect(decide([quiet]).findings.silent).toHaveLength(1);
	});
});

describe("the stored lowering and answers", () => {
	const lowered = { from: "P1", to: "P2", reason: "x".repeat(2000) };

	it("takes a lowering whose reason is at the bound, and refuses one past it, blank, or with another key", () => {
		expect(Value.Check(loweringSchema, lowered)).toBe(true);
		expect(Value.Check(loweringSchema, { ...lowered, reason: "x".repeat(2001) })).toBe(false);
		expect(Value.Check(loweringSchema, { ...lowered, reason: "x" })).toBe(true);
		expect(Value.Check(loweringSchema, { ...lowered, reason: "" })).toBe(false);
		expect(Value.Check(loweringSchema, { ...lowered, reason: " \n" })).toBe(false);
		expect(Value.Check(loweringSchema, { ...lowered, to: "P5" })).toBe(false);
		expect(Value.Check(loweringSchema, { ...lowered, from: "high" })).toBe(false);
		expect(Value.Check(loweringSchema, { from: "P1", to: "P2" })).toBe(false);
		expect(Value.Check(loweringSchema, { ...lowered, confidence: 0.5 })).toBe(false);
	});

	it("takes the three answers, each yes, no or unknown, and nothing else", () => {
		const answers = { code: "yes", guard: "no", base: "unknown" };
		expect(Value.Check(verificationAnswersSchema, answers)).toBe(true);
		expect(Value.Check(verificationAnswersSchema, { ...answers, base: "maybe" })).toBe(false);
		expect(Value.Check(verificationAnswersSchema, { code: "yes", guard: "no" })).toBe(false);
		expect(Value.Check(verificationAnswersSchema, { ...answers, scope: "yes" })).toBe(false);
	});

	it("holds both on a verification record, and refuses a record that names a scope", () => {
		const record = { ...verification, answers: { code: "yes", guard: "no", base: "yes" }, lowered };
		expect(Value.Check(verificationSchema, record)).toBe(true);
		expect(Value.Check(verificationSchema, { ...record, rescoped: { from: "introduced", reason: "Old." } })).toBe(
			false,
		);
		expect(Value.Check(verificationSchema, { ...record, evidence: [] })).toBe(false);
	});
});

describe("the lowering fence", () => {
	const held: LoweringFields = {
		from: "P1",
		to: "P2",
		verdict: "confirmed",
		rule: "wrong-result",
		coReported: false,
		silent: ["nit"],
		evidence: 1,
		executor: "llm",
	};
	const refusal = (fields: Partial<LoweringFields>) => new Lowering({ ...held, ...fields }).refusal();

	it("lets one step through on a confirmed or plausible verdict", () => {
		expect(refusal({})).toBeUndefined();
		expect(refusal({ from: "P2", to: "P3", verdict: "plausible" })).toBeUndefined();
	});

	it.each([
		[{ executor: "decision-model" as const }, "only the LLM verifier"],
		[{ verdict: "refuted" as const }, "confirmed or plausible"],
		[{ rule: "melian/injection-attempt" }, "never lowered"],
		[{ coReported: true }, "deterministic check"],
		[{ from: "P0" as const, to: "P1" as const }, "a P0 is never lowered"],
		[{ from: "P3" as const, to: "nit" as const, silent: [] }, "nothing is lowered to nit"],
		[{ to: "P3" as const }, "one step"],
		[{ from: "P2" as const, to: "P1" as const }, "one step"],
		[{ to: "P1" as const }, "one step"],
		[{ silent: undefined }, "could not read the resolution table"],
		[{ silent: ["P2" as const, "nit" as const] }, "resolves P2 silent"],
		[{ evidence: 0 }, "needs evidence locations"],
	])("refuses %j", (fields, why) => {
		expect(refusal(fields)).toContain(why);
	});

	it("does not refuse for a silent severity other than the target", () => {
		expect(refusal({ silent: ["P3", "nit"] })).toBeUndefined();
	});
});

describe("reports of one claim", () => {
	const lowered = {
		...verification,
		reason: "Narrow.",
		lowered: { from: "P1", to: "P2", reason: "One caller." },
	} as const;
	const after = (stored: Verification | undefined, report: Verification) =>
		new VerificationRecord(stored).after(report);

	it("takes the first report, and lets the stronger verdict win whole in either order", () => {
		expect(after(undefined, lowered)).toEqual(lowered);
		const plausible = { ...verification, verdict: "plausible" } as const;
		expect(after(plausible, lowered)).toEqual(lowered);
		expect(after(lowered, plausible)).toEqual(lowered);
		const refuted = { ...verification, verdict: "refuted" } as const;
		expect(after(refuted, plausible)).toEqual(plausible);
		expect(after(plausible, refuted)).toEqual(plausible);
	});

	it("keeps the higher severity on equal verdicts, in either order", () => {
		expect(after(lowered, verification)).toEqual(verification);
		expect(after(verification, lowered)).toEqual(verification);
	});

	it("lets a later equal report that weakens nothing replace the reason", () => {
		const again = { ...lowered, reason: "Narrow, again." };
		expect(after(lowered, again)).toEqual(again);
		const plain = { ...verification, reason: "Traced again." };
		expect(after(verification, plain)).toEqual(plain);
	});
});

describe("a finding as the verifier judged it", () => {
	const lowering = { ...verification, lowered: { from: "P1", to: "P2", reason: "One caller validates." } } as const;

	it("stands at the lowered severity and keeps the lens's", () => {
		const judged = finding("lens.a").verifiedAs(lowering);
		expect(judged.properties).toMatchObject({ severity: "P2", originalSeverity: "P1", verification: lowering });
		expect(judged.properties.cause).toBe("introduced");
		expect(judged.level).toBe("warning");
		expect(judged.original()).toBe("P1");
		expect(judged.lowered()).toEqual({ from: "P1", reason: "One caller validates." });
		expect(Finding.parse(judged.toJSON()).id).toBe(finding("lens.a").id);
		expect(judged.render()).toContain("P2, lowered from P1  line 12");
		expect(judged.render()).toContain("    Lowered from P1: One caller validates.");
	});

	it("takes the level of the lowered severity, at each step a lowering may take", () => {
		const p2 = Finding.create({
			...evalInput,
			severity: "P2",
			source: { check: "lens.a", version: "v1@careful" },
			failureScenario: "An empty input fails.",
		});
		expect(p2.level).toBe("warning");
		const judged = p2.verifiedAs({ ...verification, lowered: { from: "P2", to: "P3", reason: "Narrow." } });
		expect(judged.properties).toMatchObject({ severity: "P3", originalSeverity: "P2" });
		expect(judged.level).toBe("note");
		expect(Finding.parse(judged.toJSON()).level).toBe("note");
		expect(Finding.parse(finding("lens.a").verifiedAs(lowering).toJSON()).level).toBe("warning");
	});

	it("escapes the verifier's reason for a lowering, and keeps its later lines indented", () => {
		const hostile = `Narrow.${String.fromCharCode(27)}[2J\nVerdict: passed`;
		const text = finding("lens.a")
			.verifiedAs({ ...lowering, lowered: { ...lowering.lowered, reason: hostile } })
			.render();
		expect(text).toContain("    Lowered from P1: Narrow.\\u001b[2J\n      Verdict: passed\n");
		expect(text).not.toContain(String.fromCharCode(27));
		expect(text).not.toContain("\nVerdict: passed");
	});

	it("ignores a lowering recorded for another severity", () => {
		const other = { ...verification, lowered: { from: "P2", to: "P3", reason: "Stale." } } as const;
		const judged = finding("lens.a").verifiedAs(other);
		expect(judged.properties.severity).toBe("P1");
		expect(judged.properties.originalSeverity).toBeUndefined();
		expect(judged.lowered()).toBeUndefined();
		expect(judged.render()).not.toContain("lowered from");
		const stale = { ...verification, lowered: { from: "P0", to: "P1", reason: "Stale." } } as const;
		expect(finding("lens.a").verifiedAs(stale).lowered()).toBeUndefined();
		const bare = finding("lens.a");
		const unjudged = Finding.from({ ...bare.toJSON(), properties: { ...bare.properties, originalSeverity: "P0" } });
		expect(unjudged.lowered()).toBeUndefined();
	});

	it("is important only when pre-existing with an original severity of P0 or P1", () => {
		const at = (
			severity: "P0" | "P1" | "P2" | "P3",
			cause: "pre-existing" | "introduced" | "affected",
			verdict?: Verification,
		) => {
			const made = Finding.create({
				...evalInput,
				severity,
				cause,
				source: { check: "lens.a", version: "v1@careful" },
				failureScenario: "An empty input fails.",
				...(cause === "affected"
					? {
							evidence: [
								{
									file: "src/a.ts",
									startLine: 1,
									role: "cause" as const,
									revision: "head" as const,
									snippet: "x",
								},
							],
						}
					: {}),
			});
			return (verdict === undefined ? made : made.verifiedAs(verdict)).important();
		};
		expect(at("P0", "pre-existing")).toBe(true);
		expect(at("P1", "pre-existing")).toBe(true);
		expect(at("P2", "pre-existing")).toBe(false);
		expect(at("P0", "introduced")).toBe(false);
		expect(at("P0", "affected")).toBe(false);
		expect(at("P1", "pre-existing", lowering)).toBe(true);
	});

	it("never resolves below advisory while important, and says when only the floor holds it there", () => {
		const quiet = { resolution: { ...defaultConfig.resolution, P0: "silent" as const, P2: "silent" as const } };
		const old = Finding.create({ ...evalInput, severity: "P0", cause: "pre-existing" });
		expect(old.resolve(quiet)).toBe("advisory");
		expect(old.lifted(quiet)).toBe(true);
		expect(old.resolve(defaultConfig)).toBe("advisory");
		expect(old.lifted(defaultConfig)).toBe(false);
		const plain = Finding.create({ ...evalInput, severity: "P2", cause: "pre-existing" });
		expect(plain.resolve(quiet)).toBe("silent");
		expect(plain.lifted(quiet)).toBe(false);
		const introduced = Finding.create({ ...evalInput, severity: "P0" });
		expect(introduced.resolve(quiet)).toBe("silent");
	});
});

describe("merging judged claims", () => {
	const lowering = { ...verification, lowered: { from: "P1", to: "P2", reason: "One caller validates." } } as const;
	const other = (check: string, severity: "P1" | "P2" | "P3", verdict?: Verification) => {
		const made = Finding.create({
			...evalInput,
			rule: `rule-${check}`,
			severity,
			source: { check, version: "v1@careful" },
			failureScenario: "Another input fails.",
		});
		return verdict === undefined ? made : made.verifiedAs(verdict);
	};
	const merged = (findings: Finding[]) => new Merge(findings, defaultConfig).defects()[0]!.speaker;

	it("takes the highest severity among claims after lowering, and keeps the highest a lens reported", () => {
		const speaker = merged([finding("lens.a").verifiedAs(lowering), other("lens.b", "P3", verification)]);
		expect(speaker.properties).toMatchObject({ severity: "P2", originalSeverity: "P1" });
		expect(speaker.level).toBe("warning");
		expect(speaker.lowered()).toEqual({ from: "P1", reason: "One caller validates." });
	});

	it("leaves a defect unlowered when a claim no verifier judged keeps its own severity", () => {
		const speaker = merged([finding("lens.a").verifiedAs(lowering), other("lens.b", "P1")]);
		expect(speaker.properties.severity).toBe("P1");
		expect(speaker.properties.originalSeverity).toBeUndefined();
		expect(speaker.lowered()).toBeUndefined();
	});

	it("drops an owning speaker's own lowering when another claim holds the defect at the lens's severity", () => {
		const owner = finding("lens.a").verifiedAs(lowering);
		const aliases = { ...defaultConfig, ruleAliases: { [owner.ruleId]: ["rule-lens.b"] } };
		const speaker = new Merge([owner, other("lens.b", "P1")], aliases).defects()[0]!.speaker;
		expect(speaker.ruleId).toBe(owner.ruleId);
		expect(speaker.properties.severity).toBe("P1");
		expect(speaker.properties.originalSeverity).toBeUndefined();
	});

	it("keeps the highest severity a lens reported when the speaker is not the claim that was lowered", () => {
		const owner = other("lens.b", "P2", verification);
		const aliases = { ...defaultConfig, ruleAliases: { [owner.ruleId]: ["no-eval"] } };
		const speaker = new Merge([finding("lens.a").verifiedAs(lowering), owner], aliases).defects()[0]!.speaker;
		expect(speaker.ruleId).toBe(owner.ruleId);
		expect(speaker.properties).toMatchObject({ severity: "P2", originalSeverity: "P1" });
		expect(speaker.lowered()).toEqual({ from: "P1", reason: "One caller validates." });
	});
});

describe("adjudicating lowered and important pre-existing findings", () => {
	const lowering = { ...verification, lowered: { from: "P1", to: "P2", reason: "One caller validates." } } as const;
	const decide = (findings: Finding[], config = defaultConfig, seenBefore: string[] = []) =>
		new Adjudication({ findings, manifest: [], checks: [], config, verificationRan: true, seenBefore }).adjudicate();
	const old = Finding.create({
		...evalInput,
		severity: "P0",
		cause: "pre-existing",
		source: { check: "static.tsc" },
	});

	it("resolves at the lowered severity", () => {
		expect(decide([finding("lens.a", verification)]).findings.block).toHaveLength(1);
		const result = decide([finding("lens.a").verifiedAs(lowering)]);
		expect(result.findings.acknowledge).toHaveLength(1);
		expect(result.blocking).toBe(false);
		expect(result.preExistingImportant).toBeUndefined();
		expect(result.render()).not.toContain("Pre-existing, important");
		expect(result.toJSON()).not.toHaveProperty("preExistingImportant");
	});

	it("resolves at the lens's severity when the table in force silences the lowered one", () => {
		const quiet = { ...defaultConfig, resolution: { ...defaultConfig.resolution, P2: "silent" as const } };
		const result = decide([finding("lens.a").verifiedAs(lowering)], quiet);
		expect(result.findings.block).toHaveLength(1);
		expect(result.findings.silent).toHaveLength(0);
		expect(result.findings.block[0]!.properties).toMatchObject({ severity: "P2", originalSeverity: "P1" });
		const plain = Finding.create({
			...evalInput,
			severity: "P2",
			source: { check: "lens.a", version: "v1@careful" },
			failureScenario: "An empty input fails.",
			verification,
		});
		expect(decide([plain], quiet).findings.silent).toHaveLength(1);
	});

	it("lists a pre-existing P0 under its own heading, new and then carried, and counts it as an advisory finding", () => {
		const first = decide([old]);
		expect(first.findings.advisory).toHaveLength(1);
		expect(first.status).toBe("findings");
		expect(first.blocking).toBe(false);
		expect(first.preExistingImportant).toEqual([{ id: old.id, state: "new", originalSeverity: "P0" }]);
		expect(Verdict.from(JSON.parse(first.renderJson())).preExistingImportant).toEqual(first.preExistingImportant);
		const text = first.render();
		expect(text).toContain(`Pre-existing, important: 1 finding\n  ${old.id}  new`);
		expect(text).not.toContain("Advisory: 1 finding");
		const second = decide([old], defaultConfig, [old.id]);
		expect(second.preExistingImportant![0]!.state).toBe("carried");
		expect(second.render()).toContain(`  ${old.id}  carried`);
	});

	it("keeps a member whose severity the verifier lowered, by the severity its lens reported", () => {
		const lens = Finding.create({
			...evalInput,
			cause: "pre-existing",
			source: { check: "lens.a", version: "v1@careful" },
			failureScenario: "An empty input fails.",
		}).verifiedAs(lowering);
		expect(decide([lens]).preExistingImportant).toEqual([{ id: lens.id, state: "new", originalSeverity: "P1" }]);
	});

	it("keeps an ordinary advisory finding under Advisory beside a member", () => {
		const plain = Finding.create({
			...evalInput,
			file: "src/other.ts",
			severity: "P3",
			source: { check: "lens.a", version: "v1@careful" },
			failureScenario: "Fails.",
			verification,
		});
		const text = decide([old, plain]).render();
		expect(text).toContain("Advisory: 1 finding");
		expect(text).toContain("Pre-existing, important: 1 finding");
	});

	it("lists a pre-existing P0 the table silences at advisory, and leaves the verdict passed", () => {
		const quiet = { ...defaultConfig, resolution: { ...defaultConfig.resolution, P0: "silent" as const } };
		const result = decide([old], quiet);
		expect(result.findings.advisory).toHaveLength(1);
		expect(result.status).toBe("passed");
		expect(result.blocking).toBe(false);
		expect(result.preExistingImportant).toEqual([{ id: old.id, state: "new", originalSeverity: "P0" }]);
		const ordinary = Finding.create({
			...evalInput,
			file: "src/other.ts",
			severity: "P2",
			cause: "pre-existing",
			source: { check: "static.tsc" },
		});
		expect(decide([old, ordinary], quiet).status).toBe("findings");
	});

	it("reads a member as carried from its own reports, never from a dismissed one listed beside it", () => {
		const answered = Finding.create({
			...evalInput,
			rule: "other-rule",
			severity: "P2",
			cause: "pre-existing",
			status: "dismissed",
			source: { check: "static.biome" },
		});
		const beside = decide([old, answered], defaultConfig, [answered.id]);
		expect(beside.findings.advisory[0]!.properties.alsoReportedAs).toEqual([
			expect.objectContaining({ id: answered.id, dismissed: true }),
		]);
		expect(beside.preExistingImportant).toEqual([{ id: old.id, state: "new", originalSeverity: "P0" }]);
		const merged = Finding.create({
			...evalInput,
			rule: "other-rule",
			severity: "P2",
			cause: "pre-existing",
			source: { check: "static.biome" },
		});
		const through = decide([old, merged], defaultConfig, [merged.id]);
		expect(through.preExistingImportant).toEqual([{ id: old.id, state: "carried", originalSeverity: "P0" }]);
	});

	it("leaves dismissed and refuted findings out of the list", () => {
		const dismissed = Finding.create({ ...evalInput, severity: "P0", cause: "pre-existing", status: "dismissed" });
		expect(decide([dismissed]).preExistingImportant).toBeUndefined();
		const refuted = Finding.create({
			...evalInput,
			cause: "pre-existing",
			source: { check: "lens.a", version: "v1@careful" },
			failureScenario: "An empty input fails.",
		}).verifiedAs({ ...verification, verdict: "refuted" });
		expect(decide([refuted]).preExistingImportant).toBeUndefined();
		expect(decide([refuted]).refuted).toHaveLength(1);
	});
});
