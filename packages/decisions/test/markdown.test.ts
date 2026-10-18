import * as markdownParser from "mdast-util-from-markdown";
import { describe, expect, it, vi } from "vitest";
import { LocalDestination, MarkdownDocument } from "../src/markdown.ts";

vi.mock("mdast-util-from-markdown", { spy: true });

const decisionPath = "docs/decisions/new.md";

describe("supersession mutation regressions", () => {
	it("keeps nested headings retired until a shallower section starts", () => {
		const document = MarkdownDocument.parse(
			"## Retired\n\nGone.\n\n### Detail\n\nStill gone.\n\n### Retired\n\nGone too.\n\n### Sibling\n\nAlso gone.\n\n# Current\n\nKeep.",
		);
		expect(document.clauses(decisionPath)).toEqual([{ text: "Keep.", line: 19, endLine: 19 }]);
	});

	it.each(["<b>Retired</b>", "<b> Retired </b>"])("recognises the plain text of heading %s", (heading) => {
		expect(MarkdownDocument.parse(`## ${heading}\n\nGone.\n\n## Current\n\nKeep.`).clauses(decisionPath)).toEqual([
			{ text: "Keep.", line: 7, endLine: 7 },
		]);
	});

	it.each(["Keep -|\nOther.", "-| prose\nOther."])("requires a complete table delimiter: %j", (source) => {
		expect(MarkdownDocument.parse(source).clauses(decisionPath)).toEqual([
			{ text: source.replace("\n", " "), line: 1, endLine: 2 },
		]);
	});

	it.each(["---|---", ":---|---", "---:|---", "|---|---|", "  |  :---:  |  ---  |  "])(
		"recognises table delimiter %j and normalises each row",
		(delimiter) => {
			const source = `Rule  | Choice  \n${delimiter}\nRetry | Stop. Never repeat.`;
			expect(MarkdownDocument.parse(source).clauses(decisionPath)).toEqual([
				{ text: "Rule | Choice", line: 1, endLine: 1 },
				{ text: delimiter.replace(/\s+/g, " ").trim(), line: 2, endLine: 2 },
				{ text: "Retry | Stop. Never repeat.", line: 3, endLine: 3 },
			]);
		},
	);

	it("aligns the sentence mask after omitting an initial image", () => {
		expect(MarkdownDocument.parse("![ignored](image.png) Keep. End.").clauses(decisionPath)).toEqual([
			{ text: "Keep.", line: 1, endLine: 1 },
			{ text: "End.", line: 1, endLine: 1 },
		]);
	});

	it("collapses repeated spaces in both prose and its sentence mask", () => {
		expect(MarkdownDocument.parse("Keep   this rule. End.").clauses(decisionPath)).toEqual([
			{ text: "Keep this rule.", line: 1, endLine: 1 },
			{ text: "End.", line: 1, endLine: 1 },
		]);
	});

	it.each(["\n", "\r\n", "\r"])("locates a declaration after context with %j endings", (ending) => {
		const document = MarkdownDocument.parse(["# New", "", "Context.", "Supersedes: old.md"].join(ending));
		expect(document.declarations(decisionPath)).toMatchObject([
			{ line: 4, sourceLine: ending === "\r" ? 1 : 4, targets: ["docs/decisions/old.md"] },
		]);
	});

	it("includes first-sentence destinations in declaration identity", () => {
		const first = MarkdownDocument.parse("Supersedes: [Same](one.md). Context.").declarations(decisionPath)[0]!;
		const second = MarkdownDocument.parse("Supersedes: [Same](two.md). Context.").declarations(decisionPath)[0]!;
		expect(JSON.parse(first.text)).toEqual({
			prose: "Supersedes: \u0000. ",
			links: [{ offset: 12, destination: "one.md" }],
		});
		expect(first.text).not.toBe(second.text);
	});

	it("excludes a link at the next sentence boundary from declaration identity", () => {
		const first = MarkdownDocument.parse("Supersedes: old.md. [Context](one.md)").declarations(decisionPath)[0]!;
		const second = MarkdownDocument.parse("Supersedes: old.md. [Context](two.md)").declarations(decisionPath)[0]!;
		expect(JSON.parse(first.text)).toEqual({ prose: "Supersedes: old.md. ", links: [] });
		expect(first.text).toBe(second.text);
	});

	it.each([
		"Supersedes: old.md. Next.md",
		"Supersedes: [Old](old.md). [Next](Next.md)",
		"Supersedes: [Old](old.md)!Next.md",
	])("excludes second-sentence targets in %j", (source) => {
		expect(MarkdownDocument.parse(source).declarations(decisionPath)).toMatchObject([
			{ targets: ["docs/decisions/old.md"] },
		]);
	});
});

const slugCases = [
	["formatting", "# Writer *trust* and `signed` [markers](policy.md)", ["writer-trust-and-signed-markers"]],
	[
		"images",
		"# ![Writer trust](policy.png)\n# ![Writer trust][policy]\n\n[policy]: policy.png",
		["writer-trust", "writer-trust-1"],
	],
	["HTML", "# Writer <em>trust</em>", ["writer-trust"]],
	[
		"duplicates and collisions",
		"# Policy\n# Policy\n# Policy-1\n# Policy",
		["policy", "policy-1", "policy-1-1", "policy-2"],
	],
	["Unicode", "# Café &amp; 世界!", ["café--世界"]],
	["empty", "#\n# ![](empty.png)", ["", "-1"]],
	["Setext and CRLF", "Policy\r\n======\r\n## Policy\r\n", ["policy", "policy-1"]],
] as const;

describe("heading ids", () => {
	it.each(slugCases)("%s", (_name, markdown, ids) => {
		const document = MarkdownDocument.parse(markdown);
		expect(document.headings().map((heading) => heading.id)).toEqual(ids);
		expect(document.headings().map((heading) => heading.id)).toEqual(ids);
		expect(MarkdownDocument.parse(`~~~md\n${markdown}\n~~~`).headings()).toEqual([]);
	});
});

type URLCase = readonly [
	name: string,
	destination: string,
	path: string,
	fragment: string,
	rejected: string,
	error?: string,
];
const urlCases: URLCase[] = [
	[
		"UTF-8",
		"design/caf%C3%A9.md#caf%C3%A9",
		"docs/design/café.md",
		"#caf%C3%A9",
		"design/caf%C3.md",
		"invalid URI encoding",
	],
	["decoded slash", "design%2Ftrust.md", "docs/design/trust.md", "", "%2Ftrust.md", "outside the repository"],
	[
		"decoded traversal",
		"design/nested%2F..%2Ftrust.md",
		"docs/design/trust.md",
		"",
		"design/%2F..%2F..%2F..%2Foutside.md",
		"outside the repository",
	],
	["repository boundary", "../policy.md#policy", "policy.md", "#policy", "../../outside.md", "outside the repository"],
	["fragment only", "#policy", "docs/design.md", "#policy", "https://example.com/%ZZ#policy"],
	[
		"empty fragment",
		"architecture.md#",
		"docs/architecture.md",
		"#",
		"//melian-repository/repository/docs/architecture.md#",
	],
	["multiple fragments", "architecture.md#one#two", "docs/architecture.md", "#one#two", "file:architecture.md#one"],
	["colon", "design/writer:trust.md", "docs/design/writer:trust.md", "", "writer:trust.md"],
	[
		"encoded scheme",
		"https%3A//host/trust.md#policy",
		"docs/https:/host/trust.md",
		"#policy",
		"https://[invalid]/trust.md",
		"invalid URL",
	],
	[
		"newline",
		"design/writer\ntrust.md",
		"docs/design/writer\ntrust.md",
		"",
		"design/writer%ZZtrust.md",
		"invalid URI encoding",
	],
	["carriage return", "design/writer\rtrust.md", "docs/design/writer\rtrust.md", "", "file:design/writer\rtrust.md"],
	["tab", "design/writer\ttrust.md", "docs/design/writer\ttrust.md", "", "//example.com/design/writer\ttrust.md"],
];

describe("URL policy", () => {
	it.each(Array.from({ length: 33 }, (_, code) => [code, String.fromCharCode(code)] as const))(
		"preserves C0 and space padding: %s",
		(_code, padding) => {
			expect(LocalDestination.resolve("docs/design.md", `${padding}old.md${padding}`)).toMatchObject({
				path: `docs/${padding}old.md${padding}`,
				fragment: "",
			});
			expect(LocalDestination.resolve("docs/design.md", "!old.md!")).toMatchObject({
				path: "docs/!old.md!",
				fragment: "",
			});
		},
	);
	it("keeps a destination explicitly marked repository-relative", () => {
		expect(LocalDestination.resolve("docs/nested/design.md", "/repository/docs/design/trust.md", true)).toMatchObject(
			{
				path: "docs/design/trust.md",
				fragment: "",
			},
		);
	});
	it.each(urlCases.map((row) => [row[0], row] as const))("%s", (_name, row) => {
		const [, destination, path, fragment, rejected, error] = row;
		expect(LocalDestination.resolve("docs/design.md", destination)).toMatchObject({ path, fragment });
		if (error) expect(() => LocalDestination.resolve("docs/design.md", rejected)).toThrow(error);
		else expect(LocalDestination.resolve("docs/design.md", rejected)).toBeUndefined();
	});
});

const metadataCases = [
	["YAML", "---", "yaml"],
	["TOML", "+++", "toml"],
] as const;
describe("front matter nodes", () => {
	it.each(metadataCases)("%s", (_name, fence, type) => {
		const parse = vi.mocked(markdownParser.fromMarkdown);
		parse.mockClear();
		try {
			const document = MarkdownDocument.parse(`${fence}\nmetadata\n${fence}\n# Policy`);
			expect(parse.mock.results[0]?.value).toMatchObject({
				children: [{ type, value: "metadata" }, { type: "heading" }],
			});
			expect(document.headings()).toEqual([{ text: "Policy", id: "policy", line: 4, depth: 1 }]);
			expect(document.links()).toEqual([]);
		} finally {
			parse.mockClear();
		}
	});
});
