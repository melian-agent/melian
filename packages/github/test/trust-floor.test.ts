import { Adjudication, defaultConfig, Finding, type Verification } from "@melian-agent/core";
import { renderReviewBody } from "@melian-agent/github";
import { describe, expect, it } from "vitest";

describe("step 29: GitHub explains the trust floor", () => {
	it.each(["plausible", "refuted"] as const)("shows a %s trust objection in the body", (verdict) => {
		const judgement: Verification = {
			verdict,
			reason: "The verifier believes staging prevents a planted kill.",
			executor: "llm",
			model: "faux/judge",
			version: "1",
			evidence: [
				{ file: "src/mutation.ts", startLine: 3, role: "context", revision: "head", snippet: "incremental: true" },
			],
			...(verdict === "plausible"
				? { lowered: { from: "P2" as const, to: "P3" as const, reason: "Needs hostile configuration." } }
				: {}),
		};
		const finding = Finding.create({
			rule: "fail-open",
			message: "A cold run can reuse a planted kill.",
			file: "src/mutation.ts",
			startLine: 3,
			snippet: "incremental: true",
			occurrence: 0,
			cause: "introduced",
			severity: "P2",
			source: { check: "lens.trust-boundary", version: "1" },
			failureScenario: "Vitest configuration plants a kill before Stryker reads the incremental file.",
			explanation: {
				what: "A cold run can reuse a planted kill.",
				whyHere: "The head's configuration loads first.",
				whatToDo: "Force Stryker to rerun mutants.",
			},
		}).verifiedAs(judgement);
		const review = new Adjudication({
			findings: [finding],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		const body = renderReviewBody(
			{
				pullRequest: 125,
				revision: "a".repeat(40),
				base: "b".repeat(40),
				verdict: review,
				fingerprint: review.fingerprint(),
				round: 1,
				secret: "11".repeat(32),
				findings: review.publication({}, {}, "a".repeat(40)).post,
				stillOpen: 0,
				resolved: [],
			},
			{ web: "https://github.com/melian-agent/example" },
		);
		expect(body).toContain("Trust floor: acknowledge required; maintainer dismissal needed.");
		expect(body).toContain(`Verification: **${verdict}**`);
		expect(body).toContain("1 acknowledge");
	});
});
