import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verification } from "@melian-agent/core";
import {
	loadScenarioGoldens,
	loadVerifierGoldens,
	runScenarioGolden,
	runVerifierGolden,
	type ScenarioGolden,
	scenarioMismatches,
	scoreVerifierGolden,
	type VerifierGolden,
} from "@melian-agent/evals";
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
	it("holds executing-reviewer misses, two design claims and three decoys outside the lens corpus", () => {
		expect(goldens.map((golden) => golden.name)).toEqual([
			"circular-import-tdz",
			"design-reimplements-an-authority-supported-gap",
			"design-reimplements-an-authority-unsupported-gap",
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
		expect(run.unjudged).toContain(`Missing verifier instruction: ${missing}`);
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
	it("retries a live judge's failed request, so one provider error does not score a golden unjudged", async () => {
		const judge = createFakeModels({ provider: "flaky-judge", models: [{ id: "separate" }] });
		const requests = scriptConversations(judge, [
			{
				match: "Melian adversarial verifier",
				replies: [
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded_error" }),
					(messages) => scriptVerifier(messages),
					(messages) => scriptVerifier(messages),
				],
			},
		]);
		const ref = judge.ref();
		const golden = goldens.find((each) => each.expected.kind === "needs-execution")!;
		const run = await runVerifierGolden(golden, {
			kind: "live",
			models: judge.review,
			verifierModel: `${ref.provider}/${ref.modelId}`,
		});
		expect(requests["Melian adversarial verifier"]).toHaveLength(3);
		expect(run.unjudged).toBeUndefined();
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
			expect(run.unjudged).toBe(scores.length === 1 ? "the verifier left a claim unjudged" : undefined);
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

const scenarios = loadScenarioGoldens();

describe("the scenario goldens of the verifier corpus", { timeout: 60_000 }, () => {
	it("holds the eleven that lowering and surfacing keep", () => {
		const count = (group: ScenarioGolden["scenario"]["group"]) =>
			scenarios.filter((golden) => golden.scenario.group === group).length;
		expect(scenarios).toHaveLength(11);
		expect([count("lowering"), count("surfacing"), count("conflict")]).toEqual([6, 3, 2]);
		expect(scenarios.every((golden) => golden.name.startsWith(`${golden.scenario.group}-`))).toBe(true);
	});

	it.each(scenarios)("$name", async (golden) => {
		expect(scenarioMismatches(golden, await runScenarioGolden(golden))).toEqual([]);
		if (golden.scenario.bothOrders === true)
			expect(scenarioMismatches(golden, await runScenarioGolden(golden, true))).toEqual([]);
	});

	it("runs a golden's reports in the opposite order when asked", async () => {
		const golden = scenarios.find((each) => each.name === "conflict-lowering-both-orders")!;
		const first = { ...golden.scenario.reports[0]!, expectResult: ["lowered P2 to P3"] };
		const second = { ...golden.scenario.reports[1]!, expectResult: ["no report says this"] };
		const marked = { ...golden, scenario: { ...golden.scenario, reports: [first, second] } };
		expect((await runScenarioGolden(marked)).resultMismatches).toEqual([
			expect.stringContaining('report 2 returned "recorded verdict for c1'),
		]);
		// Reversed, the plain report comes first, so the lowering that follows it is not kept, and its result says so.
		expect((await runScenarioGolden(marked, true)).resultMismatches).toEqual([
			expect.stringContaining('report 1 returned "recorded verdict for c1'),
			expect.stringContaining('report 2 returned "recorded verdict for c1\\nlowering not kept'),
		]);
	});

	it("fails a run whose verifier lacks a required instruction", async () => {
		const golden = scenarios.find((each) => each.name === "lowering-hostile-claim")!;
		const missing = {
			...golden,
			scenario: { ...golden.scenario, expectInstructions: ["An instruction no verifier has."] },
		};
		await expect(runScenarioGolden(missing)).rejects.toThrow("the verifier did not judge every claim");
	});

	it("says which expectation a run misses, field by field", async () => {
		const golden = scenarios.find((each) => each.name === "surfacing-lowered-p1-member")!;
		const run = await runScenarioGolden(golden);
		const [expected] = golden.scenario.expected;
		const missed = (change: Partial<typeof expected>) =>
			scenarioMismatches(
				{ ...golden, scenario: { ...golden.scenario, expected: [{ ...expected!, ...change }] } },
				run,
			);
		expect(missed({})).toEqual([]);
		expect(missed({ status: "passed" })).toEqual(['revision 1: status is "findings", expected "passed"']);
		expect(missed({ blocking: true })).toEqual(["revision 1: blocking is false, expected true"]);
		expect(missed({ severity: "P3" })).toEqual([
			'revision 1: severity is "P2", expected "P3"',
			'revision 1: severity in JSON is "P2", expected "P3"',
		]);
		expect(missed({ originalSeverity: "P0" })).toEqual([
			'revision 1: originalSeverity is "P1", expected "P0"',
			'revision 1: originalSeverity in JSON is "P1", expected "P0"',
		]);
		expect(missed({ cause: "affected" })).toEqual(['revision 1: cause is "pre-existing", expected "affected"']);
		expect(missed({ resolution: "block" })).toEqual(['revision 1: resolution is "advisory", expected "block"']);
		expect(missed({ verdict: "plausible" })).toEqual(['revision 1: verdict is "confirmed", expected "plausible"']);
		expect(missed({ lowered: false })).toEqual(["revision 1: lowered is true, expected false"]);
		expect(missed({ important: undefined })).toHaveLength(2);
		expect(missed({ important: { ...expected!.important!, state: "carried" } })).toEqual([
			expect.stringContaining("revision 1: the important findings is"),
			expect.stringContaining("revision 1: the important findings in JSON is"),
		]);
		expect(missed({ rendered: ["no terminal says this"] })).toEqual([
			'revision 1: the terminal lacks "no terminal says this"',
		]);
		expect(missed({ notRendered: ["P2, lowered from P1"] })).toEqual([
			'revision 1: the terminal shows "P2, lowered from P1"',
		]);
		expect(scenarioMismatches(golden, { revisions: [], resultMismatches: ["a report differed"] })).toEqual([
			"a report differed",
			"revision 1 was not reviewed",
		]);
		const other = { ...run.revisions[0]!, json: { ...run.revisions[0]!.json, preExistingImportant: [] } };
		expect(scenarioMismatches(golden, { revisions: [other], resultMismatches: [] })).toEqual([
			expect.stringContaining("revision 1: the important findings in JSON is []"),
		]);
	});

	it("refuses a golden whose expectations do not match its revisions, or whose two orders have one report", () => {
		const directory = mkdtempSync(join(tmpdir(), "melian-verifier-scenarios-"));
		try {
			const golden = scenarios.find((each) => each.name === "surfacing-new-then-carried")!;
			const copy = join(directory, golden.name);
			cpSync(golden.directory, copy, { recursive: true });
			expect(loadScenarioGoldens(directory)).toHaveLength(1);
			expect(loadVerifierGoldens(directory)).toEqual([]);
			const write = (scenario: unknown) => writeFileSync(join(copy, "scenario.json"), JSON.stringify(scenario));
			write({ ...golden.scenario, expected: [golden.scenario.expected[0]] });
			expect(() => loadScenarioGoldens(directory)).toThrow(
				`${golden.name}: expected needs one entry per reviewed revision, 2 here`,
			);
			write({ ...golden.scenario, bothOrders: true });
			expect(() => loadScenarioGoldens(directory)).toThrow(`${golden.name}: bothOrders needs at least two reports`);
			write({ ...golden.scenario, surprise: true });
			expect(() => loadScenarioGoldens(directory)).toThrow("scenario.json");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
