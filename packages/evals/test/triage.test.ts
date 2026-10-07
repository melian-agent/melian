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
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { describe, expect, it } from "vitest";

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
		const chosen = await runTriageGolden(golden, { kind: "live", models: fake.review, model: "live-eval/judge" }, 3);
		expect(chosen.map((pass) => pass.correctness)).toEqual(["deep", "quick", "deep"]);
		expect(Object.values(requests).flat()).toHaveLength(3);
	});

	it("refuses a live model with no credentials", async () => {
		const fake = createFakeModels({ models: [{ id: "judge" }] });
		await expect(
			runTriageGolden(goldens[0]!, { kind: "live", models: fake.review, model: "nowhere/none" }),
		).rejects.toThrow("nowhere/none has no credentials");
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

// The record at origin/main: its entries, no record there yet, or a read git could not do.
type MainRecord =
	| { readonly kind: "recorded"; readonly entries: RecordedFingerprints }
	| { readonly kind: "absent" }
	| { readonly kind: "unreadable" };

// Why the record fails the gate, or nothing. A main that git could not read passes only off CI, where a checkout
// without origin/main is a developer's; on CI it is a gate that is off, so it fails.
function recordProblems(
	recorded: RecordedFingerprints,
	version: string,
	fingerprint: string,
	onMain: MainRecord,
	ci: boolean,
): string[] {
	const problems: string[] = [];
	if (recorded[version] === undefined) {
		problems.push(`questions.json records no fingerprint for version "${version}"`);
	} else if (recorded[version] !== fingerprint) {
		problems.push(
			`the questions changed and version "${version}" did not: bump triageQuestionSet.version and add its fingerprint ${fingerprint} to questions.json`,
		);
	}
	if (onMain.kind === "unreadable" && ci)
		problems.push(
			"git could not read origin/main, so a rewritten fingerprint would go unseen: fetch main before the gate",
		);
	if (onMain.kind === "recorded") {
		for (const [recordedVersion, hash] of Object.entries(onMain.entries)) {
			if (recorded[recordedVersion] !== hash)
				problems.push(`version "${recordedVersion}" is recorded on main as ${hash} and must stay so`);
		}
	}
	return problems;
}

const recordPath = "packages/evals/triage/questions.json";

// `git` runs a git command in the repository and returns its output, or throws. `ls-tree` succeeds with no output for
// a file main does not have and fails when it has no main to read, which `show` alone would not tell apart.
// `--full-tree` makes the path root-relative: `ls-tree` otherwise reads it from the directory git runs in.
function recordOnMain(git: (args: string[]) => string): MainRecord {
	try {
		if (git(["ls-tree", "--full-tree", "--name-only", "origin/main", "--", recordPath]).trim() === "") return { kind: "absent" };
		return {
			kind: "recorded",
			entries: JSON.parse(git(["show", `origin/main:${recordPath}`])) as RecordedFingerprints,
		};
	} catch {
		return { kind: "unreadable" };
	}
}

const gitIn =
	(cwd: string) =>
	(args: string[]): string =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const gitInTriageDirectory = gitIn(triageDirectory);

describe("the triage question set's version", () => {
	it("stands for the questions as recorded: change one, bump the version and add its fingerprint", async () => {
		const recorded = JSON.parse(
			readFileSync(join(triageDirectory, "questions.json"), "utf8"),
		) as RecordedFingerprints;
		const fingerprint = (await TriageQuestions.shipped(goldens[0]!)).fingerprint();
		expect(
			recordProblems(
				recorded,
				triageQuestionSet.version,
				fingerprint,
				recordOnMain(gitInTriageDirectory),
				process.env.CI !== undefined && process.env.CI !== "",
			),
		).toEqual([]);
	});

	it("rejects a rewritten question under its old version, a rewritten record, and a missing record", () => {
		const main: MainRecord = { kind: "recorded", entries: { "1": "aaaa" } };
		const absent: MainRecord = { kind: "absent" };
		expect(recordProblems({ "1": "aaaa" }, "1", "aaaa", main, true)).toEqual([]);
		expect(recordProblems({ "1": "aaaa", "2": "bbbb" }, "2", "bbbb", main, true)).toEqual([]);
		expect(recordProblems({ "1": "bbbb" }, "1", "bbbb", main, true)).toEqual([
			'version "1" is recorded on main as aaaa and must stay so',
		]);
		expect(recordProblems({ "1": "aaaa" }, "1", "bbbb", main, true)).toEqual([
			'the questions changed and version "1" did not: bump triageQuestionSet.version and add its fingerprint bbbb to questions.json',
		]);
		expect(recordProblems({ "1": "aaaa" }, "2", "bbbb", main, true)).toEqual([
			'questions.json records no fingerprint for version "2"',
		]);
		expect(recordProblems({ "1": "bbbb" }, "1", "bbbb", absent, true)).toEqual([]);
	});

	describe("reading the record at main", () => {
		const record = '{"1":"aaaa"}';
		const git = (outputs: Record<string, string | Error>) => (args: string[]) => {
			if (args[0] === "ls-tree" && !(args.includes("--full-tree") && args.at(-1) === recordPath))
				throw new Error(`ls-tree must read the root-relative path: git ${args.join(" ")}`);
			if (args[0] === "show" && args.at(-1) !== `origin/main:${recordPath}`)
				throw new Error(`show must read the record: git ${args.join(" ")}`);
			const output = outputs[args[0]!];
			if (output === undefined) throw new Error(`unexpected git ${args.join(" ")}`);
			if (output instanceof Error) throw output;
			return output;
		};

		describe("in a repository, from a subdirectory", () => {
			const run = (cwd: string, ...args: string[]) =>
				execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

			function repositoryWhereMain(records: boolean): { root: string; subdirectory: string } {
				const root = mkdtempSync(join(tmpdir(), "melian-record-main-"));
				const subdirectory = join(root, "packages", "evals", "triage");
				mkdirSync(subdirectory, { recursive: true });
				writeFileSync(join(root, "README.md"), "x\n");
				if (records) writeFileSync(join(subdirectory, "questions.json"), record);
				run(root, "init", "--quiet", "--initial-branch=trunk");
				run(root, "add", "-A");
				run(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "base");
				run(root, "update-ref", "refs/remotes/origin/main", "HEAD");
				return { root, subdirectory };
			}

			it("reads the entries main records", () => {
				const { root, subdirectory } = repositoryWhereMain(true);
				try {
					expect(recordOnMain(gitIn(subdirectory))).toEqual({ kind: "recorded", entries: { "1": "aaaa" } });
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			});

			it("calls a main without the file absent", () => {
				const { root, subdirectory } = repositoryWhereMain(false);
				try {
					expect(recordOnMain(gitIn(subdirectory))).toEqual({ kind: "absent" });
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			});
		});

		it("reads the entries main records", () => {
			expect(recordOnMain(git({ "ls-tree": `${recordPath}\n`, show: record }))).toEqual({
				kind: "recorded",
				entries: { "1": "aaaa" },
			});
		});

		it("calls a file main does not have absent, which passes on CI and off it", () => {
			const main = recordOnMain(git({ "ls-tree": "" }));
			expect(main).toEqual({ kind: "absent" });
			expect(recordProblems({ "1": "aaaa" }, "1", "aaaa", main, true)).toEqual([]);
			expect(recordProblems({ "1": "aaaa" }, "1", "aaaa", main, false)).toEqual([]);
		});

		it("calls a failed read unreadable, which fails on CI and is skipped off it", () => {
			const failures: Record<string, string | Error>[] = [
				{ "ls-tree": new Error("fatal: Not a valid object name origin/main") },
				{ "ls-tree": `${recordPath}\n`, show: new Error("fatal: bad object") },
				{ "ls-tree": `${recordPath}\n`, show: "not json" },
			];
			for (const failing of failures) {
				const main = recordOnMain(git(failing));
				expect(main).toEqual({ kind: "unreadable" });
				expect(recordProblems({ "1": "aaaa" }, "1", "aaaa", main, true)).toEqual([
					"git could not read origin/main, so a rewritten fingerprint would go unseen: fetch main before the gate",
				]);
				expect(recordProblems({ "1": "aaaa" }, "1", "aaaa", main, false)).toEqual([]);
			}
		});
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
