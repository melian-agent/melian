import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verification } from "@melian-agent/core";
import { loadVerifierGoldens, runVerifierGolden, scoreVerifierGolden, type VerifierGolden } from "@melian-agent/evals";
import {
	createFakeModels,
	fauxAssistantMessage,
	scriptConversations,
	scriptVerifier,
} from "@melian-agent/pipeline/testing";
import { describe, expect, it } from "vitest";

const goldens = loadVerifierGoldens();

const verdictCases: [VerifierGolden["expected"]["kind"], Verification["verdict"][], boolean][] = [
	["design", ["confirmed"], true],
	["design", ["plausible"], false],
	["design", ["refuted"], false],
	["design", ["confirmed", "plausible"], false],
	["design", ["confirmed", "refuted"], false],
	["design", ["plausible", "refuted"], false],
	["design", ["confirmed", "plausible", "refuted"], false],
	["decoy", ["confirmed"], false],
	["decoy", ["plausible"], false],
	["decoy", ["refuted"], true],
	["decoy", ["confirmed", "plausible"], false],
	["decoy", ["confirmed", "refuted"], false],
	["decoy", ["plausible", "refuted"], false],
	["decoy", ["confirmed", "plausible", "refuted"], false],
	["needs-execution", ["confirmed"], false],
	["needs-execution", ["plausible"], false],
	["needs-execution", ["refuted"], false],
	["needs-execution", ["confirmed", "plausible"], true],
	["needs-execution", ["confirmed", "refuted"], false],
	["needs-execution", ["plausible", "refuted"], false],
	["needs-execution", ["confirmed", "plausible", "refuted"], false],
	["needs-execution", ["plausible", "confirmed"], true],
];

describe("the verifier corpus", { timeout: 60_000 }, () => {
	it("holds executing-reviewer misses, a design departure and two decoys outside the lens corpus", () => {
		expect(goldens.map((golden) => golden.name)).toEqual([
			"circular-import-tdz",
			"design-supersedes-its-own-decision",
			"excluded-zero-input",
			"guarded-null-dereference",
			"separator-hash-collision",
			"v8-diagnostic-bytes",
			"yaml-secret-diagnostic",
		]);
	});
	it.each(verdictCases)("%s corpus verdicts %j", (kind, verdicts, accepted) => {
		const directory = mkdtempSync(join(tmpdir(), "melian-verifier-verdicts-"));
		try {
			const golden = goldens.find((each) => each.expected.kind === kind)!;
			const copy = join(directory, golden.name);
			cpSync(golden.directory, copy, { recursive: true });
			writeFileSync(join(copy, "expected.json"), JSON.stringify({ kind, verdicts }));
			if (accepted) {
				const loaded = loadVerifierGoldens(directory);
				expect(loaded).toHaveLength(1);
				expect(loaded[0]!.expected).toEqual({ kind, verdicts });
			} else {
				expect(() => loadVerifierGoldens(directory)).toThrow(
					`${golden.name}: expected verdicts must retain real defects and refute decoys`,
				);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(goldens)("judges $name through the verification task", async (golden) => {
		const run = await runVerifierGolden(golden, { kind: "scripted" });
		expect(scoreVerifierGolden(golden, run).passed).toBe(true);
		expect(run.verification).toMatchObject({
			verdict: golden.script.verdict,
			executor: "llm",
			reason: golden.script.reason,
		});
		expect(run.verifierRequests).toBe(2);
		expect(run.rendered).toContain(golden.script.verdict);
	});
	it("leaves a scripted candidate unjudged when a required verifier instruction is absent", async () => {
		const golden = goldens.find((each) => each.expected.kind === "design")!;
		const missing = "This instruction is deliberately absent from the verifier prompt.";
		const run = await runVerifierGolden(
			{
				...golden,
				script: { ...golden.script, expectInstructions: [...golden.script.expectInstructions!, missing] },
			},
			{ kind: "scripted" },
		);
		expect(run.verification).toBeUndefined();
		expect(scoreVerifierGolden(golden, run)).toMatchObject({ verdict: undefined, passed: false });
		expect(run.rendered).toContain("not reviewed");
		expect(run.rendered).toContain(`Missing verifier instruction: ${missing}`);
		expect(run.verifierRequests).toBe(1);
	});
	it("fails a refuted real defect, a retained decoy, and any unjudged candidate", () => {
		const real = goldens.find((golden) => golden.expected.kind === "needs-execution")!;
		const decoy = goldens.find((golden) => golden.expected.kind === "decoy")!;
		const verification = (verdict: Verification["verdict"]): Verification => ({
			verdict,
			reason: "Scoring probe",
			executor: "llm",
			model: "fake/judge",
			version: "test",
		});
		expect(scoreVerifierGolden(real, { verification: verification("refuted") }).passed).toBe(false);
		expect(scoreVerifierGolden(real, { verification: verification("confirmed") }).passed).toBe(true);
		expect(scoreVerifierGolden(real, { verification: verification("plausible") }).passed).toBe(true);
		expect(scoreVerifierGolden(decoy, { verification: verification("confirmed") }).passed).toBe(false);
		expect(scoreVerifierGolden(decoy, { verification: verification("plausible") }).passed).toBe(false);
		for (const golden of goldens) expect(scoreVerifierGolden(golden, { verification: undefined }).passed).toBe(false);
	});
	it("keeps planted and judge providers in one opaque collection", async () => {
		const judges = createFakeModels({ models: [{ id: "live-judge" }] });
		const planted = createFakeModels({ provider: "planted-provider", models: [{ id: "planted" }] }, judges.review);
		expect(planted.review).toBe(judges.review);
		expect(planted.models).toBe(judges.models);
		expect(planted.models.getModel(judges.ref().provider, "live-judge")).toBeDefined();
	});
	it("uses a separately routed judge while keeping the finder scripted", async () => {
		const judge = createFakeModels({ provider: "eval-judge", models: [{ id: "separate" }] });
		const requests = scriptConversations(judge, [
			{
				match: "Melian adversarial verifier",
				replies: [(messages) => scriptVerifier(messages), (messages) => scriptVerifier(messages)],
			},
		]);
		const ref = judge.ref();
		const golden = goldens.find((each) => each.expected.kind === "needs-execution")!;
		const run = await runVerifierGolden(golden, {
			kind: "live",
			models: judge.review,
			verifierModel: `${ref.provider}/${ref.modelId}`,
		});
		expect(run.verification?.model).toBe(`${ref.provider}/${ref.modelId}`);
		expect(requests["Melian adversarial verifier"]).toHaveLength(2);
		expect(scoreVerifierGolden(golden, run).passed).toBe(true);
	});
	it("scores an unfinished judge as unjudged and continues to the next golden", async () => {
		const judge = createFakeModels({ provider: "unfinished-judge", models: [{ id: "separate" }] });
		const requests = scriptConversations(judge, [
			{
				match: "Melian adversarial verifier",
				replies: [
					fauxAssistantMessage("Done without reporting a verdict."),
					(messages) => scriptVerifier(messages),
					(messages) => scriptVerifier(messages),
				],
			},
		]);
		const ref = judge.ref();
		const scores = [];
		for (const golden of goldens.filter((each) => each.expected.kind === "needs-execution").slice(0, 2)) {
			const run = await runVerifierGolden(golden, {
				kind: "live",
				models: judge.review,
				verifierModel: `${ref.provider}/${ref.modelId}`,
			});
			scores.push(scoreVerifierGolden(golden, run));
			if (scores.length === 1) expect(run.rendered).toContain("not reviewed");
		}
		expect(scores).toMatchObject([
			{ verdict: undefined, passed: false },
			{ verdict: "confirmed", passed: true },
		]);
		expect(requests["Melian adversarial verifier"]).toHaveLength(3);
	});
	it("rejects a live suite without a verifier route before opening a repository or model", async () => {
		await expect(runVerifierGolden(goldens[0]!, { kind: "live", models: createFakeModels().review })).rejects.toThrow(
			"MELIAN_EVAL_VERIFIER_MODEL",
		);
	});
});
