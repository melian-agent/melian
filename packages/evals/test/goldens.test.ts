import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Golden,
	loadGoldens,
	runGolden,
	scoreCorpus,
	scoreGolden,
	scriptedMismatches,
	selectGoldens,
} from "@melian-agent/evals";
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
			"trust-boundary-clean-summary",
			"trust-boundary-fail-open",
			"trust-boundary-policy-from-head",
			"trust-boundary-secret-env",
			"trust-boundary-terminal-escape",
		]);
	});
});

describe("the live flag", () => {
	it("keeps a golden whose expected.json sets live: false out of live runs, while the scripted runs below cover it", () => {
		expect(goldens.filter((golden) => !golden.live).map((golden) => golden.name)).toEqual([
			"pre-existing-beside-change",
		]);
	});

	it("rejects a live flag that is not a boolean", () => {
		const directory = mkdtempSync(join(tmpdir(), "melian-goldens-"));
		try {
			const golden = goldens.find((each) => each.name === "clean-rename")!;
			const copy = join(directory, golden.name);
			cpSync(golden.directory, copy, { recursive: true });
			const expected = JSON.parse(readFileSync(join(copy, "expected.json"), "utf8"));
			writeFileSync(join(copy, "expected.json"), JSON.stringify({ ...expected, live: "no" }));
			expect(() => loadGoldens(directory)).toThrow(/expected\.json: \/live /);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("MELIAN_EVAL_GOLDEN", { timeout: 60_000 }, () => {
	it("selects every golden when unset or empty, and only the named one when set", () => {
		expect(selectGoldens(goldens, undefined)).toEqual(goldens);
		expect(selectGoldens(goldens, "")).toEqual(goldens);
		expect(selectGoldens(goldens, "contracts-breaking-signature").map((golden) => golden.name)).toEqual([
			"contracts-breaking-signature",
		]);
	});

	it("refuses a name no golden has, listing the goldens", () => {
		expect(() => selectGoldens(goldens, "contracts")).toThrow(
			/^No golden is named contracts\. Goldens: clean-rename, contracts-breaking-signature, /,
		);
	});

	it("refuses a golden that sets live: false, since it runs scripted only", () => {
		expect(() => selectGoldens(goldens, "pre-existing-beside-change")).toThrow(
			/^pre-existing-beside-change sets live: false in its expected\.json, so it runs scripted only\.$/,
		);
	});

	it("exits live.ts with status 2, saying no golden has the name, when the name matches no golden", () => {
		const live = fileURLToPath(new URL("../src/live.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--conditions=@melian-agent/source", live], {
			env: { PATH: process.env.PATH, MELIAN_EVAL_LIVE: "1", MELIAN_EVAL_GOLDEN: "no-such-golden" },
			encoding: "utf8",
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/^No golden is named no-such-golden\./);
	});

	it("exits live.ts with status 2, saying the golden runs scripted only, when it sets live: false", () => {
		const live = fileURLToPath(new URL("../src/live.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--conditions=@melian-agent/source", live], {
			env: { PATH: process.env.PATH, MELIAN_EVAL_LIVE: "1", MELIAN_EVAL_GOLDEN: "pre-existing-beside-change" },
			encoding: "utf8",
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/^pre-existing-beside-change sets live: false .* runs scripted only\./);
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
