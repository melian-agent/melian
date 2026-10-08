import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DesignSections, designIndexLimits } from "@melian-agent/decisions";
import { describe, expect, it } from "vitest";
import { gitIn, removeDirectory, temporaryDirectory, writeFiles } from "../../core/test/fixtures/repo.ts";

type Expected = { expected: string; error?: never } | { expected?: never; error: { code: string; message?: string } };
type SectionCase = Expected & { name: string } & (
		| { kind: "headings"; files: { path: string; content: string }[] }
		| {
				kind: "revision";
				files: Record<string, string>;
				head?: Record<string, string>;
				remove?: string[];
				worktree?: Record<string, string>;
				symlink?: { path: string; target: string };
				revision?: string;
		  }
	);

const indexPrefix = "docs/design.md:1 — ";
const indexTitle = "x".repeat(65536 - Buffer.byteLength(indexPrefix));
const cases: SectionCase[] = [
	{
		name: "path with fragment: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md#writer-trust)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "path with fragment: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md#writer-trust)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "split file: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "split file: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](design/trust.md)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "relative split file: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](./design/trust.md)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "relative split file: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](./design/trust.md)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "relative package: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](../packages/core/design.md#policy)\n\n[unused]: missing.md#ignored\n",
			"packages/core/design.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\npackages/core/design.md:1 — Writer trust",
	},
	{
		name: "relative package: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](../packages/core/design.md#policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section packages/core/design.md is absent" },
	},
	{
		name: "title: present",
		kind: "revision",
		files: {
			"docs/design.md":
				'# Design\r\n[Trust](design/trust.md#writer-trust "Writer policy")\n\n[unused]: missing.md#ignored\n',
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "title: absent",
		kind: "revision",
		files: {
			"docs/design.md":
				'# Design\r\n[Trust](design/trust.md#writer-trust "Writer policy")\n\n[unused]: missing.md#ignored\n',
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "reference: present",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][policy]\n\n[policy]: design/trust.md#writer-trust\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "reference: absent",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][policy]\n\n[policy]: design/trust.md#writer-trust\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "collapsed reference: present",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][]\n\n[Trust]: design/trust.md#writer-trust 'Writer policy'\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "collapsed reference: absent",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][]\n\n[Trust]: design/trust.md#writer-trust 'Writer policy'\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "shortcut reference: present",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust]\n\n[Trust]: <design/trust.md#writer-trust> (Writer policy)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "shortcut reference: absent",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust]\n\n[Trust]: <design/trust.md#writer-trust> (Writer policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "first reference definition: present",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][POLICY]\n\n[policy]: design/trust.md#writer-trust\n[policy]: missing.md#ignored\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "first reference definition: absent",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][POLICY]\n\n[policy]: design/trust.md#writer-trust\n[policy]: missing.md#ignored\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "encoded space: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer%20trust.md#policy)\n\n[unused]: missing.md#ignored\n",
			"docs/design/writer trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/writer trust.md:1 — Writer trust",
	},
	{
		name: "encoded space: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer%20trust.md#policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/writer trust.md is absent" },
	},
	{
		name: "encoded delimiter: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer%23trust.md#policy)\n\n[unused]: missing.md#ignored\n",
			"docs/design/writer#trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/writer#trust.md:1 — Writer trust",
	},
	{
		name: "encoded delimiter: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer%23trust.md#policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/writer#trust.md is absent" },
	},
	{
		name: "colon in later segment: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer:trust.md#policy)\n\n[unused]: missing.md#ignored\n",
			"docs/design/writer:trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/writer:trust.md:1 — Writer trust",
	},
	{
		name: "colon in later segment: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer:trust.md#policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/writer:trust.md is absent" },
	},
	{
		name: "percent-encoded scheme: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](https%3A//host/trust.md#policy)\n\n[unused]: missing.md#ignored\n",
			"docs/https:/host/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/https:/host/trust.md:1 — Writer trust",
	},
	{
		name: "percent-encoded scheme: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](https%3A//host/trust.md#policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/https:/host/trust.md is absent" },
	},
	{
		name: "encoded extension: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust%2Emd#policy)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "encoded extension: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](design/trust%2Emd#policy)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "query and fragment: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md?view=1#policy)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "query and fragment: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md?view=1#policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "query: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md?view=1)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "query: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](design/trust.md?view=1)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "angle brackets: present",
		kind: "revision",
		files: {
			"docs/design.md":
				'# Design\r\n[Trust](<design/writer trust.md> "Writer policy")\n\n[unused]: missing.md#ignored\n',
			"docs/design/writer trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/writer trust.md:1 — Writer trust",
	},
	{
		name: "angle brackets: absent",
		kind: "revision",
		files: {
			"docs/design.md":
				'# Design\r\n[Trust](<design/writer trust.md> "Writer policy")\n\n[unused]: missing.md#ignored\n',
		},
		error: { code: "incomplete", message: "The base design section docs/design/writer trust.md is absent" },
	},
	{
		name: "balanced parentheses: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust(writer).md#policy)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust(writer).md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust(writer).md:1 — Writer trust",
	},
	{
		name: "balanced parentheses: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust(writer).md#policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust(writer).md is absent" },
	},
	{
		name: "escaped parentheses: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust\\(writer\\).md#policy)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust(writer).md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust(writer).md:1 — Writer trust",
	},
	{
		name: "escaped parentheses: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust\\(writer\\).md#policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust(writer).md is absent" },
	},
	{
		name: "character references: present",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust](design/trust&#40;writer&#41;.md#policy)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust(writer).md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust(writer).md:1 — Writer trust",
	},
	{
		name: "character references: absent",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust](design/trust&#40;writer&#41;.md#policy)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust(writer).md is absent" },
	},
	{
		name: "CRLF reference: present",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][policy]\r\n\r\n[policy]: design/trust.md#writer-trust\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "CRLF reference: absent",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][policy]\r\n\r\n[policy]: design/trust.md#writer-trust\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "ignored destination: #writer-trust",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](#writer-trust)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: design.md#writer-trust",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](design.md#writer-trust)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: https://example.com/design/missing.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](https://example.com/design/missing.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: https://example.com/design/missing%ZZ.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](https://example.com/design/missing%ZZ.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: //example.com/design/missing.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](//example.com/design/missing.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: //example.com/design/missing%ZZ.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](//example.com/design/missing%ZZ.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: //host/path.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](//host/path.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: //localhost/path.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](//localhost/path.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: //melian-repository/path.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](//melian-repository/path.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: mailto:trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](mailto:trust.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: data:trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](data:trust.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: javascript:trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](javascript:trust.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: C:/trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](C:/trust.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: HTTPS://host/trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](HTTPS://host/trust.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: https://melian-repository/design/trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](https://melian-repository/design/trust.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: file:///elsewhere/trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](file:///elsewhere/trust.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: file:design/trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](file:design/trust.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: file://melian-repository/docs/design/trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](file://melian-repository/docs/design/trust.md#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: missing.md",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](missing.md)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored destination: design/missing.txt#policy",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](design/missing.txt#policy)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "invalid destination: https://[invalid]/trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "[Trust](https://[invalid]/trust.md#policy)\n" },
		error: { code: "invalid", message: "invalid URL" },
	},
	{
		name: "invalid destination: design/trust%ZZ.md#policy",
		kind: "revision",
		files: { "docs/design.md": "[Trust](design/trust%ZZ.md#policy)\n" },
		error: { code: "invalid", message: "invalid URI encoding" },
	},
	{
		name: "invalid destination: design/trust%C3.md#policy",
		kind: "revision",
		files: { "docs/design.md": "[Trust](design/trust%C3.md#policy)\n" },
		error: { code: "invalid", message: "invalid URI encoding" },
	},
	{
		name: "invalid destination: %2Fabsolute.md#policy",
		kind: "revision",
		files: { "docs/design.md": "[Trust](%2Fabsolute.md#policy)\n" },
		error: { code: "invalid", message: "outside the repository" },
	},
	{
		name: "invalid destination: %2Fabsolute.md",
		kind: "revision",
		files: { "docs/design.md": "[Trust](%2Fabsolute.md)\n" },
		error: { code: "invalid", message: "outside the repository" },
	},
	{
		name: "invalid destination: design/%2E%2E/%2E%2E/%2E%2E/outside.md",
		kind: "revision",
		files: { "docs/design.md": "[Trust](design/%2E%2E/%2E%2E/%2E%2E/outside.md)\n" },
		error: { code: "invalid", message: "outside the repository" },
	},
	{
		name: "invalid destination: %2F%2Fexample.com/trust.md#policy",
		kind: "revision",
		files: { "docs/design.md": "[Trust](%2F%2Fexample.com/trust.md#policy)\n" },
		error: { code: "invalid", message: "outside the repository" },
	},
	{
		name: "invalid destination: %2E%2E/%2E%2E/outside.md#policy",
		kind: "revision",
		files: { "docs/design.md": "[Trust](%2E%2E/%2E%2E/outside.md#policy)\n" },
		error: { code: "invalid", message: "outside the repository" },
	},
	{
		name: "single-quoted title: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md 'Writer policy')\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "single-quoted title: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md 'Writer policy')\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "parenthesised title: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md (Writer policy))\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "parenthesised title: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/trust.md (Writer policy))\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "reference whitespace: present",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][ Writer   policy ]\n\n[writer policy]: design/trust.md\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "reference whitespace: absent",
		kind: "revision",
		files: {
			"docs/design.md":
				"# Design\r\n[Trust][ Writer   policy ]\n\n[writer policy]: design/trust.md\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "normalised split path: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/nested/../trust.md)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "normalised split path: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](design/nested/../trust.md)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "colon directory: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer:trust/policy.md)\n\n[unused]: missing.md#ignored\n",
			"docs/design/writer:trust/policy.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/writer:trust/policy.md:1 — Writer trust",
	},
	{
		name: "colon directory: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer:trust/policy.md)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/writer:trust/policy.md is absent" },
	},
	{
		name: "encoded colon directory: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer%3Atrust/policy.md)\n\n[unused]: missing.md#ignored\n",
			"docs/design/writer:trust/policy.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/writer:trust/policy.md:1 — Writer trust",
	},
	{
		name: "encoded colon directory: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer%3Atrust/policy.md)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/writer:trust/policy.md is absent" },
	},
	{
		name: "encoded query delimiter: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer%3Ftrust.md)\n\n[unused]: missing.md#ignored\n",
			"docs/design/writer?trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/writer?trust.md:1 — Writer trust",
	},
	{
		name: "encoded query delimiter: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](design/writer%3Ftrust.md)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/design/writer?trust.md is absent" },
	},
	{
		name: "encoded slash: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design%2Ftrust.md)\n\n[unused]: missing.md#ignored\n",
			"docs/design/trust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "encoded slash: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](design%2Ftrust.md)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/design/trust.md is absent" },
	},
	{
		name: "encoded newline: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/writer%0Atrust.md)\n\n[unused]: missing.md#ignored\n",
			"docs/design/writer\ntrust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/writer\\u000atrust.md:1 — Writer trust",
	},
	{
		name: "encoded newline: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](design/writer%0Atrust.md)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/design/writer\ntrust.md is absent" },
	},
	{
		name: "entity newline: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](<design/writer&#10;trust.md>)\n\n[unused]: missing.md#ignored\n",
			"docs/design/writer\ntrust.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/writer\\u000atrust.md:1 — Writer trust",
	},
	{
		name: "entity newline: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](<design/writer&#10;trust.md>)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/design/writer\ntrust.md is absent" },
	},
	{
		name: "UTF-8 path: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](design/caf%C3%A9.md)\n\n[unused]: missing.md#ignored\n",
			"docs/design/café.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/café.md:1 — Writer trust",
	},
	{
		name: "UTF-8 path: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](design/caf%C3%A9.md)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/design/café.md is absent" },
	},
	{
		name: "empty fragment: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](architecture.md#)\n\n[unused]: missing.md#ignored\n",
			"docs/architecture.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/architecture.md:1 — Writer trust",
	},
	{
		name: "empty fragment: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](architecture.md#)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/architecture.md is absent" },
	},
	{
		name: "repository boundary: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](../policy.md#trust)\n\n[unused]: missing.md#ignored\n",
			"policy.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\npolicy.md:1 — Writer trust",
	},
	{
		name: "repository boundary: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](../policy.md#trust)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section policy.md is absent" },
	},
	{
		name: "multiple fragments: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n[Trust](architecture.md#trust#other)\n\n[unused]: missing.md#ignored\n",
			"docs/architecture.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/architecture.md:1 — Writer trust",
	},
	{
		name: "multiple fragments: absent",
		kind: "revision",
		files: { "docs/design.md": "# Design\r\n[Trust](architecture.md#trust#other)\n\n[unused]: missing.md#ignored\n" },
		error: { code: "incomplete", message: "The base design section docs/architecture.md is absent" },
	},
	{
		name: "ignored syntax: unused reference",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[unused]: design/missing.md#trust\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: undefined reference",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[Trust][unknown]\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: image",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n![Trust](design/missing.md#trust)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: reference image",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n![Trust][policy]\n\n[policy]: design/missing.md\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: inline code",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n`[Trust](design/missing.md#trust)`\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: nested code span",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n``a ` [Trust](design/missing.md)``\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: multiline code span",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n`Example\n[Trust](design/missing.md)`\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: indented link",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n    [Trust](design/missing.md)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: escaped link",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n\\[Trust](design/missing.md)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: HTML block",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n<div>\n[Trust](design/missing.md)\n</div>\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: empty fragment-only",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[Trust](#)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: query self link",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[Trust](?view=1#trust)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: non-split query without fragment",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[Trust](missing.md?view=1)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: non-Markdown split",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[Trust](design/missing.txt)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: uppercase extension",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[Trust](design/missing.MD#trust)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: scheme in first segment",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[Trust](writer:trust.md#trust)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: other synthetic host",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[Trust](//other-repository/path.md#trust)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "ignored syntax: external encoded scheme path",
		kind: "revision",
		files: { "docs/design.md": "# Design\n\n[Trust](https://host/writer%3Atrust.md#trust)\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "invalid boundary: ../../outside.md#trust",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](../../outside.md#trust)" },
		error: { code: "invalid", message: "outside the repository" },
	},
	{
		name: "invalid boundary: /absolute.md#trust",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](/absolute.md#trust)" },
		error: { code: "invalid", message: "outside the repository" },
	},
	{
		name: "invalid boundary: %2fabsolute.md#trust",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](%2fabsolute.md#trust)" },
		error: { code: "invalid", message: "outside the repository" },
	},
	{
		name: "invalid boundary: ../%2E%2E/outside.md#trust",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](../%2E%2E/outside.md#trust)" },
		error: { code: "invalid", message: "outside the repository" },
	},
	{
		name: "unclosed code span: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n`unclosed [Trust](architecture.md#trust)\n\n[unused]: missing.md#ignored\n",
			"docs/architecture.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/architecture.md:1 — Writer trust",
	},
	{
		name: "unclosed code span: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n`unclosed [Trust](architecture.md#trust)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/architecture.md is absent" },
	},
	{
		name: "invalid backtick info: present",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n```md` [Trust](architecture.md#trust)\n\n[unused]: missing.md#ignored\n",
			"docs/architecture.md": "## Writer trust\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/architecture.md:1 — Writer trust",
	},
	{
		name: "invalid backtick info: absent",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n```md` [Trust](architecture.md#trust)\n\n[unused]: missing.md#ignored\n",
		},
		error: { code: "incomplete", message: "The base design section docs/architecture.md is absent" },
	},
	{
		name: "``` equal close",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "```md\n## Inside\n```\n## Outside" }],
		expected: "docs/design.md:4 — Outside",
	},
	{
		name: "``` link equal close",
		kind: "revision",
		files: { "docs/design.md": "# Design\n```md\n[Example](missing.md#trust)\n```\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "``` longer close",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "```md\n## Inside\n   ```` \t\n## Outside" }],
		expected: "docs/design.md:4 — Outside",
	},
	{
		name: "``` link longer close",
		kind: "revision",
		files: { "docs/design.md": "# Design\n```md\n[Example](missing.md#trust)\n   ```` \t\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "``` short close",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "```md\n## Inside\n``\n## Outside" }],
		expected: "",
	},
	{
		name: "``` link short close",
		kind: "revision",
		files: { "docs/design.md": "# Design\n```md\n[Example](missing.md#trust)\n``\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "``` different marker",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "```md\n## Inside\n~~~\n## Outside" }],
		expected: "",
	},
	{
		name: "``` link different marker",
		kind: "revision",
		files: { "docs/design.md": "# Design\n```md\n[Example](missing.md#trust)\n~~~\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "``` trailing text",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "```md\n## Inside\n```ts\n## Outside" }],
		expected: "",
	},
	{
		name: "``` link trailing text",
		kind: "revision",
		files: { "docs/design.md": "# Design\n```md\n[Example](missing.md#trust)\n```ts\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "``` unclosed",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "```md\n## Inside\n\n## Outside" }],
		expected: "",
	},
	{
		name: "``` link unclosed",
		kind: "revision",
		files: { "docs/design.md": "# Design\n```md\n[Example](missing.md#trust)\n\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "``` closing whitespace",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "```md\n## Inside\n``` \t\n## Outside" }],
		expected: "docs/design.md:4 — Outside",
	},
	{
		name: "``` CRLF example",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n```md\r\n[Example](missing.md#trust)\r\n## Inside\r\n```\r\n## Outside\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design.md:6 — Outside",
	},
	{
		name: "~~~ equal close",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "~~~md\n## Inside\n~~~\n## Outside" }],
		expected: "docs/design.md:4 — Outside",
	},
	{
		name: "~~~ link equal close",
		kind: "revision",
		files: { "docs/design.md": "# Design\n~~~md\n[Example](missing.md#trust)\n~~~\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "~~~ longer close",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "~~~md\n## Inside\n   ~~~~ \t\n## Outside" }],
		expected: "docs/design.md:4 — Outside",
	},
	{
		name: "~~~ link longer close",
		kind: "revision",
		files: { "docs/design.md": "# Design\n~~~md\n[Example](missing.md#trust)\n   ~~~~ \t\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "~~~ short close",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "~~~md\n## Inside\n~~\n## Outside" }],
		expected: "",
	},
	{
		name: "~~~ link short close",
		kind: "revision",
		files: { "docs/design.md": "# Design\n~~~md\n[Example](missing.md#trust)\n~~\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "~~~ different marker",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "~~~md\n## Inside\n```\n## Outside" }],
		expected: "",
	},
	{
		name: "~~~ link different marker",
		kind: "revision",
		files: { "docs/design.md": "# Design\n~~~md\n[Example](missing.md#trust)\n```\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "~~~ trailing text",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "~~~md\n## Inside\n~~~ts\n## Outside" }],
		expected: "",
	},
	{
		name: "~~~ link trailing text",
		kind: "revision",
		files: { "docs/design.md": "# Design\n~~~md\n[Example](missing.md#trust)\n~~~ts\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "~~~ unclosed",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "~~~md\n## Inside\n\n## Outside" }],
		expected: "",
	},
	{
		name: "~~~ link unclosed",
		kind: "revision",
		files: { "docs/design.md": "# Design\n~~~md\n[Example](missing.md#trust)\n\n" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "~~~ closing whitespace",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "~~~md\n## Inside\n~~~ \t\n## Outside" }],
		expected: "docs/design.md:4 — Outside",
	},
	{
		name: "~~~ CRLF example",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\r\n~~~md\r\n[Example](missing.md#trust)\r\n## Inside\r\n~~~\r\n## Outside\r\n",
		},
		expected: "docs/design.md:1 — Design\ndocs/design.md:6 — Outside",
	},
	{
		name: "invalid backtick info string",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "```md`\n## Real policy\n~~~md`\n## Example\n~~~\n## Outside" }],
		expected: "docs/design.md:2 — Real policy\ndocs/design.md:6 — Outside",
	},
	{
		name: "Setext",
		kind: "headings",
		files: [
			{
				path: "docs/design.md",
				content: "Design\n======\n\nWriter trust\n------------\nOnly signed writers are trusted.\n",
			},
		],
		expected: "docs/design.md:1 — Design\ndocs/design.md:4 — Writer trust",
	},
	{
		name: "indented ATX",
		kind: "headings",
		files: [{ path: "docs/design.md", content: " # Design\n  ## Writer trust\n   ### Signed markers\n" }],
		expected: "docs/design.md:1 — Design\ndocs/design.md:2 — Writer trust\ndocs/design.md:3 — Signed markers",
	},
	{
		name: "formatted ATX",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## Writer *trust* and `signed` [markers](policy.md) ##\n" }],
		expected: "docs/design.md:1 — Writer trust and signed markers",
	},
	{
		name: "CRLF Setext",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "Design\r\n======\r\n\r\nWriter trust\r\n------------\r\n" }],
		expected: "docs/design.md:1 — Design\ndocs/design.md:4 — Writer trust",
	},
	{
		name: "nested heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "> ## Writer trust\n" }],
		expected: "docs/design.md:1 — Writer trust",
	},
	{
		name: "empty heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "#\n" }],
		expected: "docs/design.md:1 — ",
	},
	{
		name: "prose and indented code",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "ordinary prose\n\n    ## Example\n\n\\# Escaped\n" }],
		expected: "",
	},
	{
		name: "fenced Setext example",
		kind: "headings",
		files: [
			{ path: "docs/design.md", content: "```md\nWriter trust\n------------\n```\n\nReal policy\n-----------\n" },
		],
		expected: "docs/design.md:6 — Real policy",
	},
	{
		name: "ATX level 1: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "# Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX level 1: missing space",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "#Policy" }],
		expected: "",
	},
	{
		name: "ATX level 2: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX level 2: missing space",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "##Policy" }],
		expected: "",
	},
	{
		name: "ATX level 3: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "### Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX level 3: missing space",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "###Policy" }],
		expected: "",
	},
	{
		name: "ATX level 4: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "#### Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX level 4: missing space",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "####Policy" }],
		expected: "",
	},
	{
		name: "ATX level 5: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "##### Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX level 5: missing space",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "#####Policy" }],
		expected: "",
	},
	{
		name: "ATX level 6: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "###### Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX level 6: missing space",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "######Policy" }],
		expected: "",
	},
	{
		name: "ATX indentation 0: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX indentation 0: escaped hash",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "\\## Policy" }],
		expected: "",
	},
	{
		name: "ATX indentation 1: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: " ## Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX indentation 1: escaped hash",
		kind: "headings",
		files: [{ path: "docs/design.md", content: " \\## Policy" }],
		expected: "",
	},
	{
		name: "ATX indentation 2: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "  ## Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX indentation 2: escaped hash",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "  \\## Policy" }],
		expected: "",
	},
	{
		name: "ATX indentation 3: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "   ## Policy" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "ATX indentation 3: escaped hash",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "   \\## Policy" }],
		expected: "",
	},
	{
		name: "Setext equals: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "Policy\n===" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "Setext equals: code",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "    Policy\n    ===" }],
		expected: "",
	},
	{
		name: "Setext hyphens: heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "Policy\n---" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "Setext hyphens: code",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "    Policy\n    ---" }],
		expected: "",
	},
	{
		name: "seven hashes",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "####### Policy" }],
		expected: "",
	},
	{
		name: "four-space ATX",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "    ## Policy" }],
		expected: "",
	},
	{
		name: "strong and emphasis",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## **Writer** *trust*" }],
		expected: "docs/design.md:1 — Writer trust",
	},
	{
		name: "entity and escape",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## Writer &amp; \\*trust\\*" }],
		expected: "docs/design.md:1 — Writer & *trust*",
	},
	{
		name: "unclosed emphasis",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## Writer *trust" }],
		expected: "docs/design.md:1 — Writer *trust",
	},
	{
		name: "closing hashes with space",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## Policy ##" }],
		expected: "docs/design.md:1 — Policy",
	},
	{
		name: "closing hashes without space",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## Policy##" }],
		expected: "docs/design.md:1 — Policy##",
	},
	{
		name: "CR lines",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "# Design\r## Policy\r" }],
		expected: "docs/design.md:1 — Design\ndocs/design.md:2 — Policy",
	},
	{
		name: "CRLF fenced headings",
		kind: "headings",
		files: [
			{
				path: "docs/design.md",
				content: "# Design\r\n## Writer trust\r\n```md\r\n## Example\r\n``` \t\r\n## Real policy\r\n",
			},
		],
		expected: "docs/design.md:1 — Design\ndocs/design.md:2 — Writer trust\ndocs/design.md:6 — Real policy",
	},
	{
		name: "inline HTML source",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## Writer <em>trust</em>" }],
		expected: "docs/design.md:1 — Writer <em>trust</em>",
	},
	{
		name: "HTML block headings",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "<div>\n## Example\n</div>" }],
		expected: "",
	},
	{ name: "prose", kind: "headings", files: [{ path: "docs/design.md", content: "Writer trust" }], expected: "" },
	{ name: "empty file", kind: "headings", files: [{ path: "docs/design.md", content: "" }], expected: "" },
	{
		name: "visible path and heading controls",
		kind: "headings",
		files: [{ path: "docs/design/a\nforged.md", content: "# Writer\ttrust\u001b[31m‮" }],
		expected: "docs/design/a\\u000aforged.md:1 — Writer\\u0009trust\\u001b[31m\\u202e",
	},
	{
		name: "plain path and heading",
		kind: "headings",
		files: [{ path: "docs/design/plain.md", content: "# Writer trust" }],
		expected: "docs/design/plain.md:1 — Writer trust",
	},
	{
		name: "duplicate links sorted once",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\n[Z](design/z.md)\n[A](architecture.md#one)\n[A again](architecture.md#two)\n",
			"docs/design/z.md": "# Z",
			"docs/architecture.md": "# A\n## Other",
		},
		expected:
			"docs/design.md:1 — Design\ndocs/architecture.md:1 — A\ndocs/architecture.md:2 — Other\ndocs/design/z.md:1 — Z",
	},
	{
		name: "self fragments use all own headings",
		kind: "revision",
		files: { "docs/design.md": "# Design\n## Policy\n[Self](#policy)\n[Self file](./design.md#policy)\n" },
		expected: "docs/design.md:1 — Design\ndocs/design.md:2 — Policy",
	},
	{
		name: "one-hop discovery",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\n[Trust](design/trust.md)",
			"docs/design/trust.md": "# Trust\n[Example](missing.md#trust)",
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Trust",
	},
	{
		name: "base headings survive head rename",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](design/trust.md)", "docs/design/trust.md": "# Writer trust" },
		head: { "docs/design.md": "# Publisher eligibility", "docs/design/trust.md": "# Receipts" },
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "base links survive head deletion",
		kind: "revision",
		files: { "docs/design.md": "# Design\n[Trust](design/trust.md)", "docs/design/trust.md": "# Writer trust" },
		remove: ["docs/design/trust.md"],
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Writer trust",
	},
	{
		name: "base ignores uncommitted design",
		kind: "revision",
		files: { "docs/design.md": "# Design" },
		worktree: { "docs/design.md": "# Changed\n[Missing](design/missing.md)" },
		expected: "docs/design.md:1 — Design",
	},
	{
		name: "absent base design ignores head addition",
		kind: "revision",
		files: { "src/index.ts": "export const value = 1;" },
		head: { "docs/design.md": "# Head" },
		expected: "",
	},
	{
		name: "invalid revision refuses read",
		kind: "revision",
		files: { "docs/design.md": "# Design" },
		revision: "missing-revision",
		error: { code: "unknownCommit" },
	},
	{
		name: "docs/design.md: symlink refused",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\n[Trust](design/trust.md)",
			"docs/design/trust.md": "# Trust",
			"docs/target.md": "# Target",
		},
		symlink: { path: "docs/design.md", target: "target.md" },
		error: { code: "symlink" },
	},
	{
		name: "docs/design.md: read 262144 bytes",
		kind: "revision",
		files: { "docs/design.md": `# Bound\n${"x".repeat(262136)}`, "docs/design/trust.md": "# Trust" },
		expected: "docs/design.md:1 — Bound",
	},
	{
		name: "docs/design.md: read 262145 bytes",
		kind: "revision",
		files: { "docs/design.md": `# Bound\n${"x".repeat(262137)}`, "docs/design/trust.md": "# Trust" },
		error: { code: "tooLarge" },
	},
	{
		name: "docs/design/trust.md: symlink refused",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\n[Trust](design/trust.md)",
			"docs/design/trust.md": "# Trust",
			"docs/target.md": "# Target",
		},
		symlink: { path: "docs/design/trust.md", target: "../target.md" },
		error: { code: "symlink" },
	},
	{
		name: "docs/design/trust.md: read 262144 bytes",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\n[Trust](design/trust.md)",
			"docs/design/trust.md": `# Bound\n${"x".repeat(262136)}`,
		},
		expected: "docs/design.md:1 — Design\ndocs/design/trust.md:1 — Bound",
	},
	{
		name: "docs/design/trust.md: read 262145 bytes",
		kind: "revision",
		files: {
			"docs/design.md": "# Design\n[Trust](design/trust.md)",
			"docs/design/trust.md": `# Bound\n${"x".repeat(262137)}`,
		},
		error: { code: "tooLarge" },
	},
	{
		name: "index exactly 65536 bytes",
		kind: "headings",
		files: [{ path: "docs/design.md", content: `# ${indexTitle}` }],
		expected: indexPrefix + indexTitle,
	},
	{
		name: "index one byte past",
		kind: "headings",
		files: [{ path: "docs/design.md", content: `# ${indexTitle}x` }],
		error: { code: "incomplete", message: "1 headings omitted; review refused" },
	},
	{
		name: "index multibyte exactly at bound",
		kind: "headings",
		files: [{ path: "docs/design.md", content: `# ${indexTitle.slice(0, -2)}é` }],
		expected: `${indexPrefix}${indexTitle.slice(0, -2)}é`,
	},
	{
		name: "index multibyte one byte past",
		kind: "headings",
		files: [{ path: "docs/design.md", content: `# ${indexTitle.slice(0, -1)}é` }],
		error: { code: "incomplete", message: "1 headings omitted; review refused" },
	},
	{
		name: "index two omitted headings",
		kind: "headings",
		files: [{ path: "docs/design.md", content: `# ${indexTitle}\n## Another` }],
		error: { code: "incomplete", message: "2 headings omitted; review refused" },
	},
	{ name: "empty index", kind: "headings", files: [{ path: "docs/design.md", content: "" }], expected: "" },
	{ name: "no files", kind: "headings", files: [], expected: "" },
	{
		name: "image heading uses alt text",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## ![Writer trust](policy.png)" }],
		expected: "docs/design.md:1 — Writer trust",
	},
	{
		name: "reference image heading uses alt text",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## ![Writer trust][policy]\n\n[policy]: policy.png" }],
		expected: "docs/design.md:1 — Writer trust",
	},
	{
		name: "prose image creates no heading",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "![Writer trust](policy.png)" }],
		expected: "",
	},
	{
		name: "empty image alt creates no text",
		kind: "headings",
		files: [{ path: "docs/design.md", content: "## ![](policy.png)" }],
		expected: "docs/design.md:1 — ",
	},
];

describe("base design vocabulary", { timeout: 60_000 }, () => {
	it.each(cases.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
		expect(designIndexLimits).toEqual({ bytes: 65536 });
		if (row.kind === "headings") {
			const index = DesignSections.from(row.files);
			if (row.error) expect(() => index.render()).toThrow(row.error.message);
			else expect(index.render()).toBe(row.expected);
			return;
		}
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, row.files);
			if (row.symlink) {
				rmSync(join(repo, row.symlink.path));
				symlinkSync(row.symlink.target, join(repo, row.symlink.path));
			}
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			const base = gitIn(repo, "rev-parse", "HEAD");
			if (row.head || row.remove) {
				writeFiles(repo, row.head ?? {});
				for (const path of row.remove ?? []) gitIn(repo, "rm", "--quiet", "--", path);
				gitIn(repo, "add", "--all");
				gitIn(repo, "commit", "--quiet", "-m", "head");
			}
			writeFiles(repo, row.worktree ?? {});
			const index = DesignSections.load(repo, row.revision ?? base);
			if (row.error) {
				await expect(index).rejects.toMatchObject({
					code: row.error.code,
					...(row.error.message ? { message: expect.stringContaining(row.error.message) } : {}),
				});
			} else expect((await index).render()).toBe(row.expected);
		} finally {
			removeDirectory(repo);
		}
	});
});
