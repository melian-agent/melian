import {
	Adjudication,
	defaultConfig,
	Finding,
	type FindingInput,
	type Placement,
	type Verification,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { createGitHubProvider } from "../src/provider.ts";
import { ReviewComment, renderReviewBody } from "../src/publication.ts";
import { fakeGitHub, fakeState } from "./fixtures/fake-github.ts";

// The guideline's worked examples as a pull request shows them. Each expected text is written by hand from
// docs/guidelines/findings.md, never from what the renderer printed; only the marker line is left to the code.

const revision = "a".repeat(40);
const base = "c".repeat(40);
const links = { web: "https://github.com/melian-agent/example" };
const secret = "11".repeat(32);
const inline: Placement = { kind: "lines", startLine: 31, line: 44 };

const judged = (verdict: Verification["verdict"], reason: string): Verification => ({
	verdict,
	reason,
	executor: "llm",
	model: "faux/judge",
	version: "1",
});

function decided(input: FindingInput, verification?: Verification): Finding {
	const finding = Finding.create(input);
	return new Adjudication({
		findings: [verification === undefined ? finding : finding.verifiedAs(verification)],
		manifest: [],
		checks: [{ name: "verifier", status: "ran" }],
		config: defaultConfig,
		verificationRan: verification !== undefined,
	})
		.adjudicate()
		.all()
		.find((each) => each.ruleId === input.rule)!;
}

// The comment without its marker, which signs the finding and is tested elsewhere.
function comment(finding: Finding, emoji?: boolean, placement = inline): string {
	const rendered = ReviewComment.from(finding, placement).render({
		revision,
		base,
		links,
		secret,
		...(emoji === undefined ? {} : { emoji }),
	});
	return rendered.split("\n").slice(1).join("\n");
}

const retriedCharge: FindingInput = {
	rule: "payment-idempotency",
	message: "A retry after a lost response charges the card twice.",
	file: "payments/submit.ts",
	startLine: 31,
	endLine: 44,
	snippet: "await chargeCard(intent)",
	occurrence: 0,
	cause: "introduced",
	severity: "P1",
	source: { check: "lens.correctness", version: "1" },
	failureScenario:
		"The processor accepts a $40 charge, and the response times out. The customer presses Pay again. A second intent and a second $40 charge follow.",
	evidence: [
		{ file: "payments/submit.ts", startLine: 31, endLine: 44, role: "cause", revision: "head", snippet: "x" },
		{ file: "payments/submit.ts", startLine: 28, endLine: 35, role: "context", revision: "base", snippet: "y" },
	],
	explanation: {
		what: "submitPayment creates a new payment intent on every attempt, and chargeCard sends no idempotency key.",
		whyHere:
			"At the base, submitPayment reused the open intent through findOpenIntent. This change removes that call.",
		whatToDo: "Restore findOpenIntent, or pass the intent ID as the idempotency key.",
	},
};

describe("a finding as a pull request shows it, in the register", () => {
	it("posts a confirmed P1 with its status line, its headline once, its parts in order and a footer", () => {
		const finding = decided(retriedCharge, judged("confirmed", "The second call creates a new intent."));
		expect(comment(finding)).toBe(
			[
				"\u{1F7E0} P1 | \u{26D4} Blocks merge | \u{1F3AF} Correctness | \u{2705} Verifier confirmed | New in this change",
				"",
				"**A retry after a lost response charges the card twice.**",
				"",
				"**What:** submitPayment creates a new payment intent on every attempt, and chargeCard sends no idempotency key.",
				"",
				"**Why here:** At the base, submitPayment reused the open intent through findOpenIntent. This change removes that call.",
				"",
				"**Failure scenario:** The processor accepts a $40 charge, and the response times out. The customer presses Pay again. A second intent and a second $40 charge follow.",
				"",
				`**Evidence:** cause, [\`payments/submit.ts\` lines 31-44](${links.web}/blob/${revision}/payments/submit.ts#L31-L44) at the head; context, [\`payments/submit.ts\` lines 28-35](${links.web}/blob/${base}/payments/submit.ts#L28-L35) at the base.`,
				"",
				"\u{2696}\u{FE0F} **Verifier:** The second call creates a new intent.",
				"",
				"**What to do:** Restore findOpenIntent, or pass the intent ID as the idempotency key.",
				"",
				`Rule \`payment-idempotency\` | Finding \`${finding.id}\``,
			].join("\n"),
		);
	});

	it("posts a plausible P2 whose message repeats What with that sentence once, and no section it lacks", () => {
		const what = "saveRecord calls cache.set without a catch, while readRecord beside it returns null.";
		const finding = decided(
			{
				...retriedCharge,
				rule: "degrade-on-cache-failure",
				message: what,
				severity: "P2",
				evidence: undefined,
				failureScenario: "The cache is down. cache.set rejects, and no item syncs.",
				explanation: {
					what,
					whyHere: "The description says a cache outage never stops a sync.",
					whatToDo: "Catch and log the error, as readRecord does.",
				},
			},
			judged("plausible", "It did not read the cache client, which may swallow write errors itself."),
		);
		expect(comment(finding)).toBe(
			[
				"\u{1F7E1} P2 | \u{270B} Needs acknowledgement | \u{1F3AF} Correctness | \u{26A0}\u{FE0F} Verifier plausible | New in this change",
				"",
				`**${what}**`,
				"",
				"**Why here:** The description says a cache outage never stops a sync.",
				"",
				"**Failure scenario:** The cache is down. cache.set rejects, and no item syncs.",
				"",
				"\u{2696}\u{FE0F} **Verifier:** It did not read the cache client, which may swallow write errors itself.",
				"",
				"**What to do:** Catch and log the error, as readRecord does.",
				"",
				`Rule \`degrade-on-cache-failure\` | Finding \`${finding.id}\``,
			].join("\n"),
		);
	});

	it("posts an advisory P3 as one body entry framed by its status line", () => {
		const finding = decided({
			...retriedCharge,
			rule: "docs-match-code",
			message: "The guide says half-hour slots; the list builds quarter-hours.",
			severity: "P3",
			source: { check: "lens.conventions" },
			evidence: undefined,
			failureScenario: undefined,
		});
		expect(comment(finding, true, { kind: "body" })).toBe(
			`- \u{1F535} P3 | \u{1F4AC} Advisory | \u{1F4CF} Conventions | \u{2754} Not verified | New in this change: [\`payments/submit.ts:31\`](${links.web}/blob/${revision}/payments/submit.ts#L31-L44) \`docs-match-code\`: The guide says half-hour slots; the list builds quarter-hours.`,
		);
	});

	it("posts a test gap under the tests lens", () => {
		const finding = decided(
			{
				...retriedCharge,
				rule: "untested-behaviour",
				message: "The test passes when the charge is sent twice.",
				severity: "P2",
				source: { check: "lens.tests" },
			},
			judged("confirmed", "Two calls pass the assertion."),
		);
		expect(comment(finding).split("\n").slice(0, 3)).toEqual([
			"\u{1F7E1} P2 | \u{270B} Needs acknowledgement | \u{1F9EA} Tests | \u{2705} Verifier confirmed | New in this change",
			"",
			"**The test passes when the charge is sent twice.**",
		]);
	});

	const injection: FindingInput = {
		...retriedCharge,
		rule: "melian/injection-attempt",
		message: "A comment in this change tells reviewers to report nothing.",
		source: { check: "lens.trust-boundary" },
		failureScenario: undefined,
	};

	it("posts a confirmed injection attempt at P1 from the trust-boundary lens", () => {
		const finding = decided(injection, judged("confirmed", "Line 3 addresses reviewers."));
		expect(comment(finding).split("\n")[0]).toBe(
			"\u{1F7E0} P1 | \u{26D4} Blocks merge | \u{1F6E1}\u{FE0F} Trust boundary | \u{2705} Verifier confirmed | New in this change",
		);
	});

	it("posts a wholly refuted injection attempt at its floor, with its obligation and the verifier's reason", () => {
		const finding = decided(injection, judged("refuted", "The comment is documentation."));
		expect(finding.properties.resolution).toBe("acknowledge");
		const lines = comment(finding).split("\n");
		expect(lines[0]).toBe(
			"\u{1F7E0} P1 | \u{270B} Needs acknowledgement | \u{1F6E1}\u{FE0F} Trust boundary | \u{2716}\u{FE0F} Refuted | New in this change",
		);
		expect(lines).toContain("\u{2696}\u{FE0F} **Verifier:** The comment is documentation.");
		expect(lines).toContain("Trust floor: acknowledge required; maintainer dismissal needed.");
	});
});

describe("a refuted protected finding as a pull request shows it", () => {
	const gap: FindingInput = {
		...retriedCharge,
		rule: "untested-behaviour",
		message: "The test passes when the charge is sent twice.",
		source: { check: "lens.tests" },
	};
	const body = (severity: "P2" | "P3", config = defaultConfig) => {
		const verdict = new Adjudication({
			findings: [Finding.create({ ...gap, severity }).verifiedAs(judged("refuted", "Another test counts."))],
			manifest: [],
			checks: [{ name: "verifier", status: "ran" }],
			config,
			verificationRan: true,
		}).adjudicate();
		const findings = verdict.counted().map((finding) => ({ finding, placement: { kind: "body" as const } }));
		const draft = { pullRequest: 7, revision, base, round: 1, verdict, findings, stillOpen: 0, resolved: [], secret };
		return renderReviewBody({ ...draft, fingerprint: verdict.fingerprint() }, links);
	};

	it("posts an acknowledge floor with its status line, its note and the verifier's reason", () => {
		const text = body("P2");
		expect(text).toContain(
			"\u{1F7E1} P2 | \u{270B} Needs acknowledgement | \u{1F9EA} Tests | \u{2716}\u{FE0F} Refuted | New in this change\n",
		);
		expect(text).toContain("Trust floor: acknowledge required; maintainer dismissal needed.");
		expect(text).toContain("\u{2696}\u{FE0F} **Verifier:** Another test counts.");
	});

	it("posts an advisory floor as an advisory, with the note that asks no acknowledgement", () => {
		const text = body("P3");
		expect(text).toContain("- \u{1F535} P3 | \u{1F4AC} Advisory | \u{1F9EA} Tests | \u{2716}\u{FE0F} Refuted | ");
		const lines = text.split("\n");
		const entry = lines.findIndex((line) => line.startsWith("- \u{1F535} P3 | "));
		expect(lines.slice(entry + 1, entry + 3)).toEqual([
			"  \u{2696}\u{FE0F} **Verifier:** Another test counts.",
			"  Trust floor: reported-severity policy requires no acknowledgement.",
		]);
		expect(text).toContain("Trust floor: reported-severity policy requires no acknowledgement.");
		expect(text).not.toContain("acknowledge required");
	});

	it("keeps an ordinary advisory to one line", () => {
		const verdict = new Adjudication({
			findings: [
				Finding.create({ ...gap, rule: "docs-match-code", severity: "P3", source: { check: "lens.conventions" } }),
			],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const draft = {
			pullRequest: 7,
			revision,
			base,
			round: 1,
			verdict,
			findings: [],
			stillOpen: 0,
			resolved: [],
			secret,
		};
		const text = renderReviewBody({ ...draft, fingerprint: verdict.fingerprint() }, links);
		const lines = text.split("\n");
		const entry = lines.findIndex((line) => line.startsWith("- \u{1F535} P3 | "));
		expect(entry).toBeGreaterThan(0);
		expect(lines[entry + 1] ?? "").not.toMatch(/^ {2}/);
	});

	it("posts nothing of a silent floor", () => {
		const config = { ...defaultConfig, resolution: { ...defaultConfig.resolution, P2: "silent" as const } };
		const text = body("P2", config);
		expect(text).not.toContain("The test passes when the charge is sent twice.");
		expect(text).not.toContain("Trust floor");
	});
});

describe("a deterministic finding as a pull request shows it", () => {
	it("posts a blocking guardrail finding with only the parts it has", () => {
		const finding = decided({
			rule: "guardrail/forbidden-paths/no-secrets",
			message: "The change adds a file under secrets/.",
			file: "secrets/key.pem",
			startLine: 1,
			discriminator: "secrets/key.pem",
			cause: "introduced",
			severity: "P1",
			source: { check: "guardrails" },
			explanation: {
				what: "secrets/key.pem matches the forbidden path.",
				whyHere: "This change adds the file.",
				whatToDo: "Remove the file.",
			},
		});
		expect(comment(finding, false, { kind: "lines", startLine: 1, line: 1 })).toBe(
			[
				"P1 | Blocks merge | Guardrails: forbidden-paths | New in this change",
				"",
				"**The change adds a file under secrets/.**",
				"",
				"**What:** secrets/key.pem matches the forbidden path.",
				"",
				"**Why here:** This change adds the file.",
				"",
				"**What to do:** Remove the file.",
				"",
				`Rule \`guardrail/forbidden-paths/no-secrets\` | Finding \`${finding.id}\``,
			].join("\n"),
		);
	});

	it("posts a static finding with no verifier segment", () => {
		const finding = decided({
			rule: "TS2322",
			message: "Type 'string' is not assignable to type 'number'.",
			file: "src/total.ts",
			startLine: 9,
			discriminator: "TS2322",
			cause: "introduced",
			severity: "P1",
			source: { check: "static.tsc" },
			explanation: { what: "tsc reports TS2322.", whyHere: "The change introduced it.", whatToDo: "Fix the type." },
		});
		expect(comment(finding).split("\n")[0]).toBe(
			"\u{1F7E0} P1 | \u{26D4} Blocks merge | \u{1F9E9} tsc | New in this change",
		);
	});
});

describe("publish.emoji", () => {
	it("keeps the words and separators and drops every emoji when off", () => {
		const finding = decided(retriedCharge, judged("confirmed", "Traced."));
		const plain = comment(finding, false);
		expect(plain.split("\n")[0]).toBe("P1 | Blocks merge | Correctness | Verifier confirmed | New in this change");
		expect(plain).toContain("\n**Verifier:** Traced.\n");
		expect(plain).not.toMatch(/\p{Emoji_Presentation}|\u{FE0F}/u);
	});

	it("reaches an advisory in the review body, on by default and off when asked", () => {
		const advisory = decided({ ...retriedCharge, severity: "P3", evidence: undefined, failureScenario: undefined });
		const verdict = new Adjudication({
			findings: [advisory],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const draft = {
			pullRequest: 7,
			revision,
			base,
			fingerprint: verdict.fingerprint(),
			round: 1,
			verdict,
			findings: [],
			stillOpen: 0,
			resolved: [],
			secret,
		};
		expect(renderReviewBody(draft, links)).toContain("\n- \u{1F535} P3 | \u{1F4AC} Advisory | ");
		expect(renderReviewBody(draft, links, { emoji: false })).toContain("\n- P3 | Advisory | Correctness | ");
	});

	it.each([
		[undefined, "\u{1F7E0} P1 | \u{26D4} Blocks merge"],
		[true, "\u{1F7E0} P1 | \u{26D4} Blocks merge"],
		[false, "\nP1 | Blocks merge"],
	])("reaches every comment and the body a provider posts with emoji %s", async (emoji, status) => {
		const inlined = decided({
			...retriedCharge,
			file: "src/run.ts",
			startLine: 12,
			endLine: 12,
			evidence: undefined,
		});
		const outside = decided({ ...retriedCharge, file: "src/outside.ts", evidence: undefined });
		const verdict = new Adjudication({
			findings: [inlined, outside],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const state = fakeState(
			"melian-agent",
			"example",
			{ number: 7, title: "Change", base: { ref: "main", sha: base }, head: { ref: "feature", sha: revision } },
			{ "src/run.ts": [[12, 12]] },
		);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "t",
			fetch: fakeGitHub(state),
			...(emoji === undefined ? {} : { emoji }),
		});
		const [first, second] = verdict.findings.block;
		const placed = first!.properties.path === "src/run.ts" ? [first!, second!] : [second!, first!];
		await provider.postReview({
			pullRequest: 7,
			revision,
			base,
			fingerprint: verdict.fingerprint(),
			round: 1,
			verdict,
			findings: [
				{ finding: placed[0]!, placement: { kind: "lines", startLine: 12, line: 12 } },
				{ finding: placed[1]!, placement: { kind: "body" } },
			],
			stillOpen: 0,
			resolved: [],
			secret,
		});
		expect(state.comments.map((each) => each.body.includes(status))).toEqual([true]);
		expect(state.reviews[0]!.body).toContain(status);
	});

	it("reaches the body a provider posts when GitHub refuses its inline comments", async () => {
		const inlined = decided({
			...retriedCharge,
			file: "src/run.ts",
			startLine: 12,
			endLine: 12,
			evidence: undefined,
		});
		const verdict = new Adjudication({
			findings: [inlined],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const state = fakeState(
			"melian-agent",
			"example",
			{ number: 7, title: "Change", base: { ref: "main", sha: base }, head: { ref: "feature", sha: revision } },
			{},
		);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "t",
			fetch: fakeGitHub(state),
			emoji: false,
		});
		await provider.postReview({
			pullRequest: 7,
			revision,
			base,
			fingerprint: verdict.fingerprint(),
			round: 1,
			verdict,
			findings: [{ finding: verdict.findings.block[0]!, placement: { kind: "lines", startLine: 12, line: 12 } }],
			stillOpen: 0,
			resolved: [],
			secret,
		});
		const body = state.reviews[0]!.body;
		expect(body).toContain("GitHub refused this review's inline comments");
		expect(body).toContain("\nP1 | Blocks merge | Correctness | Not verified | New in this change\n");
		expect(body).not.toMatch(/\p{Emoji_Presentation}|\u{FE0F}/u);
	});
});
