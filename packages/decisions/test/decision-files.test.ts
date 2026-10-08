import { openSource, visibleText } from "@melian-agent/core";
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

	it("resolves sibling, parent, child and repository-relative nested targets", () => {
		const nestedA = "docs/decisions/nested/2026-10-01-a.md";
		const nestedB = "docs/decisions/nested/2026-10-02-b.md";
		for (const target of ["2026-10-01-a.md", "docs/decisions/nested/2026-10-01-a.md"]) {
			const successor = parse(nestedB, `# Nested B\nSupersedes: [A](${target})`);
			expect(successor.supersedes).toEqual([nestedA]);
			const rendered = DecisionFiles.from([parse(a, "# Root A"), parse(nestedA, "# Nested A"), successor]).render();
			expect(rendered).toContain(`[ACTIVE] ${a} — Root A`);
			expect(rendered).toContain(`[INACTIVE; superseded by ${nestedB}] ${nestedA} — Nested A`);
		}
		expect(parse(nestedB, "# B\nSupersedes: ../2026-10-01-a.md").supersedes).toEqual([a]);
		expect(parse(b, "# B\nSupersedes: nested/2026-10-01-a.md").supersedes).toEqual([nestedA]);
	});
	it("uses a Markdown link’s destination without superseding its dated display name", () => {
		const nestedA = "docs/decisions/nested/2026-10-01-a.md";
		const successor = parse(b, "# B\nSupersedes: [2026-10-01-a.md](nested/2026-10-01-a.md)");
		expect(successor.supersedes).toEqual([nestedA]);
		expect(DecisionFiles.from([parse(nestedA, "# Nested A"), successor]).render()).toContain(
			`[INACTIVE; superseded by ${b}] ${nestedA} — Nested A`,
		);
		expect(DecisionFiles.from([parse(a, "# Root A"), parse(nestedA, "# Nested A"), successor]).render()).toContain(
			`[ACTIVE] ${a} — Root A`,
		);
		expect(
			parse(c, "# C\nSupersedes: [2026-10-01-a.md](nested/2026-10-01-a.md), 2026-10-02-b.md").supersedes,
		).toEqual([nestedA, b]);
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

	it("pins the byte bound and refuses one byte past it without shortening a title", () => {
		expect(decisionIndexLimits).toEqual({ bytes: 65536 });
		const prefix = `[ACTIVE] ${a} — `;
		const title = "x".repeat(65536 - Buffer.byteLength(prefix));
		expect(DecisionFiles.from([parse(a, `# ${title}`)]).render()).toBe(prefix + title);
		expect(() => DecisionFiles.from([parse(a, `# ${title}x`)]).render()).toThrow(
			"1 decisions omitted; review refused",
		);
		expect(() => DecisionFiles.from([parse(a, `# ${title.slice(1)}é`)]).render()).toThrow(
			"1 decisions omitted; review refused",
		);
		expect(DecisionFiles.from([parse(a, "# hidden\ttitle")]).render()).toContain("hidden\\u0009title");
	});
	it("names every omitted decision when the complete index cannot fit", () => {
		const files = [parse(a, `# ${"x".repeat(65536)}`), parse(b, "# B")];
		expect(() => DecisionFiles.from(files).render()).toThrow("2 decisions omitted; review refused");
	});
	it("lists every active path and full title at the repository base with headroom", async () => {
		const repo = process.cwd();
		const source = await openSource(repo, { kind: "revision", commit: "origin/main" });
		const paths = await source.findPaths(/^docs\/decisions\/.*\.md$/s);
		const files = await Promise.all(
			paths.map(async (path) => parse(path, (await source.readText(path, 256 * 1024))!)),
		);
		const inactive = new Set(files.flatMap((file) => [...file.supersedes]));
		const active = files.filter((file) => !inactive.has(file.path));
		expect(active.length).toBeGreaterThan(100);
		const rendered = (await DecisionFiles.load(repo, "origin/main")).render();
		for (const file of active)
			expect(rendered.split("\n")).toContain(visibleText(`[ACTIVE] ${file.path} — ${file.title}`));
		expect(Buffer.byteLength(rendered)).toBeLessThan(49152);
	}, 60_000);
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
				"docs/decisions/2026-10-01-line\nbreak.md": "# Newline path\n",
				"docs/progress-log/2026-10-01-other.md": "# Not a decision\n",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			gitIn(repo, "rm", "--quiet", b);
			writeFiles(repo, { [a]: "# Head title\n" });
			gitIn(repo, "commit", "--quiet", "--all", "-m", "head");
			const base = gitIn(repo, "rev-parse", "HEAD~");
			const rendered = (await DecisionFiles.load(repo, base)).render();
			expect(rendered).toContain(`[INACTIVE; superseded by ${b}] ${a} — Base title`);
			expect(rendered).toContain(`[ACTIVE] ${b} — B`);
			expect(rendered).toContain("— Nested");
			expect(rendered).toContain("2026-10-01-line\\u000abreak.md — Newline path");
			expect(rendered).not.toContain("Not a decision");
			expect(rendered).not.toContain("Head title");
			const source = await openSource(repo, { kind: "revision", commit: base });
			const read = vi.spyOn(Object.getPrototypeOf(source), "readText").mockResolvedValue(undefined);
			try {
				await expect(DecisionFiles.load(repo, base)).rejects.toMatchObject({ code: "incomplete" });
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
			expect((await DecisionFiles.load(repo, "HEAD")).render()).not.toContain("ACTIVE");
			writeFiles(repo, { [a]: `# Title\n${"x".repeat(256 * 1024 - 8)}` });
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "bound");
			expect((await DecisionFiles.load(repo, "HEAD")).render()).toContain("— Title");
			writeFiles(repo, { [a]: `# Title\n${"x".repeat(256 * 1024 - 7)}` });
			gitIn(repo, "commit", "--quiet", "--all", "-m", "past");
			await expect(DecisionFiles.load(repo, "HEAD")).rejects.toMatchObject({ code: "tooLarge" });
		} finally {
			removeDirectory(repo);
		}
	});
});
