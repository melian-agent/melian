import {
	Adjudication,
	Changeset,
	defaultConfig,
	type FileResolution,
	Finding,
	type FindingInput,
	Lowering,
	Rendering,
	type Verification,
	VerificationState,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

const input: FindingInput = {
	rule: "fail-open",
	message: "A cold run can reuse a planted kill.",
	file: "packages/pipeline/src/mutation-static.ts",
	startLine: 423,
	snippet: "incremental: true",
	occurrence: 0,
	cause: "introduced",
	severity: "P2",
	source: { check: "lens.trust-boundary", version: "1@careful" },
	failureScenario: "The head's Vitest configuration plants a killed mutant before Stryker reads its incremental file.",
	evidence: [
		{
			file: "packages/pipeline/src/mutation-static.ts",
			startLine: 423,
			role: "cause",
			revision: "head",
			snippet: "incremental: true",
		},
	],
	explanation: {
		what: "A cold run can reuse a planted kill.",
		whyHere: "The head's configuration runs before Stryker reads the file.",
		whatToDo: "Force Stryker to rerun every mutant on a cold run.",
	},
};
const plausible: Verification = {
	verdict: "plausible",
	reason: "Melian stages no incremental file, but the head may plant one.",
	executor: "llm",
	model: "faux/judge",
	version: "1",
	evidence: input.evidence,
};
const lowered: Verification = {
	...plausible,
	lowered: { from: "P2", to: "P3", reason: "The plant needs hostile Vitest configuration." },
};
const refuted: Verification = {
	...plausible,
	verdict: "refuted",
	reason: "The verifier believes staging prevents it.",
};
const report = (overrides: Partial<FindingInput> = {}, judgement: Verification = lowered) =>
	Finding.create({ ...input, ...overrides }).verifiedAs(judgement);

describe("step 29: lowered and refuted trust objections", () => {
	it("retains the P2 to P3 plausible cold-run objection from pull request 125 at acknowledge", () => {
		expect(
			new Lowering({
				from: "P2",
				to: "P3",
				verdict: "plausible",
				rule: input.rule,
				coReported: false,
				silent: Finding.create(input).silentAt(defaultConfig),
				evidence: 1,
				executor: "llm",
			}).refusal(),
		).toBeUndefined();
		const finding = report().resolved(defaultConfig);
		expect(finding.properties).toMatchObject({
			severity: "P3",
			originalSeverity: "P2",
			verification: lowered,
			resolution: "acknowledge",
			decidedBy: { floor: "lowered-trust" },
		});
	});

	it.each(["confirmed", "plausible"] as const)("holds the floor for a %s lowering", (verdict) => {
		expect(report({}, { ...lowered, verdict }).resolve(defaultConfig)).toBe("acknowledge");
	});

	it.each(["introduced", "pre-existing", "affected"] as const)("respects the %s cap", (cause) => {
		expect(report({ cause }).resolve(defaultConfig)).toBe(cause === "pre-existing" ? "advisory" : "acknowledge");
	});

	it.each(["advisory", "silent"] as const)("respects a %s check ceiling", (ceiling) => {
		const config = {
			resolution: { ...defaultConfig.resolution, checks: { "lens.trust-boundary": { ceiling } } },
		};
		expect(report().resolve(config)).toBe(ceiling);
	});

	it("holds a P1 lowered to P2 above a lenient P2 mapping", () => {
		const finding = report(
			{ severity: "P1" },
			{ ...plausible, lowered: { from: "P1", to: "P2", reason: "Narrow." } },
		);
		expect(finding.resolve({ resolution: { ...defaultConfig.resolution, P2: "advisory" } })).toBe("acknowledge");
	});

	it("keeps a stricter requirement", () => {
		expect(report().resolve({ resolution: { ...defaultConfig.resolution, P3: "block" } })).toBe("block");
	});

	it("leaves a standing unlowered trust P3 advisory", () => {
		const finding = report({ severity: "P3" }, plausible).resolved(defaultConfig);
		expect(finding.properties.resolution).toBe("advisory");
		expect(finding.properties.decidedBy?.trustFloor).toBeUndefined();
	});

	it("leaves a lowered correctness finding advisory", () => {
		expect(report({ source: { check: "lens.correctness" } }).resolve(defaultConfig)).toBe("advisory");
	});

	it("does not pair one sighting's lowering with another sighting's trust label", () => {
		const trust = report({ severity: "P3" }, plausible);
		const correctness = report({ source: { check: "lens.correctness" } });
		const speaker = Finding.from({
			...correctness.toJSON(),
			properties: {
				...correctness.properties,
				...correctness.mergeClaims([correctness, trust]),
				reportedBy: [correctness.properties.source, trust.properties.source],
			},
		});
		expect(speaker.resolve(defaultConfig)).toBe("advisory");
	});

	it("retains a protected refutation in the counted acknowledgement group", () => {
		const finding = report({}, refuted);
		const verdict = new Adjudication({
			findings: [finding],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.findings.acknowledge.map((item) => item.id)).toEqual([finding.id]);
		expect(verdict.refuted ?? []).toEqual([]);
		expect(verdict.counted()).toHaveLength(1);
		expect(verdict.verificationCounts().refuted).toBe(1);
	});

	it("does not retain a refuted P1's blocking requirement", () => {
		const finding = report({ severity: "P1" }, refuted);
		const verdict = new Adjudication({
			findings: [finding],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.findings.acknowledge[0]?.properties.decidedBy).toMatchObject({ floor: "refuted-trust" });
		expect(verdict.blocking).toBe(false);
	});

	it("leaves an ordinary refutation in the refuted group", () => {
		const finding = report({ source: { check: "lens.correctness" } }, refuted);
		const verdict = new Adjudication({
			findings: [finding],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.refuted?.map((item) => item.id)).toEqual([finding.id]);
		expect(verdict.counted()).toEqual([]);
	});

	it("holds a merged non-speaking trust claim after a refutation", () => {
		const trust = report({}, refuted);
		const correctness = report(
			{ rule: "unhandled-error", source: { check: "lens.correctness" }, severity: "P3" },
			plausible,
		);
		for (const findings of [
			[trust, correctness],
			[correctness, trust],
		]) {
			const config = { ...defaultConfig, ruleAliases: { "unhandled-error": ["fail-open"] } };
			const verdict = new Adjudication({ findings, config, manifest: [], checks: [] }).adjudicate();
			expect(verdict.all()).toHaveLength(1);
			expect(verdict.all()[0]?.id).toBe(correctness.id);
			expect(verdict.findings.acknowledge).toHaveLength(1);
		}
	});

	it("holds a merged lowered trust member whichever rule owns the speaker", () => {
		const trust = report();
		const correctness = report(
			{ rule: "unhandled-error", source: { check: "lens.correctness" }, severity: "P3" },
			plausible,
		);
		const owners: Record<string, string[]>[] = [
			{ "unhandled-error": ["fail-open"] },
			{ "fail-open": ["unhandled-error"] },
		];
		for (const ruleAliases of owners) {
			const config = { ...defaultConfig, ruleAliases };
			const verdict = new Adjudication({
				findings: [correctness, trust],
				config,
				manifest: [],
				checks: [],
			}).adjudicate();
			expect(verdict.all()).toHaveLength(1);
			expect(verdict.findings.acknowledge).toHaveLength(1);
		}
	});

	it("does not let a dismissed trust report floor a live ordinary report", () => {
		const sighting = report();
		const trust = Finding.from({
			...sighting.toJSON(),
			properties: {
				...sighting.properties,
				status: "dismissed",
				dismissal: { by: "Maintainer", reason: "Probe disproves it.", at: "2026-10-17T00:00:00Z" },
			},
		});
		const correctness = report(
			{ rule: "unhandled-error", source: { check: "lens.correctness" }, severity: "P3" },
			plausible,
		);
		const verdict = new Adjudication({
			findings: [trust, correctness],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.findings.acknowledge).toEqual([]);
		expect(verdict.findings.advisory.map((item) => item.id)).toEqual([correctness.id]);
		expect(verdict.dismissed.map((item) => item.id)).toEqual([trust.id]);
	});

	it("shows the lowering and the floor without opting into decision details", () => {
		const text = report().resolved(defaultConfig).render(new Rendering());
		expect(text).toContain("lowered from P2");
		expect(text).toContain("The plant needs hostile Vitest configuration.");
		expect(text).toContain("Trust floor: acknowledge required; maintainer dismissal needed.");
	});
	it("keeps an unjudged protected claim at the existing cap", () => {
		const finding = Finding.create(input);
		const verdict = new Adjudication({
			findings: [finding],
			config: defaultConfig,
			manifest: [],
			checks: [],
			verificationRan: true,
		}).adjudicate();
		expect(verdict.findings.advisory[0]?.properties.decidedBy?.trustFloor).toBeUndefined();
		expect(verdict.findings.advisory.map((each) => each.id)).toEqual([finding.id]);
	});
	it("keeps a standing blocker beside a protected refutation", () => {
		const trust = report({}, refuted);
		const blocker = report(
			{ rule: "unhandled-error", severity: "P0", source: { check: "lens.correctness" } },
			plausible,
		);
		const verdict = new Adjudication({
			findings: [trust, blocker],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.findings.block).toHaveLength(1);
		expect(verdict.counted()).toHaveLength(1);
		expect(verdict.findings.block[0]?.properties.decidedBy?.trustFloor).toHaveLength(1);
	});
	it("uses each sighting's reported severity after merging", () => {
		const trust = report({ severity: "P3" }, refuted);
		const correctness = report({ source: { check: "lens.correctness" }, severity: "P1" }, refuted);
		const merged = Finding.from({
			...correctness.toJSON(),
			properties: {
				...correctness.properties,
				...correctness.mergeClaims([correctness, trust]),
				reportedBy: [correctness.properties.source, trust.properties.source],
			},
		});
		const verdict = new Adjudication({
			findings: [merged],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.findings.advisory[0]?.properties.decidedBy?.trustFloor).toMatchObject([
			{ severity: "P3", minimum: "advisory" },
		]);
		expect(verdict.findings.acknowledge).toEqual([]);
	});
	it("preserves the winning sighting's severity beside a refuted stronger sighting", () => {
		const trust = report();
		const correctness = report({ severity: "P1", source: { check: "lens.correctness" } }, refuted);
		const merged = Finding.from({
			...trust.toJSON(),
			properties: {
				...trust.properties,
				...trust.mergeClaims([trust, correctness]),
				originalSeverity: "P1",
				reportedBy: [trust.properties.source, correctness.properties.source],
			},
		});
		const config = { ...defaultConfig, resolution: { ...defaultConfig.resolution, P2: "advisory" as const } };
		const verdict = new Adjudication({ findings: [merged], config, manifest: [], checks: [] }).adjudicate();
		expect(verdict.findings.advisory[0]?.properties.decidedBy?.trustFloor).toMatchObject([
			{ severity: "P2", minimum: "advisory" },
		]);
		expect(verdict.findings.acknowledge).toEqual([]);
	});
	it.each([true, false])("reads legacy claim severity without inventing it (lowered: %s)", (lowering) => {
		const finding = report({}, lowering ? lowered : refuted);
		const { severity: _, ...claim } = finding.claims()[0]!;
		const legacy = Finding.from({ ...finding.toJSON(), properties: { ...finding.properties, otherClaims: [claim] } });
		expect(legacy.trustFloor(defaultConfig)).toMatchObject([
			{ severity: "P2", action: lowering ? "lowered" : "refuted" },
		]);
	});
	it("respects the unproved affected cap", () => {
		const sighting = report();
		const finding = Finding.from({
			...sighting.toJSON(),
			properties: {
				...sighting.properties,
				cause: "affected",
				evidence: input.evidence!.map((each) => ({ ...each, role: "context" as const })),
			},
		});
		expect(finding.resolve(defaultConfig)).toBe("advisory");
	});
	it("uses the reporting lens variant's default", () => {
		const config = {
			resolution: defaultConfig.resolution,
			layers: [],
			lensDefaults: { "trust-boundary": { P2: "block" as const } },
			lensVariants: { "trust-boundary@1@careful": { ceiling: "advisory" as const } },
		};
		expect(report().resolve(config)).toBe("advisory");
	});
	it("keeps a non-lens untested-behaviour out of the protected set", () => {
		expect(
			report({ rule: "untested-behaviour", source: { check: "static.tests" } }).trustFloor(defaultConfig),
		).toEqual([]);
	});
	it("resolves a protected refuted P1 directly at acknowledge", () => {
		expect(report({ severity: "P1" }, refuted).resolve(defaultConfig)).toBe("acknowledge");
	});
	it("renders a non-speaking member's lowering target and reason", () => {
		const trust = report();
		const ordinary = report(
			{ rule: "unhandled-error", severity: "P3", source: { check: "lens.correctness" } },
			plausible,
		);
		const verdict = new Adjudication({
			findings: [trust, ordinary],
			config: { ...defaultConfig, ruleAliases: { "unhandled-error": ["fail-open"] } },
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.render()).toContain("Lowered from P2 to P3: The plant needs hostile Vitest configuration.");
	});
	it("reads the original report's policy instead of the speaker's", () => {
		const trust = report();
		const ordinary = report(
			{ rule: "unhandled-error", severity: "P3", source: { check: "lens.correctness" } },
			plausible,
		);
		const config = (_path: string, rule?: string) => ({
			...defaultConfig,
			ruleAliases: { "unhandled-error": ["fail-open"] },
			resolution: {
				...defaultConfig.resolution,
				P2: rule === "unhandled-error" ? ("advisory" as const) : ("acknowledge" as const),
			},
		});
		const verdict = new Adjudication({ findings: [trust, ordinary], config, manifest: [], checks: [] }).adjudicate();
		expect(verdict.findings.acknowledge).toHaveLength(1);
		expect(verdict.findings.acknowledge[0]?.id).toBe(ordinary.id);
	});
	it("uses the merged cause for each original counterpart's cap", () => {
		const trust = report({ cause: "pre-existing" });
		const ordinary = report(
			{ rule: "unhandled-error", severity: "P3", source: { check: "lens.correctness" } },
			plausible,
		);
		const verdict = new Adjudication({
			findings: [trust, ordinary],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.findings.acknowledge).toHaveLength(1);
	});
	it.each(["P0", "P1"] as const)(
		"keeps a silent introduced defect silent after refuting its pre-existing %s claim",
		(severity) => {
			const trust = Finding.create({ ...input, cause: "pre-existing", severity });
			const ordinary = report(
				{ rule: "unhandled-error", severity: "P3", source: { check: "lens.correctness" } },
				plausible,
			);
			const config = {
				...defaultConfig,
				resolution: { ...defaultConfig.resolution, [severity]: "silent" as const, P3: "silent" as const },
			};
			const unjudged = new Adjudication({
				findings: [trust, ordinary],
				config,
				manifest: [],
				checks: [],
			}).adjudicate();
			const judged = new Adjudication({
				findings: [trust.verifiedAs(refuted), ordinary],
				config,
				manifest: [],
				checks: [],
			}).adjudicate();
			expect(unjudged.findings.silent).toHaveLength(1);
			expect(unjudged.findings.silent[0]?.properties.cause).toBe("introduced");
			expect(unjudged.status).toBe("passed");
			expect(judged.status).toBe(unjudged.status);
			expect(judged.findings.silent[0]?.properties.decidedBy?.trustFloor).toMatchObject([
				{ id: trust.id, minimum: "silent" },
			]);
			expect(judged.findings.silent.map((finding) => finding.id)).toEqual(
				unjudged.findings.silent.map((finding) => finding.id),
			);
			expect(judged.findings.advisory).toEqual([]);
		},
	);
	it("keeps a legacy sighting's lowering source ahead of the merged original severity", () => {
		const finding = report();
		const { severity: _, ...claim } = finding.claims()[0]!;
		const legacy = Finding.from({
			...finding.toJSON(),
			properties: { ...finding.properties, originalSeverity: "P1", otherClaims: [claim] },
		});
		expect(legacy.trustFloor(defaultConfig)).toMatchObject([{ severity: "P2" }]);
	});
	it("counts a protected minimum even when the important-pre-existing floor already met it", () => {
		const finding = report({ cause: "pre-existing", severity: "P1" }, refuted);
		const config = { ...defaultConfig, resolution: { ...defaultConfig.resolution, P1: "silent" as const } };
		const verdict = new Adjudication({ findings: [finding], config, manifest: [], checks: [] }).adjudicate();
		expect(verdict.counted().map((each) => each.id)).toEqual([finding.id]);
		expect(finding.lifted(config)).toBe(false);
		expect(verdict.status).toBe("findings");
		expect(verdict.preExistingImportant).toMatchObject([{ id: finding.id, originalSeverity: "P1" }]);
	});
	it("keeps a display-only important lift when a merged protected minimum is silent", () => {
		const trust = report({ cause: "pre-existing" }, refuted);
		const ordinary = report(
			{ cause: "pre-existing", severity: "P1", rule: "unhandled-error", source: { check: "lens.correctness" } },
			plausible,
		);
		const config = {
			...defaultConfig,
			ruleAliases: { "unhandled-error": ["fail-open"] },
			resolution: { ...defaultConfig.resolution, P1: "silent" as const, P2: "silent" as const },
		};
		const verdict = new Adjudication({ findings: [trust, ordinary], config, manifest: [], checks: [] }).adjudicate();
		expect(verdict.findings.advisory).toHaveLength(1);
		expect(verdict.findings.advisory[0]!.lifted(config)).toBe(true);
		expect(verdict.counted()).toEqual([]);
		expect(verdict.status).toBe("passed");
	});
	it.each([lowered, refuted])("names the deciding floor for $verdict in decision details", (judgement) => {
		const finding = report({}, judgement).resolved(defaultConfig);
		expect(Finding.parse(finding).properties.decidedBy?.trustFloor).toHaveLength(1);
		expect(finding.render(new Rendering({ decided: true }))).toContain(
			`held for a maintainer after a protected ${judgement.verdict === "refuted" ? "refutation" : "lowering"}`,
		);
	});
	it("rejects an empty stored trust-floor diagnostic list", () => {
		const finding = report().resolved(defaultConfig);
		expect(() =>
			Finding.parse({
				...finding.toJSON(),
				properties: { ...finding.properties, decidedBy: { ...finding.properties.decidedBy, trustFloor: [] } },
			}),
		).toThrow();
	});
	it("keeps reported severity in the domain claim and out of verifier transport", () => {
		const state = VerificationState.from(report());
		expect(state.claims[0]?.severity).toBe("P2");
		expect(state.toJSON().claims[0]).not.toHaveProperty("severity");
	});
	it("deduplicates diagnostics and sorts them independently of the input", () => {
		const a = report();
		const b = report({ rule: "vacuous-test", source: { check: "lens.tests" } }, refuted);
		const claims = [...a.trustFloor(defaultConfig), ...b.trustFloor(defaultConfig)];
		const forward = a.floored(a.capped(defaultConfig), [], [...claims, ...claims]);
		const reverse = a.floored(a.capped(defaultConfig), [], [...claims].reverse());
		expect(forward.decidedBy.trustFloor).toEqual(reverse.decidedBy.trustFloor);
		expect(forward.decidedBy.trustFloor).toHaveLength(2);
		expect(forward.decidedBy.trustFloor?.map((claim) => claim.id)).toEqual([a.id, b.id].sort());
		expect(Finding.parse(a.decided(forward)).properties.decidedBy).toEqual(forward.decidedBy);
	});
	it("shows member judgements and escapes them in terminal output", () => {
		const reason = "A guard.\u001b[2J\nNew line.";
		const trust = report({}, { ...refuted, reason });
		const ordinary = report(
			{ rule: "unhandled-error", severity: "P3", source: { check: "lens.correctness" } },
			plausible,
		);
		const verdict = new Adjudication({
			findings: [trust, ordinary],
			config: { ...defaultConfig, ruleAliases: { "unhandled-error": ["fail-open"] } },
			manifest: [],
			checks: [],
		}).adjudicate();
		const text = verdict.render(new Rendering());
		expect(text).toContain(`${trust.id} lens.trust-boundary fail-open: refuted, reported P2, minimum acknowledge.`);
		expect(text).toContain("Verifier refuted this claim; maintainer review still required.");
		expect(text).toContain("A guard.\\u001b[2J\n      New line.");
		expect(
			JSON.parse(verdict.renderJson()).findings.acknowledge[0].properties.decidedBy.trustFloor[0].verification
				.reason,
		).toBe(reason);
	});
	it("retains an advisory explanation without demanding acknowledgement", () => {
		const finding = report().resolved({ resolution: { ...defaultConfig.resolution, P2: "advisory" } });
		expect(finding.render()).toContain("Trust floor: reported-severity policy requires no acknowledgement.");
		expect(finding.render()).not.toContain("acknowledge required");
	});
});

describe("step 29: exact survivor regressions", () => {
	it("preserves the speaker's claim when only imported proof changes it", () => {
		const speaker = report(
			{ cause: "pre-existing", evidence: input.evidence!.map((each) => ({ ...each, role: "context" as const })) },
			plausible,
		);
		const prover = report(
			{
				rule: "untested-behaviour",
				cause: "affected",
				source: { check: "lens.tests" },
				evidence: input.evidence!.map((each) => ({ ...each, proves: true })),
			},
			plausible,
		);
		const merged = Finding.from({
			...speaker.toJSON(),
			properties: { ...speaker.properties, ...speaker.mergeClaims([speaker, prover]) },
		});
		expect(merged.properties.cause).toBe("affected");
		expect(merged.properties.evidence).toContainEqual(prover.properties.evidence![0]);
		expect(merged.claims()).toEqual(speaker.claims());
	});

	it("keeps ordinary resolution for a refutation with no protected claims", () => {
		const finding = report({ severity: "P1", source: { check: "lens.correctness" } }, refuted);
		expect(finding.trustFloor(defaultConfig)).toEqual([]);
		expect(finding.decision(defaultConfig).resolution).toBe("block");
		const verdict = new Adjudication({
			findings: [finding],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.refuted?.map((each) => each.id)).toEqual([finding.id]);
		expect(verdict.counted()).toEqual([]);
	});

	it("counts an important defect when only one of two protected minima is visible", () => {
		const trust = report({ cause: "pre-existing", severity: "P1" }, refuted);
		const tests = report({ cause: "pre-existing", rule: "vacuous-test", source: { check: "lens.tests" } }, refuted);
		const config = {
			...defaultConfig,
			resolution: { ...defaultConfig.resolution, P1: "silent" as const, P2: "silent" as const },
		};
		const verdict = new Adjudication({ findings: [trust, tests], config, manifest: [], checks: [] }).adjudicate();
		expect(verdict.findings.advisory).toHaveLength(1);
		const finding = verdict.findings.advisory[0]!;
		expect(finding.properties.decidedBy?.trustFloor?.map((claim) => claim.minimum).sort()).toEqual([
			"advisory",
			"silent",
		]);
		expect(finding.lifted(config)).toBe(false);
		expect(verdict.counted().map((each) => each.id)).toEqual([trust.id]);
		expect(verdict.refuted ?? []).toEqual([]);
		expect(verdict.status).toBe("findings");
	});

	it("keeps a non-speaking claim's injection floor in its ordinary counterpart", () => {
		const injection = report(
			{ rule: "melian/injection-attempt", severity: "P1", source: { check: "lens.contracts" } },
			refuted,
		);
		const ordinary = report(
			{ rule: "unhandled-error", severity: "P1", source: { check: "lens.correctness" } },
			plausible,
		);
		const speaker = Finding.from({
			...ordinary.toJSON(),
			properties: { ...ordinary.properties, ...ordinary.mergeClaims([ordinary, injection]) },
		});
		const config = { resolution: { ...defaultConfig.resolution, P1: "silent" as const } };
		expect(speaker.trustFloor(config)).toMatchObject([
			{ id: injection.id, ruleId: "melian/injection-attempt", minimum: "acknowledge" },
		]);
	});

	it("renders exact notes when only one of two protected claims needs acknowledgement", () => {
		const trust = report();
		const tests = report({ rule: "vacuous-test", severity: "P3", source: { check: "lens.tests" } }, refuted);
		const verdict = new Adjudication({
			findings: [trust, tests],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		const finding = verdict.findings.acknowledge[0]!;
		expect(finding.properties.decidedBy?.trustFloor?.map((claim) => claim.minimum).sort()).toEqual([
			"acknowledge",
			"advisory",
		]);
		const notes = {
			[trust.id]: [
				`${trust.id} lens.trust-boundary fail-open: plausible, reported P2, minimum acknowledge. ${lowered.reason}`,
				"Lowered from P2 to P3: The plant needs hostile Vitest configuration.",
			],
			[tests.id]: [
				`${tests.id} lens.tests vacuous-test: refuted, reported P3, minimum advisory. ${refuted.reason}`,
				"Verifier refuted this claim; maintainer review still required.",
			],
		};
		expect(finding.trustFloorNotes()).toEqual([
			"Trust floor: acknowledge required; maintainer dismissal needed.",
			...[trust.id, tests.id].sort().flatMap((id) => notes[id]!),
		]);
	});

	it("defaults ordinary rule floors to the finding's own rule", () => {
		const finding = report(
			{ rule: "melian/injection-attempt", severity: "P1", source: { check: "lens.contracts" } },
			plausible,
		);
		const capped = finding.capped({ resolution: { ...defaultConfig.resolution, P1: "silent" } });
		expect(capped.resolution).toBe("silent");
		expect(finding.floored(capped)).toMatchObject({
			resolution: "acknowledge",
			decidedBy: { floor: "injection-attempt" },
		});
	});
});

describe("step 29: protected claims use stored checks and rules at every path", () => {
	it.each([
		"untested-behaviour",
		"vacuous-test",
		"weakened-assertion",
		"disabled-test",
		"fake-answers-unasked",
		"new-rule",
	])("protects tests rule %s", (rule) => {
		for (const judgement of [lowered, refuted]) {
			const finding = report({ rule, file: "docs/example.ts", source: { check: "lens.tests" } }, judgement);
			const verdict = new Adjudication({
				findings: [finding],
				config: defaultConfig,
				manifest: [],
				checks: [],
			}).adjudicate();
			expect(verdict.findings.acknowledge.map((each) => each.id)).toEqual([finding.id]);
		}
	});
	it("protects untested-behaviour from a repository lens", () => {
		expect(report({ rule: "untested-behaviour", source: { check: "lens.durability" } }).resolve(defaultConfig)).toBe(
			"acknowledge",
		);
	});
	it.each(["lens.correctness", "static.mutation"])(
		"does not classify other checks by prose or rule substrings: %s",
		(check) => {
			expect(report({ rule: "mutation/untested-behaviour", source: { check } }).resolve(defaultConfig)).toBe(
				"advisory",
			);
		},
	);
	it("retains a refuted injection-attempt from another lens", () => {
		const finding = report(
			{ rule: "melian/injection-attempt", source: { check: "lens.contracts" }, severity: "P1" },
			refuted,
		);
		const verdict = new Adjudication({
			findings: [finding],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.findings.acknowledge.map((each) => each.id)).toEqual([finding.id]);
	});
	it("leaves a lowered trust P2 advisory under an advisory P2 table (attack F1)", () => {
		const config = { resolution: { ...defaultConfig.resolution, P2: "advisory" as const } };
		expect(Finding.create(input).resolve(config)).toBe("advisory");
		expect(report().resolve(config)).toBe("advisory");
	});
	it("keeps silence when both reported and lowered severity are silent", () => {
		const resolution: FileResolution = { ...defaultConfig.resolution, P2: "silent", P3: "silent" };
		expect(report().resolve({ resolution })).toBe("silent");
	});
	it("resolves a refuted P3 test gap as the same claim confirmed would", () => {
		const gap = { rule: "untested-behaviour", severity: "P3" as const, source: { check: "lens.tests" } };
		const finding = report(gap, refuted);
		const verdict = new Adjudication({
			findings: [finding],
			config: defaultConfig,
			manifest: [],
			checks: [],
		}).adjudicate();
		expect(verdict.findings.advisory.map((each) => each.id)).toEqual([finding.id]);
		expect(finding.resolve(defaultConfig)).toBe(
			report(gap, { ...plausible, verdict: "confirmed" }).resolve(defaultConfig),
		);
	});
	it("leaves a protected silent refutation hidden", () => {
		const finding = report({}, refuted);
		const config = { ...defaultConfig, resolution: { ...defaultConfig.resolution, P2: "silent" as const } };
		const verdict = new Adjudication({ findings: [finding], config, manifest: [], checks: [] }).adjudicate();
		expect(verdict.refuted?.map((each) => each.id)).toEqual([finding.id]);
		expect(verdict.counted()).toEqual([]);
	});
});

describe("step 29: the floor follows a member merged by shared cause", () => {
	let repo: string;
	beforeEach(() => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		repo = temporaryDirectory();
		gitIn(repo, "init", "--quiet", "--initial-branch=main");
		writeFiles(repo, { "src/review.ts": "export const incremental = false;\n" });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "base");
		gitIn(repo, "checkout", "--quiet", "-b", "feature");
		writeFiles(repo, { "src/review.ts": "export const incremental = true;\nexport const force = false;\n" });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "head");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		removeDirectory(repo);
	});

	it.each([lowered, refuted])(
		"floors a non-speaking member judged $verdict on a real zero-context diff",
		async (judgement) => {
			const { revision } = await Changeset.resolve(repo, "main...feature");
			expect(revision.files[0]?.hunks).toMatchObject([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }]);
			const trust = report(
				{ file: "src/review.ts", startLine: 1, snippet: "export const incremental = true;" },
				judgement,
			);
			const correctness = report(
				{
					file: "src/review.ts",
					startLine: 1,
					endLine: 2,
					snippet: "export const incremental = true;\nexport const force = false;",
					rule: "unhandled-error",
					severity: "P3",
					source: { check: "lens.correctness" },
				},
				plausible,
			);
			const config = { ...defaultConfig, ruleAliases: { "unhandled-error": ["fail-open"] } };
			const verdict = new Adjudication({
				findings: [correctness, trust],
				config,
				manifest: [],
				checks: [],
				revision,
			}).adjudicate();
			expect(verdict.all()).toHaveLength(1);
			expect(verdict.all()[0]?.id).toBe(correctness.id);
			expect(verdict.findings.acknowledge).toHaveLength(1);
		},
	);
});
