import { join } from "node:path";
import { type Golden, loadGoldens, runGolden, scoreCorpus, scoreGolden, scriptedMismatches } from "@melian-agent/evals";
import { describe, expect, it } from "vitest";

const goldens = loadGoldens();

describe("the golden corpus", () => {
	it("holds the corpus", () => {
		expect(goldens.map((golden) => golden.name)).toEqual([
			"clean-rename",
			"contracts-breaking-signature",
			"correctness-deleted-guard",
			"correctness-null-deref",
			"injection-in-comment",
			"pre-existing-beside-change",
		]);
	});
});

// Scripted runs replay each golden's canned lens replies on the fake model, so the plumbing from lens to findings
// document to rendered output runs in the gate. They prove the pipeline, not the lenses' judgement; live runs do that.
describe.each(goldens.map((golden): [string, Golden] => [golden.name, golden]))("scripted %s", (_, golden) => {
	it("finds exactly what the golden expects, with its cause, failure scenario, and evidence", async () => {
		const run = await runGolden(golden, { kind: "scripted" });

		expect(run.toolMismatches).toEqual([]);
		expect(scoreGolden(golden, run.findings)).toMatchObject({ precision: 1, recall: 1 });
		expect(scriptedMismatches(golden, run.findings)).toEqual([]);
		await expect(run.rendered).toMatchFileSnapshot(join(golden.directory, "scripted.txt"));
	});
});

describe("expectToolResult", () => {
	it("reports a scripted call whose result lacks the expected text, as a broken search would return", async () => {
		const golden = goldens.find((each) => each.name === "correctness-null-deref")!;
		const [read, , ...rest] = golden.script.correctness!;
		const broken = {
			...golden,
			script: {
				...golden.script,
				correctness: [
					read!,
					{
						calls: [
							{ name: "search", arguments: { pattern: "nowhere-at-all" }, expectToolResult: "src/org-chart.ts" },
						],
					},
					...rest,
				],
			},
		};
		const run = await runGolden(broken, { kind: "scripted" });
		expect(run.toolMismatches).toEqual([
			'correctness step 2: search returned "No matches.", expected it to contain "src/org-chart.ts"',
		]);
	});
});

describe("scriptedMismatches", () => {
	it("names a finding whose cause, failure scenario, or evidence differs from the golden's", async () => {
		const golden = goldens.find((each) => each.name === "contracts-breaking-signature")!;
		const run = await runGolden(golden, { kind: "scripted" });
		const [cart, price] = golden.expected.comments;
		const drifted = {
			...golden,
			expected: {
				...golden.expected,
				comments: [
					{ ...cart!, cause: "pre-existing" as const, failureScenario: "Something else." },
					{ ...price!, evidence: [{ file: "src/price.ts", line: 2, role: "cause" as const }] },
				],
			},
		};
		expect(scriptedMismatches(drifted, run.findings)).toEqual([
			"src/cart.ts broken-caller: cause affected, expected pre-existing",
			expect.stringMatching(/^src\/cart\.ts broken-caller: failure scenario "summary/),
			expect.stringMatching(/^src\/price\.ts wrong-result: evidence \[.*"revision":"base".*\], expected \[/),
		]);
		expect(scriptedMismatches(drifted, [])).toEqual([
			"src/cart.ts broken-caller: not reported",
			"src/price.ts wrong-result: not reported",
		]);
	});
});

describe("scoreGolden", () => {
	const nullDeref = goldens.find((each) => each.name === "correctness-null-deref");
	const finding = (path: string, rule: string) =>
		({
			ruleId: rule,
			properties: { path },
			locations: [{ physicalLocation: { artifactLocation: { uri: path } } }],
		}) as never;

	it("matches on file and rule", () => {
		expect(
			scoreGolden(nullDeref!, [finding("src/user.ts", "null-dereference"), finding("src/user.ts", "wrong-result")]),
		).toMatchObject({
			truePositives: 1,
			found: 1,
			precision: 0.5,
			recall: 1,
		});
		expect(scoreGolden(nullDeref!, [])).toMatchObject({ precision: 1, recall: 0 });
	});

	it("counts a second finding matching one expectation as a false positive", () => {
		expect(
			scoreGolden(nullDeref!, [
				finding("src/user.ts", "null-dereference"),
				finding("src/user.ts", "null-dereference"),
			]),
		).toMatchObject({ truePositives: 1, found: 1, precision: 0.5, recall: 1 });
	});

	it("averages over every finding in the corpus, not per golden", () => {
		const scores = [
			scoreGolden(nullDeref!, [finding("src/user.ts", "null-dereference")]),
			scoreGolden(goldens[0]!, [finding("src/main.ts", "wrong-result"), finding("src/main.ts", "state-ordering")]),
		];
		expect(scoreCorpus(scores)).toEqual({ precision: 1 / 3, recall: 1 });
	});
});
