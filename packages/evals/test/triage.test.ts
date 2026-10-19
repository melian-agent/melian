import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lens, triageQuestionSet } from "@melian-agent/core";
import {
	buildGoldenRepository,
	loadTriageGoldens,
	runTriageGolden,
	type TriageChoice,
	TriageQuestions,
	TriageResults,
	triageDirectory,
} from "@melian-agent/evals";
import { StageTelemetry, TokenUsage } from "@melian-agent/pipeline";
import * as testing from "@melian-agent/pipeline/testing";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { describe, expect, it, vi } from "vitest";
import { GoldenRunError } from "../src/run-error.ts";

const goldens = loadTriageGoldens();

const choice = (expected: TriageChoice["expected"], chosen: string): TriageChoice => ({
	golden: "g",
	lens: "correctness",
	expected,
	chosen,
});

function measured(
	choices: readonly TriageChoice[],
	version = "1",
	fingerprint = "a",
	model = "m",
	goldenNames: readonly string[] = ["g"],
): TriageResults {
	return TriageResults.parse(
		JSON.stringify({
			questionSet: { name: "triage", version },
			fingerprint,
			model,
			goldens: goldenNames,
			passes: 1,
			choices,
		}),
	);
}

describe("the triage corpus", { timeout: 60_000 }, () => {
	it("holds changes whose right level each named lens is known for", () => {
		expect(goldens.map((golden) => golden.name)).toEqual([
			"add-test-only",
			"auth-guard-removed",
			"docs-typo",
			"rename-local",
			"retry-bound",
			"shell-from-request",
		]);
		expect(new Set(goldens.flatMap((golden) => Object.values(golden.expected.levels)))).toEqual(
			new Set(["quick", "careful", "deep"]),
		);
	});

	it.each(goldens)("has the fallback decider choose $name's right levels from its script", async (golden) => {
		const [chosen] = await runTriageGolden(golden, { kind: "scripted" });
		expect(chosen).toEqual(golden.expected.levels);
	});

	it("refuses a golden whose script gives a lens it names no answer, and one whose levels are unknown", () => {
		const directory = mkdtempSync(join(tmpdir(), "melian-triage-corpus-"));
		try {
			mkdirSync(join(directory, "broken"));
			writeFileSync(
				join(directory, "broken", "expected.json"),
				JSON.stringify({ title: "t", levels: { correctness: "quick", tests: "deep" } }),
			);
			writeFileSync(
				join(directory, "broken", "script.json"),
				JSON.stringify({ answers: { correctness: { quick: 1 } } }),
			);
			expect(() => loadTriageGoldens(directory)).toThrow("broken: script.json gives tests no answer");
			writeFileSync(
				join(directory, "broken", "expected.json"),
				JSON.stringify({ title: "t", levels: { correctness: "medium" } }),
			);
			expect(() => loadTriageGoldens(directory)).toThrow("expected.json");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("answers only the lenses a golden names, in a script that holds more", async () => {
		const golden = goldens.find((each) => each.name === "shell-from-request")!;
		const [chosen] = await runTriageGolden(
			{ ...golden, script: { answers: { ...golden.script.answers, tests: { quick: 1 } } } },
			{ kind: "scripted" },
		);
		expect(Object.keys(chosen!).sort()).toEqual(["correctness", "trust-boundary"]);
	});

	it("fails closed, with every lens unanswered, when the script has no answer for a lens it is asked about", async () => {
		const golden = goldens.find((each) => each.name === "docs-typo")!;
		const { "trust-boundary": _, ...answers } = golden.script.answers;
		expect(await runTriageGolden({ ...golden, script: { answers } }, { kind: "scripted" })).toEqual([
			{ correctness: "unanswered", "trust-boundary": "unanswered" },
		]);
	});

	it("measures a live model that answers through the decider's tool, once per pass", async () => {
		const golden = goldens.find((each) => each.name === "docs-typo")!;
		const fake = createFakeModels({ provider: "live-eval", models: [{ id: "judge" }] });
		const answer = (deep: number) =>
			fauxAssistantMessage(
				fauxToolCall("answer", {
					answers: ["correctness", "trust-boundary"].map((question) => ({
						question,
						probabilities: [
							{ option: "quick", probability: 1 - deep },
							{ option: "careful", probability: 0 },
							{ option: "deep", probability: deep },
						],
					})),
				}),
				{ stopReason: "toolUse" },
			);
		const requests = scriptConversations(fake, [
			{
				match: "You answer typed questions about a code change",
				replies: [answer(0.7), answer(0.2), answer(0.9)],
			},
		]);
		const telemetry: unknown[] = [];
		const chosen = await runTriageGolden(
			golden,
			{ kind: "live", models: fake.review, model: "live-eval/judge" },
			3,
			(record) => telemetry.push(record.toJSON()),
		);
		expect(telemetry).toHaveLength(3);
		expect(telemetry[0]).toMatchObject({
			total: { models: { "live-eval/judge": { totalTokens: expect.any(Number) } } },
		});
		expect(chosen.map((pass) => pass.correctness)).toEqual(["deep", "quick", "deep"]);
		expect(Object.values(requests).flat()).toHaveLength(3);
	});

	it("aborts a live run whose decider failed, with the failure, and never scores it as unanswered", async () => {
		const golden = goldens.find((each) => each.name === "docs-typo")!;
		const fake = createFakeModels({ provider: "live-eval", models: [{ id: "judge" }] });
		scriptConversations(fake, [
			{
				match: "You answer typed questions about a code change",
				replies: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 429 rate limited" })],
			},
		]);
		const failure: unknown = await runTriageGolden(golden, {
			kind: "live",
			models: fake.review,
			model: "live-eval/judge",
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(GoldenRunError);
		expect((failure as GoldenRunError).message).toMatch(/docs-typo.*HTTP 429 rate limited/);
		expect((failure as GoldenRunError).telemetry.total!.models["live-eval/judge"]!.totalTokens).toBeGreaterThan(0);
	});

	it("refuses a live model with no credentials", async () => {
		const fake = createFakeModels({ models: [{ id: "judge" }] });
		await expect(
			runTriageGolden(goldens[0]!, { kind: "live", models: fake.review, model: "nowhere/none" }),
		).rejects.toThrow("nowhere/none has no credentials");
	});

	it("does not retry a failed fake lens while measuring triage", async () => {
		const script = testing.scriptConversations;
		const requests: ReturnType<typeof script>[] = [];
		const scripted = vi.spyOn(testing, "scriptConversations").mockImplementation((fake, scripts) => {
			const seen = script(
				fake,
				scripts.map((each) => ({
					...each,
					replies: [
						fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 overloaded" }),
						...each.replies,
					],
				})),
			);
			requests.push(seen);
			return seen;
		});
		try {
			const golden = goldens.find((each) => each.name === "docs-typo")!;
			expect(await runTriageGolden(golden, { kind: "scripted" })).toEqual([golden.expected.levels]);
			expect(requests).toHaveLength(1);
			for (const seen of Object.values(requests[0]!)) expect(seen).toHaveLength(1);
		} finally {
			scripted.mockRestore();
		}
	});
});

describe("TriageResults", () => {
	it("costs a level for each level a choice is off, and the widest distance for none", () => {
		expect(TriageResults.distance(choice("careful", "careful"))).toBe(0);
		expect(TriageResults.distance(choice("careful", "deep"))).toBe(1);
		expect(TriageResults.distance(choice("quick", "deep"))).toBe(2);
		expect(TriageResults.distance(choice("deep", "skip"))).toBe(3);
		expect(TriageResults.distance(choice("careful", "unanswered"))).toBe(3);
	});

	it("reports the exact share, the mean distance, and the choices below the right level", () => {
		const results = measured([
			choice("careful", "careful"),
			choice("deep", "quick"),
			choice("quick", "deep"),
			choice("deep", "unanswered"),
		]);
		expect(results.exact()).toBe(0.25);
		expect(results.meanDistance()).toBe((0 + 2 + 2 + 3) / 4);
		expect(results.under()).toBe(1);
		expect(results.render()).toContain("exact 0.25, mean distance 1.75, 1 under");
		expect(results.render()).toContain("g / correctness: chose unanswered, should be deep");
		expect(measured([]).exact()).toBe(0);
		expect(measured([]).meanDistance()).toBe(0);
	});

	it("measures goldens' passes against their right levels", () => {
		const [first, second] = goldens;
		const results = TriageResults.measure(
			[first!, second!],
			{
				[first!.name]: [first!.expected.levels, first!.expected.levels],
				[second!.name]: [{ correctness: "quick", "trust-boundary": "quick" }],
			},
			{ model: "m", fingerprint: "f" },
		);
		expect(results.passes).toBe(2);
		expect(results.choices).toHaveLength(
			2 * Object.keys(first!.expected.levels).length + Object.keys(second!.expected.levels).length,
		);
		expect(results.questionSet).toEqual(triageQuestionSet);
	});

	it("reopens a version-1 measurement written at f6c53e38 as a complete version-3 baseline", () => {
		const text = readFileSync(new URL("./fixtures/triage-results-v1.json", import.meta.url), "utf8");
		const legacy = JSON.parse(text);
		const reopened = TriageResults.parse(text);
		expect(reopened.toJSON()).toEqual({ ...legacy, version: 3, complete: true });
		expect(TriageResults.parse(JSON.stringify(reopened.toJSON())).compare(reopened).verdict).toBe("same");
	});

	it("round-trips through JSON", () => {
		const results = measured([choice("deep", "careful")]);
		expect(TriageResults.parse(JSON.stringify(results.toJSON())).toJSON()).toEqual(results.toJSON());
	});

	describe("comparing a later measurement to a baseline", () => {
		const baseline = measured([choice("deep", "quick"), choice("quick", "quick")]);

		it("says better for a smaller mean distance, worse for a larger, and same for neither", () => {
			expect(measured([choice("deep", "careful"), choice("quick", "quick")], "2").compare(baseline).verdict).toBe(
				"better",
			);
			expect(measured([choice("deep", "quick"), choice("quick", "deep")], "2").compare(baseline).verdict).toBe(
				"worse",
			);
			expect(measured([choice("deep", "quick"), choice("quick", "quick")], "2").compare(baseline).verdict).toBe(
				"same",
			);
		});

		it("breaks a tie in distance by the exact share", () => {
			const wide = measured([choice("deep", "quick"), choice("deep", "deep")]);
			const near = measured([choice("deep", "careful"), choice("deep", "careful")]);
			expect(wide.meanDistance()).toBe(near.meanDistance());
			expect(wide.compare(near)).toMatchObject({ verdict: "better" });
			expect(near.compare(wide)).toMatchObject({ verdict: "worse" });
		});

		it("refuses a baseline measured with another decider model, and says which", () => {
			const other = measured(baseline.choices, "1", "a", "n");
			expect(other.compare(baseline)).toEqual({
				verdict: "incomparable",
				lines: expect.arrayContaining(["incomparable: the decider model differs, m -> n"]),
			});
			expect(measured(baseline.choices).compare(baseline).verdict).toBe("same");
		});

		it("refuses a baseline measured on another golden set, and says which", () => {
			const other = measured(baseline.choices, "1", "a", "m", ["g", "h"]);
			expect(other.compare(baseline)).toEqual({
				verdict: "incomparable",
				lines: expect.arrayContaining(["incomparable: the golden set differs, g -> g, h"]),
			});
			const old = TriageResults.parse(
				JSON.stringify({
					questionSet: { name: "triage", version: "1" },
					fingerprint: "a",
					model: "m",
					passes: 1,
					choices: [],
				}),
			);
			expect(measured(baseline.choices).compare(old).lines).toContain(
				"incomparable: the golden set differs, none recorded -> g",
			);
			expect(measured(baseline.choices, "1", "a", "m", ["g"]).compare(baseline).verdict).toBe("same");
		});

		it("does not order means within the tolerance, and does past it", () => {
			// Of 200 choices, one off by a level moves the mean distance, and the exact share, by 0.005: the tolerance.
			const twoHundred = (offBy: number): TriageChoice[] => [
				...Array.from({ length: offBy }, () => choice("deep", "careful")),
				...Array.from({ length: 200 - offBy }, () => choice("deep", "deep")),
			];
			expect(measured(twoHundred(19)).compare(measured(twoHundred(20))).verdict).toBe("same");
			expect(measured(twoHundred(18)).compare(measured(twoHundred(20))).verdict).toBe("better");
			expect(measured(twoHundred(21)).compare(measured(twoHundred(20))).verdict).toBe("same");
			expect(measured(twoHundred(22)).compare(measured(twoHundred(20))).verdict).toBe("worse");
		});

		it("lists the movement in each measure", () => {
			expect(measured([choice("deep", "deep"), choice("quick", "quick")], "2", "b").compare(baseline).lines).toEqual(
				["version 1 -> 2", "mean distance 1.00 -> 0.00", "exact 0.50 -> 1.00", "under 1 -> 0"],
			);
		});

		it("says when the questions changed and their version did not, and the reverse", () => {
			const same = [choice("deep", "deep")];
			expect(measured(same, "1", "b").compare(baseline).lines).toContain(
				"the questions changed and their version did not",
			);
			expect(measured(same, "2", "a").compare(baseline).lines).toContain(
				"the version changed and the questions did not",
			);
			const quiet = measured(same, "1", "a").compare(baseline).lines;
			expect(quiet.some((line) => line.startsWith("the "))).toBe(false);
			expect(
				measured(same, "2", "b")
					.compare(baseline)
					.lines.some((line) => line.startsWith("the ")),
			).toBe(false);
		});
	});
});

type RecordedFingerprints = Record<string, string>;

const recordPath = "packages/evals/triage/questions.json";
const gitIn =
	(cwd: string) =>
	(args: string[]): string =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function recordHistory(git: (args: string[]) => string): RecordedFingerprints[] {
	try {
		if (git(["rev-parse", "--is-shallow-repository"]).trim() !== "false")
			throw new Error("questions.json history is shallow");
		const commits = git(["log", "--full-history", "--format=%H", "HEAD", "--", `:(top)${recordPath}`])
			.trim()
			.split("\n");
		if (commits[0] === "") throw new Error("questions.json history is empty");
		if (
			commits.length === 1 &&
			git([
				"diff-tree",
				"--root",
				"--no-commit-id",
				"-r",
				"--diff-filter=A",
				"--name-only",
				commits[0]!,
				"--",
				`:(top)${recordPath}`,
			]).trim() !== recordPath
		)
			throw new Error("questions.json history holds only the commit under test, where the record is not new");
		return commits.map((commit) => {
			const record = JSON.parse(git(["show", `${commit}:${recordPath}`])) as
				| RecordedFingerprints
				| { questionSet: { name: string; version: string }; fingerprint: string };
			if (typeof record.questionSet === "object") return { [record.questionSet.version]: record.fingerprint };
			return record as RecordedFingerprints;
		});
	} catch (error) {
		throw new Error(`Cannot read complete questions.json history: ${String(error)}`);
	}
}

function recordProblems(
	recorded: RecordedFingerprints,
	version: string,
	fingerprint: string,
	history: readonly RecordedFingerprints[],
): string[] {
	const problems: string[] = [];
	if (recorded[version] === undefined) {
		problems.push(`questions.json records no fingerprint for version "${version}"`);
	} else if (recorded[version] !== fingerprint) {
		problems.push(
			`the questions changed and version "${version}" did not: bump triageQuestionSet.version and add its fingerprint ${fingerprint} to questions.json`,
		);
	}
	for (const entries of history) {
		for (const [recordedVersion, hash] of Object.entries(entries)) {
			if (recorded[recordedVersion] !== hash)
				problems.push(`version "${recordedVersion}" was recorded as ${hash} and must stay so`);
		}
	}
	return problems;
}

describe("the triage question set's version", () => {
	it("stands for the questions across every commit that recorded their version", async () => {
		const recorded = JSON.parse(
			readFileSync(join(triageDirectory, "questions.json"), "utf8"),
		) as RecordedFingerprints;
		const fingerprint = (await TriageQuestions.shipped(goldens[0]!)).fingerprint();
		expect(
			recordProblems(recorded, triageQuestionSet.version, fingerprint, recordHistory(gitIn(triageDirectory))),
		).toEqual([]);
	});

	it("rejects committed rewording under an old version, even before the parent, and accepts a new version", () => {
		const root = mkdtempSync(join(tmpdir(), "melian-record-history-"));
		const directory = join(root, "packages/evals/triage");
		const git = gitIn(root);
		const commit = (message: string) => {
			git(["add", "--all"]);
			git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message]);
		};
		try {
			mkdirSync(directory, { recursive: true });
			git(["init", "--quiet", "--initial-branch=snapshot"]);
			writeFileSync(
				join(directory, "questions.json"),
				'{"questionSet":{"name":"triage","version":"1"},"fingerprint":"aaaa"}',
			);
			writeFileSync(join(directory, "question.txt"), "Original question");
			commit("first version");
			expect(recordProblems({ "1": "aaaa" }, "1", "aaaa", recordHistory(gitIn(directory)))).toEqual([]);
			writeFileSync(join(directory, "question.txt"), "Reworded question");
			writeFileSync(join(directory, "questions.json"), '{"1":"bbbb"}');
			commit("rewrite old version");
			expect(recordProblems({ "1": "bbbb" }, "1", "bbbb", recordHistory(git))).toContain(
				'version "1" was recorded as aaaa and must stay so',
			);
			writeFileSync(join(root, "README.md"), "Unrelated parent");
			commit("unrelated parent");
			expect(recordProblems({ "1": "bbbb" }, "1", "bbbb", recordHistory(git))).toContain(
				'version "1" was recorded as aaaa and must stay so',
			);
			writeFileSync(join(directory, "questions.json"), '{"1":"aaaa","2":"bbbb"}');
			commit("add new version");
			expect(recordProblems({ "1": "aaaa", "2": "bbbb" }, "2", "bbbb", recordHistory(git))).toContain(
				'version "1" was recorded as bbbb and must stay so',
			);
			git(["reset", "--hard", "HEAD~3"]);
			writeFileSync(join(directory, "question.txt"), "Reworded question");
			writeFileSync(join(directory, "questions.json"), '{"1":"aaaa","2":"bbbb"}');
			commit("add new version without rewriting history");
			expect(recordProblems({ "1": "aaaa", "2": "bbbb" }, "2", "bbbb", recordHistory(git))).toEqual([]);
			expect(git(["for-each-ref", "--format=%(refname)"]).trim()).toBe("refs/heads/snapshot");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed on unreadable, empty, shallow or incomplete history", () => {
		const git = (args: string[]): string => {
			if (args[0] === "rev-parse") return "false";
			if (args[0] === "log") return "only";
			if (args[0] === "diff-tree") return "";
			throw new Error(`unexpected git ${args.join(" ")}`);
		};
		expect(() => recordHistory(git)).toThrow("record is not new");
		expect(() =>
			recordHistory(() => {
				throw new Error("unreadable");
			}),
		).toThrow("Cannot read complete questions.json history");
		expect(() => recordHistory((args) => (args[0] === "rev-parse" ? "true" : git(args)))).toThrow(
			"history is shallow",
		);
		expect(() => recordHistory((args) => (args[0] === "log" ? "" : git(args)))).toThrow("history is empty");
		expect(() => recordHistory((args) => (args[0] === "diff-tree" ? recordPath : git(args)))).toThrow(
			"unexpected git show",
		);
		expect(() =>
			recordHistory((args) => (args[0] === "show" ? "not json" : args[0] === "diff-tree" ? recordPath : git(args))),
		).toThrow("Cannot read complete questions.json history");
	});

	it("rejects a changed question, a missing current version and a deleted historical version", () => {
		expect(recordProblems({ "1": "aaaa" }, "1", "bbbb", [])).toContain(
			'the questions changed and version "1" did not: bump triageQuestionSet.version and add its fingerprint bbbb to questions.json',
		);
		expect(recordProblems({}, "2", "bbbb", [])).toContain('questions.json records no fingerprint for version "2"');
		expect(recordProblems({ "2": "bbbb" }, "2", "bbbb", [{ "1": "aaaa" }])).toContain(
			'version "1" was recorded as aaaa and must stay so',
		);
	});
	it("changes when a question's wording, its options, or a lens's name does", async () => {
		const { repo, base } = buildGoldenRepository(goldens[0]!);
		try {
			const lenses = await Lens.load(repo, { kind: "revision", commit: base }, ["a.ts"]);
			const before = TriageQuestions.of(lenses).fingerprint();
			const edit = (change: (json: ReturnType<Lens["toJSON"]>) => ReturnType<Lens["toJSON"]>) =>
				TriageQuestions.of(
					lenses.map((lens) => (lens.name === "tests" ? Lens.from(change(lens.toJSON())) : lens)),
				).fingerprint();
			expect(edit((json) => ({ ...json, description: `${json.description} More.` }))).not.toBe(before);
			expect(edit((json) => ({ ...json, instructions: "Changed body." }))).toBe(before);
			expect(TriageQuestions.of([...lenses].reverse()).fingerprint()).toBe(before);
			expect(TriageQuestions.of(lenses.slice(1)).fingerprint()).not.toBe(before);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

it("retains per-golden measurement cost through JSON reopening and prints it beside the score", () => {
	const golden = goldens[0]!;
	const usage = new TokenUsage({
		model: {
			input: 2,
			output: 3,
			cacheRead: 4,
			cacheWrite: 5,
			totalTokens: 14,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		},
	}).toJSON();
	expect(
		TriageResults.measure(
			[golden],
			{ [golden.name]: [golden.expected.levels] },
			{ model: "model", fingerprint: "test" },
		).toJSON(),
	).not.toHaveProperty("telemetry");
	const result = TriageResults.measure(
		[golden],
		{ [golden.name]: [golden.expected.levels] },
		{
			model: "model",
			fingerprint: "test",
			telemetry: {
				[golden.name]: [1, 2].map(
					() =>
						new StageTelemetry("base..head", [
							{
								id: "lens",
								task: 1,
								name: "melian.lens",
								subject: "test",
								outcome: "completed",
								timing: "unavailable",
								reused: false,
								resumed: false,
								usage,
							},
						]),
				),
			},
		},
	);
	const reopened = TriageResults.parse(JSON.stringify(result.toJSON()));
	expect(reopened.toJSON()).toMatchObject({
		telemetry: {
			[golden.name]: [expect.objectContaining({ total: usage }), expect.objectContaining({ total: usage })],
		},
	});
	expect(reopened.render()).toContain(`${golden.name}: exact 1.00, 28 tokens, $2`);
	expect(
		TriageResults.parse(JSON.stringify({ ...result.toJSON(), telemetry: undefined })).toJSON(),
	).not.toHaveProperty("telemetry");
});

it("scores each golden against its own choices beside its spend", () => {
	const [correct, missed] = goldens;
	const result = TriageResults.measure(
		[correct!, missed!],
		{ [correct!.name]: [correct!.expected.levels], [missed!.name]: [{}] },
		{ model: "fake/judge", fingerprint: "test", telemetry: { [correct!.name]: [], [missed!.name]: [] } },
	);
	expect(result.render().split("\n")).toContain(`${correct!.name}: exact 1.00, Token usage unavailable`);
	expect(result.render().split("\n")).toContain(`${missed!.name}: exact 0.00, Token usage unavailable`);
});

it.each([
	[undefined, "off", "incomparable"],
	["off", undefined, "incomparable"],
	["off", "high", "incomparable"],
	["high", "high", "same"],
	[undefined, undefined, "same"],
] as const)("compares baseline thinking %s with current %s as %s", (baseline, current, verdict) => {
	const stored = measured([choice("quick", "quick")]).toJSON();
	const earlier = TriageResults.parse(JSON.stringify({ ...stored, thinking: baseline }));
	const later = TriageResults.parse(JSON.stringify({ ...stored, thinking: current }));
	expect(later.compare(earlier).verdict).toBe(verdict);
	expect(later.render()).toContain(`thinking ${current ?? "unset"}`);
	if (verdict === "incomparable")
		expect(later.compare(earlier).lines).toContain(
			`incomparable: the triage thinking differs, ${baseline ?? "unset"} -> ${current ?? "unset"}`,
		);
});

it("retains the effective thinking level through measurement and JSON", () => {
	const result = TriageResults.measure(
		[goldens[0]!],
		{ [goldens[0]!.name]: [goldens[0]!.expected.levels] },
		{ model: "m", fingerprint: "f", thinking: "off" },
	);
	expect(result.toJSON()).toMatchObject({ version: 3, thinking: "off" });
	expect(TriageResults.parse(JSON.stringify(result.toJSON())).toJSON()).toEqual(result.toJSON());
	expect(result.render()).toContain("thinking off");
});

it("reopens the version-2 measurement with a distinct unset level", () => {
	const previous = readFileSync(new URL("./fixtures/triage-results-v2.json", import.meta.url), "utf8");
	const baseline = TriageResults.parse(previous);
	const reopened = TriageResults.parse(JSON.stringify(baseline.toJSON()));
	expect(reopened.toJSON()).toEqual({ ...JSON.parse(previous), version: 3 });
	expect(reopened.toJSON()).not.toHaveProperty("thinking");
	expect(reopened.compare(baseline).verdict).toBe("same");
	const off = TriageResults.parse(JSON.stringify({ ...baseline.toJSON(), thinking: "off" }));
	expect(off.compare(reopened).verdict).toBe("incomparable");
});
