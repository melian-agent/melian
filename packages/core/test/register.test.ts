import {
	Adjudication,
	defaultConfig,
	Finding,
	type FindingInput,
	Rendering,
	type Verification,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";

// The guideline's worked examples, in the terminal. Each expected text is written by hand from
// docs/guidelines/findings.md, never from what the renderer printed.

const judged = (verdict: Verification["verdict"], reason: string): Verification => ({
	verdict,
	reason,
	executor: "llm",
	model: "faux/judge",
	version: "1",
});

function decided(
	input: FindingInput,
	verification?: Verification,
	checks = [{ name: "verifier", status: "ran" as const }],
) {
	const finding = Finding.create(input);
	const verdict = new Adjudication({
		findings: [verification === undefined ? finding : finding.verifiedAs(verification)],
		manifest: [],
		checks,
		config: defaultConfig,
		verificationRan: verification !== undefined,
	}).adjudicate();
	return verdict.all().find((each) => each.ruleId === input.rule)!;
}

const emoji = new Rendering({ emoji: true, ids: true });
const plain = new Rendering({ ids: true });

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
		what: "`submitPayment` creates a new payment intent on every attempt, and `chargeCard` sends no idempotency key.",
		whyHere:
			"At the base, `submitPayment` reused the open intent through `findOpenIntent`. This change removes that call.",
		whatToDo:
			"Restore `findOpenIntent`, or pass the intent ID as the idempotency key. Add a test that times out the first charge and asserts one charge in all.",
	},
};

describe("a finding in the terminal, in the register", () => {
	it("renders a confirmed P1 with its seven parts and the headline once", () => {
		const finding = decided(retriedCharge, judged("confirmed", "The second call creates a new intent."));
		expect(finding.render(emoji)).toBe(
			[
				"  \u{1F7E0} P1 | \u{26D4} Blocks merge | \u{1F3AF} Correctness | \u{2705} Verifier confirmed | New in this change",
				"  Lines 31-44: A retry after a lost response charges the card twice.",
				"    What: `submitPayment` creates a new payment intent on every attempt, and `chargeCard` sends no idempotency key.",
				"    Why here: At the base, `submitPayment` reused the open intent through `findOpenIntent`. This change removes that call.",
				"    Failure scenario: The processor accepts a $40 charge, and the response times out. The customer presses Pay again. A second intent and a second $40 charge follow.",
				"    Evidence:",
				"      cause: payments/submit.ts:31-44",
				"        x",
				"      context: payments/submit.ts:28-35 at base",
				"        y",
				"    \u{2696}\u{FE0F} Verifier (faux/judge): The second call creates a new intent.",
				"    What to do: Restore `findOpenIntent`, or pass the intent ID as the idempotency key. Add a test that times out the first charge and asserts one charge in all.",
				`    Rule payment-idempotency | Status new | Finding ${finding.id}`,
			].join("\n"),
		);
	});

	it("renders a plausible P2 whose message repeats What, printing that sentence once", () => {
		const what = "`saveRecord` calls `cache.set` without a `catch`, while `readRecord` beside it returns `null`.";
		const finding = decided(
			{
				...retriedCharge,
				rule: "degrade-on-cache-failure",
				message: what,
				severity: "P2",
				file: "sync/save.ts",
				startLine: 18,
				endLine: 18,
				evidence: undefined,
				failureScenario:
					"The cache is down. `cache.set` rejects, the rejection leaves `syncItems`, and no item syncs.",
				explanation: {
					what,
					whyHere: 'The description says "a cache outage never stops a sync". This new write does not keep it.',
					whatToDo: "Catch and log the error, as `readRecord` does.",
				},
			},
			judged("plausible", "It did not read the cache client, which may swallow write errors itself."),
		);
		const text = finding.render(plain);
		expect(text.split("\n").slice(0, 6)).toEqual([
			"  P2 | Needs acknowledgement | Correctness | Verifier plausible | New in this change",
			`  Line 18: ${what}`,
			'    Why here: The description says "a cache outage never stops a sync". This new write does not keep it.',
			"    Failure scenario: The cache is down. `cache.set` rejects, the rejection leaves `syncItems`, and no item syncs.",
			"    Verifier (faux/judge): It did not read the cache client, which may swallow write errors itself.",
			"    What to do: Catch and log the error, as `readRecord` does.",
		]);
		expect(text.split(what)).toHaveLength(2);
		expect(text).not.toContain("Evidence:");
	});

	it("renders an unverified P3 advisory from the conventions lens", () => {
		const finding = decided({
			...retriedCharge,
			rule: "docs-match-code",
			message: "The guide says half-hour slots; the list builds quarter-hours.",
			severity: "P3",
			source: { check: "lens.conventions" },
			evidence: undefined,
			failureScenario: undefined,
		});
		expect(finding.render(emoji).split("\n").slice(0, 2)).toEqual([
			"  \u{1F535} P3 | \u{1F4AC} Advisory | \u{1F4CF} Conventions | \u{2754} Not verified | New in this change",
			"  Lines 31-44: The guide says half-hour slots; the list builds quarter-hours.",
		]);
	});

	it("renders a test gap from the tests lens", () => {
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
		expect(finding.render(emoji).split("\n")[0]).toBe(
			"  \u{1F7E1} P2 | \u{270B} Needs acknowledgement | \u{1F9EA} Tests | \u{2705} Verifier confirmed | New in this change",
		);
	});

	const injection: FindingInput = {
		...retriedCharge,
		rule: "melian/injection-attempt",
		message: "A comment in this change tells reviewers to report nothing.",
		file: "auth/session.ts",
		startLine: 3,
		endLine: 3,
		source: { check: "lens.trust-boundary" },
		failureScenario: undefined,
		evidence: [{ file: "auth/session.ts", startLine: 3, role: "cause", revision: "head", snippet: "z" }],
	};

	it("renders a confirmed injection attempt at P1 from the trust-boundary lens", () => {
		const finding = decided(injection, judged("confirmed", "Line 3 addresses reviewers."));
		expect(finding.render(emoji).split("\n")[0]).toBe(
			"  \u{1F7E0} P1 | \u{26D4} Blocks merge | \u{1F6E1}\u{FE0F} Trust boundary | \u{2705} Verifier confirmed | New in this change",
		);
	});

	it("posts a wholly refuted injection attempt at its trust floor, with its obligation and the verifier's reason", () => {
		const finding = decided(injection, judged("refuted", "The comment is documentation."));
		expect(finding.properties.resolution).toBe("acknowledge");
		const lines = finding.render(emoji).split("\n");
		expect(lines[0]).toBe(
			"  \u{1F7E0} P1 | \u{270B} Needs acknowledgement | \u{1F6E1}\u{FE0F} Trust boundary | \u{2716}\u{FE0F} Refuted | New in this change",
		);
		expect(lines).toContain("    \u{2696}\u{FE0F} Verifier (faux/judge): The comment is documentation.");
		expect(lines).toContain("    Trust floor: acknowledge required; maintainer dismissal needed.");
	});
});

describe("a refuted protected finding in the terminal", () => {
	const gap: FindingInput = {
		...retriedCharge,
		rule: "untested-behaviour",
		message: "The test passes when the charge is sent twice.",
		source: { check: "lens.tests" },
	};
	const refuted = judged("refuted", "Another test counts the calls.");
	const verdict = (input: FindingInput, config = defaultConfig) =>
		new Adjudication({
			findings: [Finding.create(input).verifiedAs(refuted)],
			manifest: [],
			checks: [{ name: "verifier", status: "ran" }],
			config,
			verificationRan: true,
		}).adjudicate();

	it("shows a P2 test gap at its acknowledge floor, with that floor's note", () => {
		const shown = verdict({ ...gap, severity: "P2" });
		const [finding] = shown.findings.acknowledge;
		const lines = finding!.render(emoji).split("\n");
		expect(lines[0]).toBe(
			"  \u{1F7E1} P2 | \u{270B} Needs acknowledgement | \u{1F9EA} Tests | \u{2716}\u{FE0F} Refuted | New in this change",
		);
		expect(lines).toContain("    Trust floor: acknowledge required; maintainer dismissal needed.");
		expect(lines).toContain("    \u{2696}\u{FE0F} Verifier (faux/judge): Another test counts the calls.");
	});

	it("shows a P3 test gap at its advisory floor, with the note that asks no acknowledgement", () => {
		const shown = verdict({ ...gap, severity: "P3" });
		const [finding] = shown.findings.advisory;
		const lines = finding!.render(plain).split("\n");
		expect(lines[0]).toBe("  P3 | Advisory | Tests | Refuted | New in this change");
		expect(lines).toContain("    Trust floor: reported-severity policy requires no acknowledgement.");
		expect(lines).not.toContain("    Trust floor: acknowledge required; maintainer dismissal needed.");
	});

	it("hides a test gap whose floor is silent", () => {
		const config = { ...defaultConfig, resolution: { ...defaultConfig.resolution, P2: "silent" as const } };
		const hidden = verdict({ ...gap, severity: "P2" }, config);
		expect(hidden.counted()).toEqual([]);
		expect(hidden.render()).not.toContain("The test passes when the charge is sent twice.");
	});
});

describe("a deterministic finding in the terminal", () => {
	it("renders a static finding with only the parts it has and no verifier segment", () => {
		const finding = decided(
			{
				rule: "TS2322",
				message: "Type 'string' is not assignable to type 'number'.",
				file: "src/total.ts",
				startLine: 9,
				discriminator: "TS2322",
				cause: "introduced",
				severity: "P1",
				source: { check: "static.tsc" },
				explanation: {
					what: "tsc reports TS2322 here.",
					whyHere: "The change introduced this diagnostic.",
					whatToDo: "Fix the type error.",
				},
			},
			undefined,
			[],
		);
		expect(finding.render(emoji)).toBe(
			[
				"  \u{1F7E0} P1 | \u{26D4} Blocks merge | \u{1F9E9} tsc | New in this change",
				"  Line 9: Type 'string' is not assignable to type 'number'.",
				"    What: tsc reports TS2322 here.",
				"    Why here: The change introduced this diagnostic.",
				"    What to do: Fix the type error.",
				`    Rule TS2322 | Status new | Finding ${finding.id}`,
			].join("\n"),
		);
	});

	it("renders a blocking guardrail finding under the guardrail its rule names", () => {
		const finding = decided(
			{
				rule: "guardrail/forbidden-paths/no-secrets",
				message: "The change adds a file under secrets/.",
				file: "secrets/key.pem",
				startLine: 1,
				discriminator: "secrets/key.pem",
				cause: "introduced",
				severity: "P1",
				source: { check: "guardrails" },
				explanation: {
					what: "secrets/key.pem matches the forbidden path secrets/**.",
					whyHere: "This change adds the file.",
					whatToDo: "Remove the file.",
				},
			},
			undefined,
			[],
		);
		const text = finding.render(plain);
		expect(text.split("\n").slice(0, 2)).toEqual([
			"  P1 | Blocks merge | Guardrails: forbidden-paths | New in this change",
			"  Line 1: The change adds a file under secrets/.",
		]);
		expect(text).not.toMatch(/Failure scenario|Evidence|Verifier/);
	});

	it("says a pre-existing finding predates the change, and an affected one that the change caused it", () => {
		const base = { ...retriedCharge, evidence: undefined, failureScenario: undefined };
		expect(
			decided({ ...base, cause: "pre-existing" })
				.render(plain)
				.split("\n")[0],
		).toBe("  P1 | Advisory | Correctness | Not verified | Predates this change");
		expect(
			Finding.create({ ...retriedCharge, cause: "affected", resolution: undefined })
				.render(plain)
				.split("\n")[0],
		).toBe("  P1 | Unresolved | Correctness | Not verified | Caused by this change");
	});
});

// Rows of the guideline's table of what today's renderers print, each kept in its place in the register.
describe("the register keeps every element the terminal printed", () => {
	const lowering = {
		...judged("confirmed", "One caller reaches it."),
		lowered: { from: "P1" as const, to: "P2" as const, reason: "Only the admin path reaches it." },
	};

	it("lowering: ordinary, reason once, after the verifier's line", () => {
		const finding = decided(retriedCharge, lowering);
		const lines = finding.render(emoji).split("\n");
		expect(lines[0]).toBe(
			"  \u{1F7E1} P2, lowered from P1 | \u{270B} Needs acknowledgement | \u{1F3AF} Correctness | \u{2705} Verifier confirmed | New in this change",
		);
		const verifier = lines.indexOf("    \u{2696}\u{FE0F} Verifier (faux/judge): One caller reaches it.");
		expect(lines[verifier + 1]).toBe("    Lowered from P1: Only the admin path reaches it.");
		expect(finding.render(emoji).split("Only the admin path reaches it.")).toHaveLength(2);
	});

	it("lowering: protected, reason once, inside the floor note", () => {
		const finding = decided(
			{ ...retriedCharge, rule: "untested-behaviour", source: { check: "lens.tests" } },
			lowering,
		);
		const text = finding.render(plain);
		expect(text.split("\n")[0]).toMatch(/^ {2}P2, lowered from P1 \| /);
		expect(text).not.toContain("Lowered from P1:");
		expect(text.split("Only the admin path reaches it.")).toHaveLength(2);
		const lines = text.split("\n");
		expect(lines.findIndex((line) => line.startsWith("    Trust floor:"))).toBeLessThan(
			lines.findIndex((line) => line.startsWith("    What to do:")),
		);
	});

	it("terminal: resolved at original, after the lowering line", () => {
		const lowered = Finding.create({ ...retriedCharge, resolution: "block" }).verifiedAs(lowering);
		const stored = lowered.toJSON();
		const held = Finding.from({ ...stored, properties: { ...stored.properties, resolvedAtOriginal: true } });
		const lines = held.render(plain).split("\n");
		const at = lines.indexOf("    Lowered from P1: Only the admin path reaches it.");
		expect(lines[at + 1]).toBe(
			"    Resolved at P1: the table in force resolves P2 silent, and a lowering never silences a finding.",
		);
	});

	it("terminal and comment: merged and dismissed reports under the footer, each check with its emoji", () => {
		const speaker = Finding.create(retriedCharge);
		const merged = Finding.create({
			...retriedCharge,
			rule: "double-charge",
			severity: "P2",
			source: { check: "lens.contracts" },
		});
		const answered = Finding.create({
			...retriedCharge,
			rule: "unsafe-call",
			severity: "P3",
			source: { check: "static.biome" },
			status: "dismissed",
		});
		const verdict = new Adjudication({
			manifest: [],
			checks: [],
			config: defaultConfig,
			findings: [speaker, merged, answered],
		}).adjudicate();
		const shown = verdict.all().find((each) => each.ruleId === "payment-idempotency")!;
		const lines = shown.render(emoji).split("\n");
		const footer = lines.findIndex((line) => line.startsWith("    Rule payment-idempotency | "));
		expect(lines.slice(footer + 1)).toEqual([
			`    Merged report: P2 double-charge from \u{1F91D} lens.contracts  ${merged.id}`,
			`    Also reported, dismissed: P3 unsafe-call from \u{1F9F9} static.biome  ${answered.id}`,
		]);
	});

	it("terminal: colour and plain, the colour around the severity segment and its emoji", () => {
		const finding = decided(retriedCharge);
		const coloured = finding.render(new Rendering({ color: true, emoji: true })).split("\n")[0];
		expect(coloured).toBe(
			"  \u001b[31m\u{1F7E0} P1\u001b[0m | \u{26D4} Blocks merge | \u{1F3AF} Correctness | \u{2754} Not verified | New in this change",
		);
		expect(finding.render(plain)).not.toContain("\u001b[");
	});

	it("json unchanged: a verdict's JSON carries no emoji", () => {
		const verdict = new Adjudication({
			findings: [Finding.create(retriedCharge)],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		expect(verdict.renderJson()).not.toMatch(/\p{Emoji_Presentation}|\u{FE0F}/u);
	});

	it("escaping: a lens name and a headline from the change stay visible text in the status line and headline", () => {
		const finding = Finding.create({
			...retriedCharge,
			message: "Charges twice\u001b[2J",
			source: { check: "lens.x\u001b[31m" },
		});
		const lines = finding.render(emoji).split("\n");
		expect(lines[0]).toContain(" | \u{1F50E} x\\u001b[31m | ");
		expect(lines[1]).toBe("  Lines 31-44: Charges twice\\u001b[2J");
	});

	it("merged reports: no emoji when emojis are off, and no severity a stored report lacks", () => {
		const stored = Finding.create(retriedCharge).toJSON();
		const legacy = Finding.from({
			...stored,
			properties: {
				...stored.properties,
				alsoReportedAs: [{ id: "0123456789abcdef", ruleId: "double-charge", check: "lens.contracts" }],
			},
		});
		expect(legacy.render(plain).split("\n").at(-1)).toBe(
			"    Merged report: double-charge from lens.contracts  0123456789abcdef",
		);
		const unknown = Finding.from({
			...stored,
			properties: {
				...stored.properties,
				alsoReportedAs: [{ id: "0123456789abcdef", ruleId: "q", check: "decisions.fast", severity: "P3" }],
			},
		});
		expect(unknown.render(emoji).split("\n").at(-1)).toBe(
			"    Merged report: P3 q from decisions.fast  0123456789abcdef",
		);
	});

	it("trust floor: a note's later lines sit inside the finding", () => {
		const finding = decided(
			{ ...retriedCharge, rule: "untested-behaviour", source: { check: "lens.tests" } },
			{ ...lowering, lowered: { ...lowering.lowered, reason: "Only the admin path.\nNothing else." } },
		);
		expect(finding.render(plain)).toContain("Only the admin path.\n      Nothing else.");
	});
});
