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
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

// Phase 1 contract tests intentionally fail until step 29's rule has survived an attacking review.
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

	it.each(["introduced", "pre-existing", "affected"] as const)("applies after the %s cap", (cause) => {
		expect(report({ cause }).resolve(defaultConfig)).toBe("acknowledge");
	});

	it.each(["advisory", "silent"] as const)("overrides a %s check ceiling", (ceiling) => {
		const config = {
			resolution: { ...defaultConfig.resolution, checks: { "lens.trust-boundary": { ceiling } } },
		};
		expect(report().resolve(config)).toBe("acknowledge");
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
		expect(report({ severity: "P3" }, plausible).resolve(defaultConfig)).toBe("advisory");
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
});

describe("step 29: approval test gaps use trusted path policy", () => {
	const gap = { rule: "untested-behaviour", source: { check: "lens.tests" } };
	const policy = {
		...defaultConfig,
		approvalPaths: ["packages/*/src/**", ".github/**"],
	};

	it("protects test gaps in approval paths", () => {
		expect(report(gap).resolve(policy)).toBe("acknowledge");
	});

	it("leaves a test gap outside approval paths advisory", () => {
		expect(report({ ...gap, file: "docs/example.ts", evidence: undefined }).resolve(policy)).toBe("advisory");
	});

	it("does not enrol a report through an approval path cited as evidence", () => {
		expect(report({ ...gap, file: "docs/example.ts" }).resolve(policy)).toBe("advisory");
	});

	it("protects all paths when an older caller supplies no approval list", () => {
		expect(report({ ...gap, file: "docs/example.ts" }).resolve(defaultConfig)).toBe("acknowledge");
	});

	it("protects an untested-behaviour report from a repository lens", () => {
		expect(report({ rule: "untested-behaviour", source: { check: "lens.durability" } }).resolve(policy)).toBe(
			"acknowledge",
		);
	});

	it("leaves other tests rules advisory after lowering", () => {
		expect(report({ rule: "vacuous-test", source: { check: "lens.tests" } }).resolve(policy)).toBe("advisory");
	});

	it("holds a trust lowering under a table that silences both severities", () => {
		const resolution: FileResolution = { ...defaultConfig.resolution, P2: "silent", P3: "silent" };
		expect(report().resolve({ resolution })).toBe("acknowledge");
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
