import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { compilePattern, type LinearPattern, matchesGlobs } from "../src/pattern.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

async function rootRule(name: string) {
	const { config } = await loadConfig(root, { kind: "worktree" }, ".");
	const rule = config.guardrails["forbidden-patterns"].rules[name];
	if (rule === undefined) throw new Error(`the root melian.yaml has no ${name} rule`);
	const compiled = compilePattern(rule.pattern);
	if (!compiled.ok) throw new Error(`${name} was refused: ${compiled.reason}`);
	return { rule, pattern: compiled.pattern };
}

function markdownLines(directory: string): string[] {
	return readdirSync(join(root, directory), { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".md"))
		.flatMap((file) => readFileSync(join(root, directory, file), "utf8").split("\n"));
}

const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");

describe("the bare-issue-reference guardrail", () => {
	it("is advisory, and leaves GitHub's templates and the golden corpus alone", async () => {
		const { rule } = await rootRule("bare-issue-reference");
		expect(rule.severity).toBe("P3");
		expect(matchesGlobs(rule.paths ?? [], "docs/design.md")).toBe(true);
		expect(matchesGlobs(rule.paths ?? [], "packages/core/AGENTS.md")).toBe(true);
		expect(matchesGlobs(rule.paths ?? [], ".github/pull_request_template.md")).toBe(false);
		expect(matchesGlobs(rule.paths ?? [], "packages/evals/goldens/x/head/docs/a.md")).toBe(false);
		expect(rule.message).toContain("AGENTS.md");
	});

	it.each([
		"This closes #12.",
		"#12 is open.",
		"See pull request #60, which landed.",
		"Fixed in #7",
		"- bump (see #123)",
		"The record of #50's fix.",
	])("fires on a bare mention: %s", async (line) => {
		const { pattern } = await rootRule("bare-issue-reference");
		expect(pattern.test(line)).toBe(true);
	});

	it.each([
		"[Pull request #60](https://github.com/melian-agent/melian/pull/60) closes [issue #22](https://github.com/melian-agent/melian/issues/22).",
		"The engine [#18](https://github.com/melian-agent/melian/pull/18) added for guardrails.",
		"Link text [#12 and #13](https://github.com/melian-agent/melian/pull/12) holds two.",
		"See the [record](../comparisons/2026-10-05-pr-51.md) and `#12` in code.",
		"https://github.com/melian-agent/melian/pull/12#issuecomment-1 and [a](#heading-2)",
		"## 3 Heading",
		'Run `melian review "#41"`, a command that takes the hash, or quote "#19".',
	])("stays quiet on a linked mention: %s", async (line) => {
		const { pattern } = await rootRule("bare-issue-reference");
		expect(pattern.test(line)).toBe(false);
	});

	it("agrees with a reading that strips whole Markdown links, on every line of the records and progress-log entries", async () => {
		const { pattern } = await rootRule("bare-issue-reference");
		const lines = [...markdownLines("packages/evals/comparisons"), ...markdownLines("docs/progress-log")];
		const bareOutsideLinks = (line: string) =>
			/(^|[\s(])#\d/.test(line.replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/`[^`]*`/g, ""));
		const linked = lines.filter((line) => /\]\([^)]*\)/.test(line) && !bareOutsideLinks(line));
		expect(linked.filter((line) => /#\d/.test(line)).length).toBeGreaterThan(20);
		expect(linked.filter((line) => pattern.test(line))).toEqual([]);
		const bare = lines.filter(bareOutsideLinks);
		expect(bare.length).toBeGreaterThan(20);
		expect(bare.filter((line) => !pattern.test(line))).toEqual([]);
	});
});

describe("the overlong-sentence guardrail", () => {
	const fires = (pattern: LinearPattern, count: number) => pattern.test(`${words(count)}.`);

	it("is advisory, and covers docs, the comparison records, and the README but not the golden corpus", async () => {
		const { rule } = await rootRule("overlong-sentence");
		expect(rule.severity).toBe("P3");
		for (const path of ["docs/design.md", "docs/decisions/a.md", "packages/evals/comparisons/a.md", "README.md"]) {
			expect(matchesGlobs(rule.paths ?? [], path), path).toBe(true);
		}
		for (const path of ["AGENTS.md", "packages/evals/goldens/x/head/docs/a.md", "packages/core/src/a.ts"]) {
			expect(matchesGlobs(rule.paths ?? [], path), path).toBe(false);
		}
		expect(rule.message).toContain("AGENTS.md");
	});

	it("fires on a sentence of 60 words and stays quiet on one of 24", async () => {
		const { pattern } = await rootRule("overlong-sentence");
		expect(fires(pattern, 60)).toBe(true);
		expect(fires(pattern, 24)).toBe(false);
	});

	it("draws the line at 45 words, whatever the spacing", async () => {
		const { pattern } = await rootRule("overlong-sentence");
		expect(fires(pattern, 44)).toBe(false);
		expect(fires(pattern, 45)).toBe(true);
		expect(pattern.test(`${words(45).replaceAll(" ", ",  ")}.`)).toBe(true);
	});

	it("counts a run, so a full stop, question mark, or exclamation mark resets it", async () => {
		const { pattern } = await rootRule("overlong-sentence");
		for (const stop of [".", "?", "!"]) expect(pattern.test(`${words(30)}${stop} ${words(30)}${stop}`)).toBe(false);
	});

	it("measures each table cell alone", async () => {
		const { pattern } = await rootRule("overlong-sentence");
		const cell = words(30);
		expect(pattern.test(`| ${cell} | ${cell} | ${cell} |`)).toBe(false);
		expect(pattern.test(`| ${words(60)} |`)).toBe(true);
	});

	it("counts through a semicolon or colon, which join clauses into one sentence", async () => {
		const { pattern } = await rootRule("overlong-sentence");
		const clause = words(30);
		expect(pattern.test(`${clause}; ${clause}: ${clause}`)).toBe(true);
		expect(pattern.test(`${words(22)}; ${words(22)}`)).toBe(false);
		expect(pattern.test(`${words(23)}; ${words(22)}`)).toBe(true);
		expect(pattern.test(`${words(22)}; ${words(22)}. ${words(22)}: ${words(22)}`)).toBe(false);
	});

	it("scans a very long line in linear time", async () => {
		const { pattern } = await rootRule("overlong-sentence");
		const line = Array.from({ length: 20_000 }, (_, index) => `word${index}`).join(". ");
		expect(pattern.test(line)).toBe(false);
		const started = performance.now();
		pattern.test(line);
		expect(performance.now() - started).toBeLessThan(5_000);
	});
});
