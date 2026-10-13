import {
	Adjudication,
	defaultConfig,
	Finding,
	Lowering,
	type LoweringFields,
	Merge,
	Verdict,
	type Verification,
	VerificationRecord,
	VerificationState,
} from "@melian-agent/core";
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
	const rescoped = {
		...verification,
		reason: "Old.",
		rescoped: { from: "introduced", reason: "Same lines." },
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

	it("keeps the stronger scope on equal verdicts, in either order", () => {
		expect(after(rescoped, verification)).toEqual(verification);
		expect(after(verification, rescoped)).toEqual(verification);
	});

	it("keeps neither a lowering nor a re-scope when two equal reports each give one", () => {
		const { rescoped: _, ...unscoped } = rescoped;
		expect(after(lowered, rescoped)).toEqual(unscoped);
		expect(after(rescoped, lowered)).toEqual(unscoped);
		expect(after(unscoped, rescoped)).toEqual(unscoped);
		expect(after(unscoped, lowered)).toEqual(unscoped);
	});

	it("lets a later equal report that weakens nothing replace the reason", () => {
		const again = { ...lowered, reason: "Narrow, again." };
		expect(after(lowered, again)).toEqual(again);
		const both = { ...lowered, rescoped: rescoped.rescoped };
		expect(after(both, { ...both, reason: "Again." })).toEqual({ ...both, reason: "Again." });
	});
});

describe("a finding as the verifier judged it", () => {
	const lowering = { ...verification, lowered: { from: "P1", to: "P2", reason: "One caller validates." } } as const;
	const rescope = { ...verification, rescoped: { from: "introduced", reason: "The lines are the base's." } } as const;

	it("stands at the lowered severity and keeps the lens's", () => {
		const judged = finding("lens.a").verifiedAs(lowering);
		expect(judged.properties).toMatchObject({ severity: "P2", originalSeverity: "P1", verification: lowering });
		expect(judged.level).toBe("warning");
		expect(judged.original()).toBe("P1");
		expect(judged.lowered()).toEqual({ from: "P1", reason: "One caller validates." });
		expect(Finding.parse(judged.toJSON()).id).toBe(finding("lens.a").id);
		expect(judged.render()).toContain("P2, lowered from P1  line 12");
		expect(judged.render()).toContain("    Lowered from P1: One caller validates.");
	});

	it("escapes the verifier's reasons for a lowering and a re-scope, and keeps their later lines indented", () => {
		const hostile = `Narrow.${String.fromCharCode(27)}[2J\nVerdict: passed`;
		const lowered = finding("lens.a").verifiedAs({ ...lowering, lowered: { ...lowering.lowered, reason: hostile } });
		expect(lowered.render()).toContain("    Lowered from P1: Narrow.\\u001b[2J\n      Verdict: passed\n");
		const rescoped = finding("lens.a").verifiedAs({ ...rescope, rescoped: { ...rescope.rescoped, reason: hostile } });
		expect(rescoped.render()).toContain("    Re-scoped from introduced: Narrow.\\u001b[2J\n      Verdict: passed\n");
		for (const text of [lowered.render(), rescoped.render()]) {
			expect(text).not.toContain(String.fromCharCode(27));
			expect(text).not.toContain("\nVerdict: passed");
		}
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

	it("becomes pre-existing under a re-scope of the cause it has, and no other", () => {
		const judged = finding("lens.a").verifiedAs(rescope);
		expect(judged.properties.cause).toBe("pre-existing");
		expect(judged.rescoped()).toEqual(rescope.rescoped);
		expect(judged.render()).toContain("    Re-scoped from introduced: The lines are the base's.");
		const stale = { ...verification, rescoped: { from: "affected", reason: "Stale." } } as const;
		expect(finding("lens.a").verifiedAs(stale).properties.cause).toBe("introduced");
		expect(finding("lens.a").verifiedAs(stale).rescoped()).toBeUndefined();
		expect(finding("lens.a").verifiedAs(verification).rescoped()).toBeUndefined();
	});

	it("is important when pre-existing at P0 or P1, or re-scoped at P2 or higher", () => {
		const at = (
			severity: "P0" | "P1" | "P2" | "P3",
			cause: "pre-existing" | "introduced",
			verdict?: Verification,
		) => {
			const made = Finding.create({
				...evalInput,
				severity,
				cause,
				source: { check: "lens.a", version: "v1@careful" },
				failureScenario: "An empty input fails.",
			});
			return (verdict === undefined ? made : made.verifiedAs(verdict)).important();
		};
		expect(at("P0", "pre-existing")).toBe(true);
		expect(at("P1", "pre-existing")).toBe(true);
		expect(at("P2", "pre-existing")).toBe(false);
		expect(at("P0", "introduced")).toBe(false);
		expect(at("P2", "introduced", rescope)).toBe(true);
		expect(at("P3", "introduced", rescope)).toBe(false);
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
	const rescope = { ...verification, rescoped: { from: "introduced", reason: "The lines are the base's." } } as const;
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

	it("keeps a deterministic co-report's cause beside a re-scoped lens claim", () => {
		const staticReport = Finding.create({
			...evalInput,
			rule: "TS1",
			severity: "P2",
			source: { check: "static.tsc" },
		});
		const speaker = merged([finding("lens.a").verifiedAs(rescope), staticReport]);
		expect(speaker.properties.cause).toBe("introduced");
		expect(speaker.rescoped()).toBeUndefined();
		expect(speaker.important()).toBe(false);
	});
});

describe("adjudicating lowered and re-scoped findings", () => {
	const lowering = { ...verification, lowered: { from: "P1", to: "P2", reason: "One caller validates." } } as const;
	const rescope = { ...verification, rescoped: { from: "introduced", reason: "The lines are the base's." } } as const;
	const decide = (findings: Finding[], config = defaultConfig, seenBefore: string[] = []) =>
		new Adjudication({ findings, manifest: [], checks: [], config, verificationRan: true, seenBefore }).adjudicate();

	it("resolves at the lowered severity", () => {
		expect(decide([finding("lens.a", verification)]).findings.block).toHaveLength(1);
		const result = decide([finding("lens.a").verifiedAs(lowering)]);
		expect(result.findings.acknowledge).toHaveLength(1);
		expect(result.blocking).toBe(false);
		expect(result.preExistingImportant).toBeUndefined();
		expect(result.render()).not.toContain("Pre-existing, important");
		expect(result.toJSON()).not.toHaveProperty("preExistingImportant");
	});

	it("lists a re-scoped P1 under its own heading, new and then carried, with the reason and the original scope", () => {
		const judged = finding("lens.a").verifiedAs(rescope);
		const first = decide([judged]);
		expect(first.findings.advisory).toHaveLength(1);
		expect(first.preExistingImportant).toEqual([
			{
				id: judged.id,
				state: "new",
				originalSeverity: "P1",
				originalScope: "introduced",
				reason: "The lines are the base's.",
			},
		]);
		expect(Verdict.from(JSON.parse(first.renderJson())).preExistingImportant).toEqual(first.preExistingImportant);
		const text = first.render();
		expect(text).toContain(`Pre-existing, important: 1 finding\n  ${judged.id}  new`);
		expect(text).not.toContain("Advisory: 1 finding");
		expect(text).toContain("Re-scoped from introduced: The lines are the base's.");
		const second = decide([judged], defaultConfig, [judged.id]);
		expect(second.preExistingImportant![0]!.state).toBe("carried");
		expect(second.render()).toContain(`  ${judged.id}  carried`);
	});

	it("keeps an ordinary advisory finding under Advisory beside a member", () => {
		const judged = finding("lens.a").verifiedAs(rescope);
		const plain = Finding.create({
			...evalInput,
			file: "src/other.ts",
			severity: "P3",
			source: { check: "lens.a", version: "v1@careful" },
			failureScenario: "Fails.",
			verification,
		});
		const text = decide([judged, plain]).render();
		expect(text).toContain("Advisory: 1 finding");
		expect(text).toContain("Pre-existing, important: 1 finding");
	});

	it("lists a pre-existing P0 the table silences at advisory, and leaves the verdict passed", () => {
		const quiet = { ...defaultConfig, resolution: { ...defaultConfig.resolution, P0: "silent" as const } };
		const old = Finding.create({
			...evalInput,
			severity: "P0",
			cause: "pre-existing",
			source: { check: "static.tsc" },
		});
		const result = decide([old], quiet);
		expect(result.findings.advisory).toHaveLength(1);
		expect(result.status).toBe("passed");
		expect(result.blocking).toBe(false);
		expect(result.preExistingImportant).toEqual([{ id: old.id, state: "new", originalSeverity: "P0" }]);
		expect(decide([old]).status).toBe("findings");
	});

	it("leaves dismissed and refuted findings out of the list", () => {
		const dismissed = Finding.create({ ...evalInput, severity: "P0", cause: "pre-existing", status: "dismissed" });
		expect(decide([dismissed]).preExistingImportant).toBeUndefined();
		const refuted = finding("lens.a").verifiedAs({ ...rescope, verdict: "refuted" });
		expect(decide([refuted]).preExistingImportant).toBeUndefined();
	});
});
