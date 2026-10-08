import { DesignSections, designIndexLimits } from "@melian-agent/decisions";
import { describe, expect, it } from "vitest";
import { gitIn, removeDirectory, temporaryDirectory, writeFiles } from "../../core/test/fixtures/repo.ts";

describe("base design vocabulary", () => {
	it.each([
		{ name: "path with fragment", link: "[Trust](design/trust.md#writer-trust)", path: "docs/design/trust.md" },
		{ name: "split file", link: "[Trust](design/trust.md)", path: "docs/design/trust.md" },
		{ name: "relative split file", link: "[Trust](./design/trust.md)", path: "docs/design/trust.md" },
		{ name: "relative package", link: "[Trust](../packages/core/design.md#policy)", path: "packages/core/design.md" },
		{ name: "title", link: '[Trust](design/trust.md#writer-trust "Writer policy")', path: "docs/design/trust.md" },
		{
			name: "reference",
			link: "[Trust][policy]\n\n[policy]: design/trust.md#writer-trust",
			path: "docs/design/trust.md",
		},
		{
			name: "collapsed reference",
			link: "[Trust][]\n\n[Trust]: design/trust.md#writer-trust 'Writer policy'",
			path: "docs/design/trust.md",
		},
		{
			name: "shortcut reference",
			link: "[Trust]\n\n[Trust]: <design/trust.md#writer-trust> (Writer policy)",
			path: "docs/design/trust.md",
		},
		{
			name: "first reference definition",
			link: "[Trust][POLICY]\n\n[policy]: design/trust.md#writer-trust\n[policy]: missing.md#ignored",
			path: "docs/design/trust.md",
		},
		{ name: "encoded space", link: "[Trust](design/writer%20trust.md#policy)", path: "docs/design/writer trust.md" },
		{
			name: "encoded delimiter",
			link: "[Trust](design/writer%23trust.md#policy)",
			path: "docs/design/writer#trust.md",
		},
		{
			name: "colon in later segment",
			link: "[Trust](design/writer:trust.md#policy)",
			path: "docs/design/writer:trust.md",
		},
		{
			name: "percent-encoded scheme",
			link: "[Trust](https%3A//host/trust.md#policy)",
			path: "docs/https:/host/trust.md",
		},
		{ name: "encoded extension", link: "[Trust](design/trust%2Emd#policy)", path: "docs/design/trust.md" },
		{ name: "query and fragment", link: "[Trust](design/trust.md?view=1#policy)", path: "docs/design/trust.md" },
		{ name: "query", link: "[Trust](design/trust.md?view=1)", path: "docs/design/trust.md" },
		{
			name: "angle brackets",
			link: '[Trust](<design/writer trust.md> "Writer policy")',
			path: "docs/design/writer trust.md",
		},
		{
			name: "balanced parentheses",
			link: "[Trust](design/trust(writer).md#policy)",
			path: "docs/design/trust(writer).md",
		},
		{
			name: "escaped parentheses",
			link: "[Trust](design/trust\\(writer\\).md#policy)",
			path: "docs/design/trust(writer).md",
		},
		{
			name: "character references",
			link: "[Trust](design/trust&#40;writer&#41;.md#policy)",
			path: "docs/design/trust(writer).md",
		},
		{
			name: "CRLF reference",
			link: "[Trust][policy]\r\n\r\n[policy]: design/trust.md#writer-trust",
			path: "docs/design/trust.md",
		},
	])("loads or refuses the section named by $name", async ({ link, path }) => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				"docs/design.md": `# Design\r\n${link}\n\n[unused]: missing.md#ignored\n`,
				[path]: "## Writer trust\r\n",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			expect((await DesignSections.load(repo, "HEAD")).render().split("\n")).toEqual([
				"docs/design.md:1 — Design",
				`${path}:1 — Writer trust`,
			]);
			gitIn(repo, "rm", "--quiet", path);
			gitIn(repo, "commit", "--quiet", "-m", "missing section");
			await expect(DesignSections.load(repo, "HEAD")).rejects.toMatchObject({
				code: "incomplete",
				message: `The base design section ${path} is absent`,
			});
		} finally {
			removeDirectory(repo);
		}
	});
	it.each([
		"#writer-trust",
		"design.md#writer-trust",
		"https://example.com/design/missing.md#policy",
		"https://example.com/design/missing%ZZ.md#policy",
		"//example.com/design/missing.md#policy",
		"//example.com/design/missing%ZZ.md#policy",
		"//host/path.md#policy",
		"//localhost/path.md#policy",
		"//melian-repository/path.md#policy",
		"mailto:trust.md#policy",
		"data:trust.md#policy",
		"javascript:trust.md#policy",
		"C:/trust.md#policy",
		"HTTPS://host/trust.md#policy",
		"https://melian-repository/design/trust.md#policy",
		"file:///elsewhere/trust.md#policy",
		"file:design/trust.md#policy",
		"file://melian-repository/docs/design/trust.md#policy",
		"missing.md",
		"design/missing.txt#policy",
	])("keeps the design headings without reading a section for %s", async (target) => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, { "docs/design.md": `# Design\n[Trust](${target})\n` });
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			expect((await DesignSections.load(repo, "HEAD")).render()).toBe("docs/design.md:1 — Design");
		} finally {
			removeDirectory(repo);
		}
	});
	it.each([
		["https://[invalid]/trust.md#policy", "invalid URL"],
		["design/trust%ZZ.md#policy", "invalid URI encoding"],
		["design/trust%C3.md#policy", "invalid URI encoding"],
		["%2Fabsolute.md#policy", "outside the repository"],
		["%2Fabsolute.md", "outside the repository"],
		["design/%2E%2E/%2E%2E/%2E%2E/outside.md", "outside the repository"],
		["%2F%2Fexample.com/trust.md#policy", "outside the repository"],
		["%2E%2E/%2E%2E/outside.md#policy", "outside the repository"],
	])("refuses invalid decoded section %s", async (target, reason) => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, { "docs/design.md": `[Trust](${target})\n` });
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			await expect(DesignSections.load(repo, "HEAD")).rejects.toMatchObject({
				code: "invalid",
				message: expect.stringContaining(reason),
			});
		} finally {
			removeDirectory(repo);
		}
	});
	it("resolves CommonMark destinations while ignoring other prose links", async () => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				"docs/design.md": [
					"# Design",
					"[Balanced](design/trust(writer).md#policy)",
					"[Escaped](design/trust\\(writer\\).md#policy)",
					"[Entity](design/trust&#40;writer&#41;.md#policy)",
					'[Space](<design/writer trust.md> "Split section")',
					"[Plain markdown](missing.md)",
					"[Other file](design/missing.txt#policy)",
					"[External](https://example.com/design/trust.md#policy)",
					"![Image](design/missing.md#policy)",
					"`[Code][policy]`",
					"```md",
					"[Example][policy]",
					"```",
					"[policy]: missing.md#policy",
				].join("\n"),
				"docs/design/trust(writer).md": "## Writer trust\n",
				"docs/design/writer trust.md": "## Split trust\n",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			expect((await DesignSections.load(repo, "HEAD")).render().split("\n")).toEqual([
				"docs/design.md:1 — Design",
				"docs/design/trust(writer).md:1 — Writer trust",
				"docs/design/writer trust.md:1 — Split trust",
			]);
		} finally {
			removeDirectory(repo);
		}
	});
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
	it("keeps CRLF headings before and after a fence with their line numbers", () => {
		expect(
			DesignSections.from([
				{
					path: "docs/design.md",
					content: "# Design\r\n## Writer trust\r\n```md\r\n## Example\r\n``` \t\r\n## Real policy\r\n",
				},
			])
				.render()
				.split("\n"),
		).toEqual(["docs/design.md:1 — Design", "docs/design.md:2 — Writer trust", "docs/design.md:6 — Real policy"]);
	});
	it("loads CRLF design sections without following links in fenced examples", async () => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				"docs/design.md":
					"# Design\r\n```md\r\n[Example](missing.md#policy)\r\n## Example\r\n```\r\n## Real policy\r\n[Trust](design/trust.md)\r\n",
				"docs/design/trust.md": "## Writer trust\r\n",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "CRLF base");
			expect((await DesignSections.load(repo, "HEAD")).render().split("\n")).toEqual([
				"docs/design.md:1 — Design",
				"docs/design.md:6 — Real policy",
				"docs/design/trust.md:1 — Writer trust",
			]);
		} finally {
			removeDirectory(repo);
		}
	});
	it.each([
		{
			name: "Setext",
			content: "Design\n======\n\nWriter trust\n------------\nOnly signed writers are trusted.\n",
			rows: ["1 — Design", "4 — Writer trust"],
		},
		{
			name: "indented ATX",
			content: " # Design\n  ## Writer trust\n   ### Signed markers\n",
			rows: ["1 — Design", "2 — Writer trust", "3 — Signed markers"],
		},
		{
			name: "formatted ATX",
			content: "## Writer *trust* and `signed` [markers](policy.md) ##\n",
			rows: ["1 — Writer trust and signed markers"],
		},
		{
			name: "CRLF Setext",
			content: "Design\r\n======\r\n\r\nWriter trust\r\n------------\r\n",
			rows: ["1 — Design", "4 — Writer trust"],
		},
		{ name: "nested heading", content: "> ## Writer trust\n", rows: ["1 — Writer trust"] },
		{ name: "empty heading", content: "#\n", rows: ["1 — "] },
		{ name: "prose and indented code", content: "ordinary prose\n\n    ## Example\n\n\\# Escaped\n", rows: [] },
		{
			name: "fenced Setext example",
			content: "```md\nWriter trust\n------------\n```\n\nReal policy\n-----------\n",
			rows: ["6 — Real policy"],
		},
	])("indexes CommonMark $name headings at their source lines", ({ content, rows }) => {
		expect(DesignSections.from([{ path: "docs/design.md", content }]).render()).toBe(
			rows.map((row) => `docs/design.md:${row}`).join("\n"),
		);
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
	it("escapes controls in paths and headings on one physical row", () => {
		const rendered = DesignSections.from([
			{ path: "docs/design/a\nforged.md", content: "# Writer\ttrust\u001b[31m\u202e" },
		]).render();
		expect(rendered.split("\n")).toEqual(["docs/design/a\\u000aforged.md:1 — Writer\\u0009trust\\u001b[31m\\u202e"]);
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
