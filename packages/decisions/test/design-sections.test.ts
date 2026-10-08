import { DesignSections, designIndexLimits } from "@melian-agent/decisions";
import { describe, expect, it } from "vitest";
import { gitIn, removeDirectory, temporaryDirectory, writeFiles } from "../../core/test/fixtures/repo.ts";

describe("base design vocabulary", () => {
	it("follows prose links while ignoring fenced examples and code spans", async () => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				"docs/design.md": [
					"# Design",
					"````md",
					"````ts",
					"[Example](missing-fenced.md#example)",
					"~~~",
					"```",
					"[Still fenced](missing-short-fence.md#example)",
					"`````",
					"`[Example](missing-inline.md#example)`",
					"``a ` [Example](missing-nested-span.md#example)``",
					"`multiline",
					"[Example](missing-multiline.md#example)`",
					"`unclosed span [Actual](architecture.md#markers)",
					"~~~md",
					"[Example](design/missing-tilde.md)",
					"~~~",
					"[Split](design/publish.md)",
					"```md",
					"```ts",
					"[Example](missing-trailing-text.md#example)",
					"```",
					"## Real policy",
					"```md",
					"[Unclosed fence](missing-unclosed-fence.md#example)",
				].join("\n"),
				"docs/architecture.md": "## Signed markers\n",
				"docs/design/publish.md": "## Republish trust\n",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			expect((await DesignSections.load(repo, "HEAD")).render().split("\n")).toEqual([
				"docs/design.md:1 — Design",
				"docs/design.md:22 — Real policy",
				"docs/architecture.md:1 — Signed markers",
				"docs/design/publish.md:1 — Republish trust",
			]);
		} finally {
			removeDirectory(repo);
		}
	});
	it("loads prose links on a backtick fence with an invalid info string", async () => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				"docs/design.md": "```md` [Actual](architecture.md#policy)\n## Real policy",
				"docs/architecture.md": "## Linked policy\n",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			expect((await DesignSections.load(repo, "HEAD")).render().split("\n")).toEqual([
				"docs/design.md:2 — Real policy",
				"docs/architecture.md:1 — Linked policy",
			]);
		} finally {
			removeDirectory(repo);
		}
	});
	it.each(["```", "~~~"])("keeps trailing text inside a %s fence", (marker) => {
		const rendered = DesignSections.from([
			{
				path: "docs/design.md",
				content: [
					`${marker}md`,
					`${marker}ts`,
					"## Example",
					`${marker} \ttext`,
					"## Still example",
					`   ${marker}${marker[0]} \t`,
					"## Real policy",
				].join("\n"),
			},
		]).render();
		expect(rendered).toBe("docs/design.md:7 — Real policy");
	});
	it("rejects backticks in opening info strings but permits them after tildes", () => {
		expect(
			DesignSections.from([
				{ path: "docs/design.md", content: "```md`\n## Real policy\n~~~md`\n## Example\n~~~\n## Outside" },
			])
				.render()
				.split("\n"),
		).toEqual(["docs/design.md:2 — Real policy", "docs/design.md:6 — Outside"]);
	});
	it("recognises a closing fence with CRLF endings", () => {
		expect(
			DesignSections.from([
				{ path: "docs/design.md", content: "```md\r\n## Example\r\n``` \t\r\n## Real policy" },
			]).render(),
		).toBe("docs/design.md:4 — Real policy");
	});
	it("keeps headings and line numbers, excluding examples and ordinary prose", () => {
		const rendered = DesignSections.from([
			{
				path: "docs/design.md",
				content: "# Design\n\n## Writer trust\nprose\n```md\n# Fake\n~~~\n``\n```\n### Signed markers\n",
			},
		]).render();
		expect(rendered.split("\n")).toEqual([
			"docs/design.md:1 — Design",
			"docs/design.md:3 — Writer trust",
			"docs/design.md:10 — Signed markers",
		]);
	});
	it("keeps a shorter fence from closing a longer one", () => {
		expect(
			DesignSections.from([{ path: "docs/design.md", content: "````md\n```\n# Inside\n````\n## Outside" }]).render(),
		).toBe("docs/design.md:5 — Outside");
	});
	it("pins the byte bound and refuses one byte past it with the omitted count", () => {
		expect(designIndexLimits).toEqual({ bytes: 65536 });
		const prefix = "docs/design.md:1 — ";
		const title = "x".repeat(65536 - Buffer.byteLength(prefix));
		expect(DesignSections.from([{ path: "docs/design.md", content: `# ${title}` }]).render()).toBe(prefix + title);
		expect(() =>
			DesignSections.from([{ path: "docs/design.md", content: `# ${title}\n## Another` }]).render(),
		).toThrow("2 headings omitted; review refused");
		for (const extra of ["x", "é"])
			expect(() =>
				DesignSections.from([{ path: "docs/design.md", content: `# ${title}${extra}` }]).render(),
			).toThrow("1 headings omitted; review refused");
	});
	it.each(["docs/design.md", "docs/architecture.md"])(
		"reads %s at 256 KiB and refuses one byte past it",
		async (path) => {
			const repo = temporaryDirectory();
			try {
				gitIn(repo, "init", "--quiet", "--initial-branch=main");
				writeFiles(repo, {
					"docs/design.md": "# Design\n[Section](architecture.md#section)\n",
					"docs/architecture.md": "# Architecture\n",
					[path]: `# Bound\n${"x".repeat(262144 - 8)}`,
				});
				gitIn(repo, "add", "--all");
				gitIn(repo, "commit", "--quiet", "-m", "bound");
				expect((await DesignSections.load(repo, "HEAD")).render()).toContain("— Bound");
				writeFiles(repo, { [path]: `# Bound\n${"x".repeat(262145 - 8)}` });
				gitIn(repo, "commit", "--quiet", "--all", "-m", "past");
				await expect(DesignSections.load(repo, "HEAD")).rejects.toMatchObject({ code: "tooLarge" });
			} finally {
				removeDirectory(repo);
			}
		},
	);
	it("loads base headings and linked sections, including a split design without a fragment", async () => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				"docs/design.md":
					"# Design\n## Writer trust\n[Markers](architecture.md#markers)\n[Duplicate](architecture.md#other)\n[Split design](design/publish.md)\n[Own section](design.md#writer-trust)\n[Package section](../packages/core/design.md#contracts)\n[External](https://example.com/design.md#title)\n",
				"docs/architecture.md": "## Signed markers\n",
				"docs/design/publish.md": "## Republish trust\n",
				"packages/core/design.md": "## Package contracts\n",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			writeFiles(repo, { "docs/design.md": "# Publisher eligibility\n", "docs/architecture.md": "## Receipts\n" });
			gitIn(repo, "commit", "--quiet", "--all", "-m", "head");
			expect((await DesignSections.load(repo, "HEAD~")).render().split("\n")).toEqual([
				"docs/design.md:1 — Design",
				"docs/design.md:2 — Writer trust",
				"docs/architecture.md:1 — Signed markers",
				"docs/design/publish.md:1 — Republish trust",
				"packages/core/design.md:1 — Package contracts",
			]);
			for (const [target, code] of [
				["../../outside.md#heading", "invalid"],
				["/absolute.md#heading", "invalid"],
				["missing.md#heading", "incomplete"],
			]) {
				writeFiles(repo, { "docs/design.md": `[Section](${target})\n` });
				gitIn(repo, "commit", "--quiet", "--all", "-m", "bad link");
				await expect(DesignSections.load(repo, "HEAD")).rejects.toMatchObject({ code });
			}
			gitIn(repo, "rm", "--quiet", "docs/design.md");
			gitIn(repo, "commit", "--quiet", "-m", "no design");
			expect((await DesignSections.load(repo, "HEAD")).render()).toBe("");
		} finally {
			removeDirectory(repo);
		}
	});
});
