import { Adjudication, defaultConfig, Finding, type Verification } from "@melian-agent/core";
import { Ledger, ReviewComment, renderReviewBody } from "@melian-agent/github";
import { describe, expect, it } from "vitest";

describe("step 29: GitHub explains the trust floor", () => {
	it.each(["plausible", "refuted"] as const)("shows a %s trust objection in the body", (verdict) => {
		const judgement: Verification = {
			verdict,
			reason: "The verifier believes <script>guard | bypass</script>.",
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
		const draft = {
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
		} satisfies Parameters<typeof renderReviewBody>[0];
		const links = { web: "https://github.com/melian-agent/example" };
		const body = renderReviewBody(draft, links);
		const summary = renderReviewBody({ ...draft, findings: [] }, links);
		expect.soft(summary).toContain("Trust floor: acknowledge required; maintainer dismissal needed.");
		expect.soft(summary).not.toContain("&lt;script&gt;guard");
		const ledger = Ledger.from(
			review,
			{
				rounds: [
					{
						base: draft.base,
						head: draft.revision,
						round: 1,
						verdict: review.toJSON(),
						resolved: [],
					},
				],
			},
			{ pullRequest: 125, secret: draft.secret, walkthrough: { enabled: false, collapsed: true, diagrams: false } },
		).render(links);
		const entry = ledger.split("\n").find((line) => line.startsWith(`- ${finding.id}:`)) ?? "";
		expect.soft(entry).toContain("Trust floor: acknowledge required; maintainer dismissal needed.");
		expect.soft(entry).toContain(`${verdict}, reported P2, minimum acknowledge.`);
		expect.soft(entry).toContain("&lt;script&gt;guard \\| bypass&lt;/script&gt;");
		expect.soft(entry).not.toContain("<script>");
		if (verdict === "refuted")
			expect.soft(entry).toContain("Verifier refuted this claim; maintainer review still required.");
		if (judgement.lowered !== undefined) {
			const inline = ReviewComment.from(review.findings.acknowledge[0]!, {
				kind: "lines",
				startLine: 3,
				line: 3,
			}).render({ revision: draft.revision, base: draft.base, links, secret: draft.secret });
			expect.soft(inline.split(judgement.lowered.reason)).toHaveLength(2);
			expect.soft(body.split(judgement.lowered.reason)).toHaveLength(2);
			expect.soft(entry.split(judgement.lowered.reason)).toHaveLength(2);
		}
		expect(body).toContain("Trust floor: acknowledge required; maintainer dismissal needed.");
		expect(body).toContain(`Verification: **${verdict}**`);
		expect(body).toContain("1 acknowledge");
	});
});
