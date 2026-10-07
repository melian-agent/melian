import { openSource } from "@melian-agent/core";
import { DecisionFile, DecisionFiles, decisionIndexLimits } from "@melian-agent/decisions";
import { describe, expect, it, vi } from "vitest";
import { gitIn, removeDirectory, temporaryDirectory, writeFiles } from "../../core/test/fixtures/repo.ts";

const a = "docs/decisions/2026-10-01-a.md";
const b = "docs/decisions/2026-10-02-b.md";
const c = "docs/decisions/2026-10-03-c.md";
const parse = (path: string, text: string) => DecisionFile.parse(path, text);

describe("written decisions", () => {
	it("parses a heading and linked, bare, multiple and repeated Supersedes targets", () => {
		expect(
			parse(
				c,
				`# Current\n\nSupersedes: [A](2026-10-01-a.md), for trust; 2026-10-02-b.md, for limits.\nSupersedes: docs/decisions/2026-10-01-a.md\n`,
			),
		).toMatchObject({ path: c, title: "Current", supersedes: [a, b] });
		expect(parse(a, "Supersedes: none.\n")).toMatchObject({ title: a, supersedes: [] });
	});

	it("does not supersede a contextual link after an explicit absence declaration", () => {
		for (const declaration of ["none.", "no decision file.", "None."])
			expect(parse(b, `# B\nSupersedes: ${declaration} Context: [A](2026-10-01-a.md).\n`).supersedes).toEqual([]);
	});

	it("marks every superseded decision inactive, including a chain and two successors", () => {
		const rendered = DecisionFiles.from([
			parse(c, "# C\nSupersedes: 2026-10-01-a.md, 2026-10-02-b.md\n"),
			parse(b, "# B\nSupersedes: 2026-10-01-a.md\n"),
			parse(a, "# A\n"),
		]).render();
		expect(rendered.split("\n").slice(0, 3)).toEqual([
			`[INACTIVE; superseded by ${c}, ${b}] ${a} — A`,
			`[INACTIVE; superseded by ${c}] ${b} — B`,
			`[ACTIVE] ${c} — C`,
		]);
	});

	it("refuses a missing target or a cycle, including a self-reference", () => {
		expect(() => DecisionFiles.from([parse(b, "# B\nSupersedes: 2026-10-01-a.md\n")])).toThrow(/supersedes absent/);
		expect(() =>
			DecisionFiles.from([parse(a, "Supersedes: 2026-10-02-b.md\n"), parse(b, "Supersedes: 2026-10-01-a.md\n")]),
		).toThrow(/cycle/);
		expect(() => DecisionFiles.from([parse(a, "Supersedes: 2026-10-01-a.md\n")])).toThrow(/cycle/);
		expect(DecisionFiles.from([]).render()).not.toContain("[and");
	});

	it("renders at the entry bound and one past it, resolving omitted successors first", () => {
		const files = Array.from({ length: decisionIndexLimits.entries }, (_, i) =>
			parse(`docs/decisions/2026-10-01-${String(i).padStart(3, "0")}.md`, `# Title ${i}\n`),
		);
		const at = DecisionFiles.from(files).render();
		expect(at.split("\n")).toHaveLength(decisionIndexLimits.entries + 1);
		expect(at).not.toContain("and 0 more");
		const extra = parse("docs/decisions/2026-10-02-last.md", "# Last\nSupersedes: 2026-10-01-000.md\n");
		const past = DecisionFiles.from([...files, extra]).render();
		expect(past).toContain("[and 1 more decisions");
		expect(past).toContain(`INACTIVE; superseded by ${extra.path}`);
		expect(past).not.toContain("[ACTIVE] docs/decisions/2026-10-02-last.md");
	});

	it("bounds each rendered row at the character bound and one past, with controls visible", () => {
		const prefix = `[ACTIVE] ${a} — `;
		const suffix = "";
		const title = "x".repeat(decisionIndexLimits.rowCharacters - prefix.length - suffix.length);
		expect(
			DecisionFiles.from([parse(a, `# ${title}`)])
				.render()
				.split("\n")[0],
		).toBe(prefix + title + suffix);
		expect(
			DecisionFiles.from([parse(a, `# ${title}x`)])
				.render()
				.split("\n")[0],
		).toBe(`${prefix}${title}x${suffix}`.slice(0, decisionIndexLimits.rowCharacters));
		expect(DecisionFiles.from([parse(a, "# hidden\ttitle")]).render()).toContain("hidden\\u0009title");
	});
});

describe("base decision reads", () => {
	it("loads base, including nested files removed at head, and ignores other directories", async () => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				[a]: "# Base title\n",
				[b]: "# B\nSupersedes: 2026-10-01-a.md\n",
				"docs/decisions/nested/2026-10-01-extra.md": "# Nested\n",
				"docs/progress-log/2026-10-01-other.md": "# Not a decision\n",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			gitIn(repo, "rm", "--quiet", b);
			writeFiles(repo, { [a]: "# Head title\n" });
			gitIn(repo, "commit", "--quiet", "--all", "-m", "head");
			const base = gitIn(repo, "rev-parse", "HEAD~");
			const rendered = (await DecisionFiles.open(repo, base)).render();
			expect(rendered).toContain(`[INACTIVE; superseded by ${b}] ${a} — Base title`);
			expect(rendered).toContain(`[ACTIVE] ${b} — B`);
			expect(rendered).toContain("— Nested");
			expect(rendered).not.toContain("Not a decision");
			expect(rendered).not.toContain("Head title");
			const source = await openSource(repo, { kind: "revision", commit: base });
			const read = vi.spyOn(Object.getPrototypeOf(source), "readText").mockResolvedValue(undefined);
			try {
				await expect(DecisionFiles.open(repo, base)).rejects.toMatchObject({ code: "incomplete" });
			} finally {
				read.mockRestore();
			}
		} finally {
			removeDirectory(repo);
		}
	});

	it("accepts the base read byte bound, rejects one past it, and loads an empty corpus", async () => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, { "src/index.ts": "export const answer = 42;\n" });
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "empty");
			expect((await DecisionFiles.open(repo, "HEAD")).render()).not.toContain("ACTIVE");
			writeFiles(repo, { [a]: `# Title\n${"x".repeat(256 * 1024 - 8)}` });
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "bound");
			expect((await DecisionFiles.open(repo, "HEAD")).render()).toContain("— Title");
			writeFiles(repo, { [a]: `# Title\n${"x".repeat(256 * 1024 - 7)}` });
			gitIn(repo, "commit", "--quiet", "--all", "-m", "past");
			await expect(DecisionFiles.open(repo, "HEAD")).rejects.toMatchObject({ code: "tooLarge" });
		} finally {
			removeDirectory(repo);
		}
	});
});
