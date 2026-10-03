import { join } from "node:path";
import { type Golden, loadGoldens, runGolden, scoreCorpus, scoreGolden } from "@melian-agent/evals";
import { describe, expect, it } from "vitest";

const goldens = loadGoldens();

describe("the golden corpus", () => {
	it("holds the corpus", () => {
		expect(goldens.map((golden) => golden.name)).toEqual([
			"clean-rename",
			"contracts-breaking-signature",
			"correctness-null-deref",
			"injection-in-comment",
		]);
	});
});

// Scripted runs replay each golden's canned lens replies on the fake model, so the plumbing from lens to findings
// document to rendered output runs in the gate. They prove the pipeline, not the lenses' judgement; live runs do that.
describe.each(goldens.map((golden): [string, Golden] => [golden.name, golden]))("scripted %s", (_, golden) => {
	it("finds exactly what the golden expects, with the expected cause", async () => {
		const run = await runGolden(golden, { kind: "scripted" });

		expect(scoreGolden(golden, run.findings)).toMatchObject({ precision: 1, recall: 1 });
		const causes = Object.fromEntries(
			run.findings.map((finding) => [`${finding.properties.path}:${finding.ruleId}`, finding.properties.cause]),
		);
		for (const comment of golden.expected.comments)
			expect(causes[`${comment.file}:${comment.rule}`]).toBe(comment.cause);
		await expect(run.rendered).toMatchFileSnapshot(join(golden.directory, "scripted.txt"));
	});
});

describe("scoreGolden", () => {
	const [, , nullDeref] = goldens;
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

	it("averages over every finding in the corpus, not per golden", () => {
		const scores = [
			scoreGolden(nullDeref!, [finding("src/user.ts", "null-dereference")]),
			scoreGolden(goldens[0]!, [finding("src/main.ts", "wrong-result"), finding("src/main.ts", "state-ordering")]),
		];
		expect(scoreCorpus(scores)).toEqual({ precision: 1 / 3, recall: 1 });
	});
});
