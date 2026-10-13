import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoldens, runGolden } from "../src/goldens.ts";
import { reportGoldens, reportVerifierGoldens, shownOutput, verdictLabel } from "../src/live-output.ts";
import { loadVerifierGoldens, runVerifierGolden, type VerifierGolden } from "../src/verifier.ts";

const named = <Each extends { name: string }>(all: readonly Each[], ...names: string[]): Each[] =>
	names.map((name) => all.find((each) => each.name === name)!);
const shown = { MELIAN_EVAL_SHOW: "1" };

describe("verdictLabel", () => {
	it("prints the verdict, or unjudged with the reason the verifier check recorded", () => {
		expect(verdictLabel("confirmed", undefined)).toBe("confirmed");
		expect(verdictLabel("refuted", "ignored")).toBe("refuted");
		expect(verdictLabel(undefined, "Codex error: overloaded")).toBe("unjudged (Codex error: overloaded)");
		expect(verdictLabel(undefined, undefined)).toBe("unjudged (no reason recorded)");
	});
});

describe("shownOutput", () => {
	it("prints nothing unless MELIAN_EVAL_SHOW is exactly 1", () => {
		for (const env of [{}, { MELIAN_EVAL_SHOW: "" }, { MELIAN_EVAL_SHOW: "0" }, { MELIAN_EVAL_SHOW: "true" }]) {
			expect(shownOutput("Verdict: findings\n", env)).toEqual([]);
		}
	});
	it("indents each line of the rendering and keeps blank lines empty", () => {
		expect(shownOutput("Verdict: findings\n\n  P1  line 5\n\n", shown)).toEqual([
			"    Verdict: findings",
			"",
			"      P1  line 5",
		]);
	});
});

describe("reportGoldens", { timeout: 60_000 }, () => {
	const goldens = named(loadGoldens(), "correctness-null-deref", "pre-existing-beside-change", "clean-rename");
	const scripted = (golden: (typeof goldens)[number]) => runGolden(golden, { kind: "scripted" });
	const scores = [
		"correctness-null-deref: precision 1.00, recall 1.00 (1 reported, 1 expected)",
		"pre-existing-beside-change: skipped, live: false",
		"clean-rename: precision 1.00, recall 1.00 (0 reported, 0 expected)",
	];

	it("prints one score line for each golden, skips one marked live: false, and returns the scores", async () => {
		const lines: string[] = [];
		const report = await reportGoldens(goldens, scripted, {}, (line) => lines.push(line));
		expect(lines).toEqual(scores);
		expect(report.failed).toEqual([]);
		expect(report.scores.map((score) => [score.golden, score.reported, score.found])).toEqual([
			["correctness-null-deref", 1, 1],
			["clean-rename", 0, 0],
		]);
	});
	it("prints each golden's rendered review under its score when MELIAN_EVAL_SHOW is 1", async () => {
		const lines: string[] = [];
		await reportGoldens(goldens, scripted, shown, (line) => lines.push(line));
		const rendering = (name: string) =>
			shownOutput(readFileSync(join(named(goldens, name)[0]!.directory, "scripted.txt"), "utf8"), shown);
		expect(rendering("correctness-null-deref").length).toBeGreaterThan(3);
		expect(lines).toEqual([
			scores[0],
			...rendering("correctness-null-deref"),
			scores[1],
			scores[2],
			...rendering("clean-rename"),
		]);
	});
	it("prints a run's error as no score, goes on to the next golden, and names the one that failed", async () => {
		const lines: string[] = [];
		const report = await reportGoldens(
			goldens,
			(golden) =>
				golden.name === "correctness-null-deref"
					? Promise.reject(new Error("every model of a lens's tier failed"))
					: scripted(golden),
			{},
			(line) => lines.push(line),
		);
		expect(lines).toEqual([
			"correctness-null-deref: no score (every model of a lens's tier failed)",
			scores[1],
			scores[2],
		]);
		expect(report.failed).toEqual(["correctness-null-deref"]);
		expect(report.scores.map((score) => score.golden)).toEqual(["clean-rename"]);
	});
});

describe("reportVerifierGoldens", { timeout: 60_000 }, () => {
	const [decoy, design] = named(
		loadVerifierGoldens(),
		"guarded-null-dereference",
		"design-supersedes-its-own-decision",
	);
	const missing = "This instruction is deliberately absent from the verifier prompt.";
	const unjudged: VerifierGolden = {
		...design!,
		script: { ...design!.script, expectInstructions: [...design!.script.expectInstructions!, missing] },
	};
	const scripted = (golden: VerifierGolden) => runVerifierGolden(golden, { kind: "scripted" });

	it("prints each verdict, and an unjudged golden with the reason its verifier check recorded", async () => {
		const lines: string[] = [];
		const report = await reportVerifierGoldens([decoy!, unjudged], scripted, {}, (line) => lines.push(line));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("guarded-null-dereference: refuted, passed (decoy)");
		expect(lines[1]).toMatch(/^design-supersedes-its-own-decision: unjudged \(.*Missing verifier instruction: This/);
		expect(lines[1]).toMatch(/\), failed \(design\)$/);
		expect(report.scores.map((score) => score.passed)).toEqual([true, false]);
		expect(report.failed).toEqual([]);
	});
	it("prints the rendered review under each verdict when MELIAN_EVAL_SHOW is 1", async () => {
		const lines: string[] = [];
		await reportVerifierGoldens([decoy!], scripted, shown, (line) => lines.push(line));
		const run = await scripted(decoy!);
		expect(shownOutput(run.rendered, shown).length).toBeGreaterThan(3);
		expect(lines.slice(1).map((line) => line.replace(/[0-9a-f]{16}/g, "ID"))).toEqual(
			shownOutput(run.rendered, shown).map((line) => line.replace(/[0-9a-f]{16}/g, "ID")),
		);
	});
	it("prints a run's error as no score and goes on to the next golden", async () => {
		const lines: string[] = [];
		const report = await reportVerifierGoldens(
			[design!, decoy!],
			(golden) => (golden.name === decoy!.name ? scripted(golden) : Promise.reject("no route")),
			{},
			(line) => lines.push(line),
		);
		expect(lines).toEqual([
			"design-supersedes-its-own-decision: no score (no route)",
			"guarded-null-dereference: refuted, passed (decoy)",
		]);
		expect(report.failed).toEqual(["design-supersedes-its-own-decision"]);
		expect(report.scores).toHaveLength(1);
	});
});
