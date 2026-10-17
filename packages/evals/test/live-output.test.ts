import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StageTelemetry, TokenUsage } from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { describe, expect, it } from "vitest";
import { loadGoldens, runGolden } from "../src/goldens.ts";
import {
	measureTriageGoldens,
	reportGoldens,
	reportVerifierGoldens,
	shownOutput,
	verdictLabel,
} from "../src/live-output.ts";
import { GoldenRunError } from "../src/run-error.ts";
import { loadTriageGoldens } from "../src/triage.ts";
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
		expect.stringMatching(
			/^correctness-null-deref: precision 1\.00, recall 1\.00 \(1 reported, 1 expected\), \d+ tokens, \$0$/,
		),
		"pre-existing-beside-change: skipped, live: false",
		expect.stringMatching(
			/^clean-rename: precision 1\.00, recall 1\.00 \(0 reported, 0 expected\), \d+ tokens, \$0$/,
		),
	];
	const corpus = "corpus: precision 1.00, recall 1.00";

	it("prints one score line for each golden, skips one marked live: false, and returns the scores", async () => {
		const lines: string[] = [];
		const report = await reportGoldens(goldens, scripted, {}, (line) => lines.push(line));
		expect(lines).toEqual([...scores, corpus]);
		expect(report.failed).toEqual([]);
		expect(report.status).toBe(0);
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
			corpus,
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
			corpus,
		]);
		expect(report.status).toBe(1);
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
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/^guarded-null-dereference: refuted, passed \(decoy\), \d+ tokens, \$0$/);
		expect(lines[2]).toBe("verifier corpus: 1/2 passed");
		expect(report.status).toBe(1);
		expect(lines[1]).toMatch(/^design-supersedes-its-own-decision: unjudged \(.*Missing verifier instruction: This/);
		expect(lines[1]).toMatch(/\), failed \(design\), \d+ tokens, \$0$/);
		expect(report.scores.map((score) => score.passed)).toEqual([true, false]);
		expect(report.failed).toEqual([]);
	});
	it("prints the rendered review under each verdict when MELIAN_EVAL_SHOW is 1", async () => {
		const lines: string[] = [];
		const report = await reportVerifierGoldens([decoy!], scripted, shown, (line) => lines.push(line));
		expect(report.status).toBe(0);
		expect(lines.pop()).toBe("verifier corpus: 1/1 passed");
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
			expect.stringMatching(/^guarded-null-dereference: refuted, passed \(decoy\), \d+ tokens, \$0$/),
			"verifier corpus: 1/1 passed",
		]);
		expect(report.status).toBe(1);
		expect(report.failed).toEqual(["design-supersedes-its-own-decision"]);
		expect(report.scores).toHaveLength(1);
	});
});

const paid = new StageTelemetry("base..head", [
	{
		id: "triage",
		task: 1,
		name: "melian.triage",
		subject: "triage",
		outcome: "completed",
		timing: "unavailable",
		reused: false,
		resumed: false,
		usage: new TokenUsage({
			model: {
				input: 2,
				output: 3,
				cacheRead: 4,
				cacheWrite: 5,
				totalTokens: 14,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			},
		}).toJSON(),
	},
]);

it("keeps each triage pass's usage with its choices and prints spend for a failed pass", async () => {
	const golden = loadTriageGoldens()[0]!;
	const lines: string[] = [];
	const result = await measureTriageGoldens(
		[golden],
		async (_golden, record) => {
			record(paid);
			record(new StageTelemetry("base..head", []));
			return [{ correctness: "quick" }];
		},
		(line) => lines.push(line),
	);
	expect(result).toEqual({
		chosen: { [golden.name]: [{ correctness: "quick" }] },
		telemetry: { [golden.name]: [paid, new StageTelemetry("base..head", [])] },
	});
	expect(lines).toEqual([]);
	await expect(
		measureTriageGoldens(
			[golden],
			async () => {
				throw new GoldenRunError(new Error("bad\u001b[2J"), paid);
			},
			(line) => lines.push(line),
		),
	).rejects.toThrow("triage measurement failed");
	expect(lines).toEqual([`${golden.name}: no score (bad\\u001b[2J), 14 tokens, $1`]);
});

it("prints the same telemetry record for a failed lens golden", async () => {
	const golden = loadGoldens().find((golden) => golden.live)!;
	const lines: string[] = [];
	const result = await reportGoldens(
		[golden],
		async () => {
			throw new GoldenRunError("provider error", paid);
		},
		{},
		(line) => lines.push(line),
	);
	expect(result.status).toBe(1);
	expect(lines[0]).toBe(`${golden.name}: no score (provider error), 14 tokens, $1`);
});

it("keeps the detached usage when a fake provider makes an actual golden review fail", async () => {
	const golden = loadGoldens().find((golden) => golden.name === "clean-rename")!;
	const fake = createFakeModels({ models: [{ id: "unanswered" }] });
	let failure: unknown;
	try {
		await runGolden(golden, { kind: "live", models: fake.review, model: "faux/unanswered" });
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(GoldenRunError);
	const record = (failure as GoldenRunError).telemetry;
	expect(record.total!.total.totalTokens).toBeGreaterThan(0);
	expect(record.total!.total.cost.total).toBe(0);
	expect(record.usageUnavailable).toEqual([]);
	const lines: string[] = [];
	await reportGoldens(
		[golden],
		async () => {
			throw failure;
		},
		{},
		(line) => lines.push(line),
	);
	expect(lines[0]).toContain(record.spend());
}, 60_000);

it("keeps verifier telemetry when a refused planted finding makes the run fail", async () => {
	const golden = loadVerifierGoldens()[0]!;
	const failure: unknown = await runVerifierGolden(
		{ ...golden, candidate: { ...golden.candidate, file: "does-not-exist.ts" } },
		{ kind: "scripted" },
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(GoldenRunError);
	expect((failure as GoldenRunError).telemetry.total!.total.totalTokens).toBeGreaterThan(0);
}, 60_000);

it("escapes golden names on successful lens and verifier score lines", async () => {
	const golden = loadGoldens().find((golden) => golden.name === "clean-rename")!;
	const verifier = loadVerifierGoldens()[0]!;
	const lines: string[] = [];
	await reportGoldens(
		[{ ...golden, name: "lens\u001b[2J" }],
		(golden) => runGolden(golden, { kind: "scripted" }),
		{},
		(line) => lines.push(line),
	);
	await reportVerifierGoldens(
		[{ ...verifier, name: "judge\u001b[2J" }],
		(golden) => runVerifierGolden(golden, { kind: "scripted" }),
		{},
		(line) => lines.push(line),
	);
	expect(lines.join("\n")).not.toContain("\u001b");
	expect(lines[0]).toContain("lens\\u001b[2J: precision");
	expect(lines[2]).toContain("judge\\u001b[2J:");
}, 60_000);
