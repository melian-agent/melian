import {
	Adjudication,
	defaultConfig,
	Finding,
	type FindingInput,
	Rendering,
	type Verification,
	VerificationState,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const input: FindingInput = {
	rule: "fail-open",
	message: "A cold run can reuse a planted kill.",
	file: "src/run.ts",
	startLine: 12,
	snippet: "incremental: true",
	occurrence: 0,
	cause: "introduced",
	severity: "P2",
	source: { check: "carried/lens.trust-boundary", version: "1@careful" },
	failureScenario: "A planted kill passes a cold run.",
	explanation: { what: "w", whyHere: "h", whatToDo: "t" },
};
const refuted: Verification = {
	verdict: "refuted",
	reason: "Staging prevents it.",
	executor: "llm",
	model: "faux/judge",
	version: "1",
};
const by = (check: string, overrides: Partial<FindingInput> = {}) =>
	Finding.create({ ...input, ...overrides, source: { check, version: "1@careful" } });
const reported = (finding: Finding, ...checks: string[]) =>
	Finding.from({
		...finding.toJSON(),
		properties: { ...finding.properties, reportedBy: checks.map((check) => ({ check, version: "1@careful" })) },
	});
const adjudicate = (...findings: Finding[]) =>
	new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate();

describe("a carried lens sighting", () => {
	it("counts as a lens report, so lenses alone reported it until a deterministic check co-reports", () => {
		const carried = by("carried/lens.correctness");
		expect(carried.lensReport()).toBe(true);
		expect(carried.unjudged()).toBe(true);
		expect(carried.verifiedAs(refuted).refuted()).toBe(true);
		const mixed = reported(carried, "carried/lens.correctness", "guardrails");
		expect(mixed.lensReport()).toBe(false);
		expect(mixed.unjudged()).toBe(false);
		expect(mixed.verifiedAs(refuted).refuted()).toBe(false);
		expect(reported(carried, "guardrails", "carried/lens.correctness").lensReport()).toBe(false);
	});

	it("is refuted out of the verdict when lenses alone reported it, and kept when a deterministic check did too", () => {
		const carried = by("carried/lens.correctness").verifiedAs(refuted);
		expect(adjudicate(carried).refuted?.map((finding) => finding.id)).toEqual([carried.id]);
		const mixed = reported(carried, "carried/lens.correctness", "static.tsc");
		expect(adjudicate(mixed).refuted ?? []).toEqual([]);
	});

	it("keeps the trust floor of the lens it was carried from, and only of a protected one", () => {
		for (const check of ["carried/lens.trust-boundary", "carried/lens.tests"]) {
			const verdict = adjudicate(by(check).verifiedAs(refuted));
			expect(verdict.refuted ?? []).toEqual([]);
			expect(verdict.all()[0]?.properties.decidedBy?.trustFloor).toHaveLength(1);
		}
		const unprotected = adjudicate(by("carried/lens.correctness").verifiedAs(refuted));
		expect(unprotected.refuted).toHaveLength(1);
		expect(unprotected.attention()).toEqual([]);
	});

	it("hands the verifier the carried lens's claim, and no deterministic co-reporter's", () => {
		const mixed = reported(by("carried/lens.correctness"), "carried/lens.correctness", "static.tsc");
		expect(VerificationState.from(mixed).claims.map((claim) => claim.source.check)).toEqual([
			"carried/lens.correctness",
		]);
		expect(VerificationState.from(by("static.tsc")).claims).toEqual([]);
	});

	it("shows the unverified mark of the lens it came from, and names no other check that decided it", () => {
		const [finding] = adjudicate(by("carried/lens.correctness", { severity: "P1" })).all();
		const rendering = new Rendering({ decided: true });
		expect(finding!.statusSegments(rendering)).toContain("Not verified");
		expect(finding!.render(rendering)).toMatch(/Decided by: /);
		expect(finding!.render(rendering)).not.toMatch(/reported it/);
	});
});
