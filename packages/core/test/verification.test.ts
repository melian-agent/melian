import {
	Adjudication,
	defaultConfig,
	Finding,
	Merge,
	Verdict,
	type Verification,
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
