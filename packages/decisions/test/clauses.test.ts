import { DecisionFile } from "@melian-agent/decisions";
import { describe, expect, it } from "vitest";

const path = "docs/decisions/old.md";

describe("decision clause evidence", () => {
	it.each(["\r", "\r\n", "\n"])("uses LF evidence coordinates for %j source endings", (ending) => {
		const content = ["# Old", "", "Keep this", "rule."].join(ending);
		const first = ending === "\r" ? 1 : 3;
		const last = ending === "\r" ? 1 : 4;
		expect(DecisionFile.parse(path, content).clauses()).toEqual([
			{ text: "Keep this rule.", line: first, endLine: last },
		]);
	});
	it.each(["\r", "\r\n", "\n"])("uses LF table-row coordinates for %j source endings", (ending) => {
		const content = ["# Old", "", "Rule | Choice", "--- | ---", "Retry | Stop."].join(ending);
		expect(
			DecisionFile.parse(path, content)
				.clauses()
				.map((clause) => [clause.line, clause.endLine]),
		).toEqual(
			ending === "\r"
				? [
						[1, 1],
						[1, 1],
						[1, 1],
					]
				: [
						[3, 3],
						[4, 4],
						[5, 5],
					],
		);
	});
	it("collapses whitespace before segmenting hard-wrapped prose", () => {
		const decision = DecisionFile.parse(
			path,
			"# Old\n\nThis clarifies the nested policy rule for\npull request #147. Another rule holds.\n",
		);
		expect(decision.clauses()).toEqual([
			{ text: "This clarifies the nested policy rule for pull request #147.", line: 3, endLine: 4 },
			{ text: "Another rule holds.", line: 3, endLine: 4 },
		]);
	});

	it("keeps inline code whole, including leading dots and sentence punctuation", () => {
		const decision = DecisionFile.parse(path, "Agents can open `.Agents/Lenses/...`. Keep `x. Y! z?` whole. End.");
		expect(decision.clauses().map((clause) => clause.text)).toEqual([
			"Agents can open .Agents/Lenses/....",
			"Keep x. Y! z? whole.",
			"End.",
		]);
	});

	it("preserves sentence boundaries before uppercase inline code", () => {
		expect(
			DecisionFile.parse(path, "Stop. `Active!Again。Now` stays.")
				.clauses()
				.map((clause) => clause.text),
		).toEqual(["Stop.", "Active!Again。Now stays."]);
	});

	it("keeps UTF-16 offsets when masking an astral sentence terminal in code", () => {
		const terminal = String.fromCodePoint(0x10a56);
		const text = `Keep First${terminal} Next whole.`;
		expect(
			DecisionFile.parse(path, `Keep \`First${terminal} Next\` whole.`)
				.clauses()
				.map((clause) => clause.text),
		).toEqual([text]);
	});

	it.each(["Supersedes", "Amends"])("excludes only the %s declaration line", (kind) => {
		const decision = DecisionFile.parse(path, `Before.\n${kind}: none.\nKeep this rule.\nDate: 2026-10-18.`);
		expect(decision.clauses().map((clause) => clause.text)).toEqual([
			"Before.",
			"Keep this rule.",
			"Date: 2026-10-18.",
		]);
	});

	it("keeps an indented continuation in its original paragraph after excluding the declaration", () => {
		expect(
			DecisionFile.parse(path, "Supersedes: none.\n    Keep this rule.")
				.clauses()
				.map((clause) => clause.text),
		).toEqual(["Keep this rule."]);
	});

	it("does not project another paragraph's declaration onto decoded list line endings", () => {
		expect(
			DecisionFile.parse(path, "- Keep&#10;list&#10;text.\n\nSupersedes: none.\nBody.")
				.clauses()
				.map((clause) => clause.text),
		).toEqual(["Keep list text.", "Body."]);
	});

	it("excludes code on the declaration line and keeps code on later lines", () => {
		expect(
			DecisionFile.parse(path, "Supersedes: `example`.\nKeep `this\ncode` whole.")
				.clauses()
				.map((clause) => clause.text),
		).toEqual(["Keep this code whole."]);
	});

	it("refuses a cooked code span that crosses an excluded declaration line", () => {
		expect(() => DecisionFile.parse(path, "Supersedes: `example\ncontinued`\nKeep this rule.").clauses()).toThrow(
			"code span crosses an excluded declaration line",
		);
	});

	it("reads a table as one source clause per row without a GFM extension", () => {
		const decision = DecisionFile.parse(
			path,
			"# Rules\n\n| Rule | Choice |\n| --- | --- |\n| Retry | Stop. Never repeat. |\n| Path | `.Agents/Lenses/...` |\n",
		);
		expect(decision.clauses()).toEqual([
			{ text: "| Rule | Choice |", line: 3, endLine: 3 },
			{ text: "| --- | --- |", line: 4, endLine: 4 },
			{ text: "| Retry | Stop. Never repeat. |", line: 5, endLine: 5 },
			{ text: "| Path | `.Agents/Lenses/...` |", line: 6, endLine: 6 },
		]);
	});

	it("keeps table rows without leading pipes and excludes a preceding declaration line", () => {
		expect(
			DecisionFile.parse(path, "Supersedes: none.\nRule | Choice\n--- | ---\nRetry | Stop. Never repeat.").clauses(),
		).toEqual([
			{ text: "Rule | Choice", line: 2, endLine: 2 },
			{ text: "--- | ---", line: 3, endLine: 3 },
			{ text: "Retry | Stop. Never repeat.", line: 4, endLine: 4 },
		]);
	});

	it("excludes reference image alt text and retains hard-break spacing", () => {
		expect(
			DecisionFile.parse(path, "Keep ![Image sentence.][image] this  \nrule.\n\n[image]: image.png")
				.clauses()
				.map((clause) => clause.text),
		).toEqual(["Keep this rule."]);
	});

	it("retains list prose, link labels and decoded formatting but excludes examples and metadata", () => {
		const decision = DecisionFile.parse(
			path,
			[
				"---",
				"name: Metadata sentence.",
				"---",
				"# Heading sentence.",
				"",
				"- Keep **list** &amp; `code`.",
				"",
				"> Quoted rule.",
				"",
				"~~~md",
				"Fenced rule.",
				"~~~",
				"",
				"    Indented rule.",
				"",
				"<div>",
				"HTML block.",
				"</div>",
				"",
				"Keep [labels][ref] and <em>text</em>. ![Image sentence.](image.png)",
				"",
				"[ref]: old.md",
			].join("\n"),
		);
		expect(decision.clauses().map((clause) => clause.text)).toEqual(["Keep list & code.", "Keep labels and text."]);
	});

	it("excludes Retired sections until the next root heading of equal or lesser depth", () => {
		const decision = DecisionFile.parse(
			path,
			[
				"# Old",
				"",
				"Active.",
				"",
				"## Retired",
				"",
				"Gone.",
				"",
				"### Detail",
				"",
				"Also gone.",
				"",
				"## Current",
				"",
				"Survives.",
				"",
				"## Retired clauses",
				"",
				"Included as ordinary prose.",
			].join("\n"),
		);
		expect(decision.clauses().map((clause) => clause.text)).toEqual([
			"Active.",
			"Survives.",
			"Included as ordinary prose.",
		]);
	});

	it("restores used reference labels after removing a declaration from its paragraph", () => {
		const decision = DecisionFile.parse(path, "Supersedes: none.\nKeep [the rule][rule].\n\n[rule]: old.md");
		expect(decision.clauses().map((clause) => clause.text)).toEqual(["Keep the rule."]);
	});

	it("fails closed when sentence segmentation is unavailable", () => {
		expect(DecisionFile.parse(path, "Keep this rule.").clauses()).toHaveLength(1);
		const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
		try {
			Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
			expect(() => DecisionFile.parse(path, "Keep this rule.").clauses()).toThrow();
		} finally {
			Object.defineProperty(Intl, "Segmenter", descriptor);
		}
	});

	it("keeps a nested Retired heading inside its enclosing retired section", () => {
		const decision = DecisionFile.parse(
			path,
			"## Retired\n\nGone.\n\n### Retired\n\nGone too.\n\n### Sibling\n\nStill gone.\n\n## Current\n\nActive.",
		);
		expect(decision.clauses().map((clause) => clause.text)).toEqual(["Active."]);
	});

	it("does not treat a nested heading as a root Retired section", () => {
		const decision = DecisionFile.parse(path, "- ## Retired\n\n  Keep the list rule.\n\nOutside.");
		expect(decision.clauses().map((clause) => clause.text)).toEqual(["Keep the list rule.", "Outside."]);
	});

	it("carries normalised sentences regardless of order or duplicate counts", () => {
		const target = DecisionFile.parse(path, "Keep **one**. Keep two. Keep one.");
		expect(target.uncarriedBy(DecisionFile.parse("docs/decisions/new.md", "Keep two. Keep one."))).toEqual([]);
		expect(
			target.uncarriedBy(DecisionFile.parse("docs/decisions/new.md", "Keep one.")).map((clause) => clause.text),
		).toEqual(["Keep two."]);
	});
});
