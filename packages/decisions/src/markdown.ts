import { posix } from "node:path";
import GithubSlugger from "github-slugger";
import type { Heading, Link, LinkReference, Paragraph, Root } from "mdast";
import { definitions, type GetDefinition } from "mdast-util-definitions";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { toString as markdownText } from "mdast-util-to-string";
import { frontmatter } from "micromark-extension-frontmatter";
import { SKIP, visit } from "unist-util-visit";
import { DecisionFilesError } from "./decision-files-error.ts";

/** The shared discovery and declaration domain for written decisions. */
export const decisionPathPattern = /^docs\/decisions\/.*\.md$/s;

const lineEndingPattern = /\r\n|\r|\n/;
const targetBoundary = /(?=$|[\s,;]|\.(?:$|\s))/.source;
const absencePattern = new RegExp(`^(?:none|no decision file)${targetBoundary}`, "i");
const bareTargetPattern = new RegExp(String.raw`(?:^|[\s,;])([^\s,;\u0000]+\.md)${targetBoundary}`, "g");

/** One parsed declaration line, with direct local targets. */
export type DecisionDeclaration = {
	kind: "Supersedes" | "Amends";
	targets: string[];
	/** CommonMark's physical line, used to exclude just the declaration. */
	line: number;
	/** LF coordinate shared with read_file and finding locations. */
	sourceLine: number;
	text: string;
};

/** One comparable clause and its source paragraph or table-row range. */
export type DecisionClause = { text: string; line: number; endLine: number };

export class MarkdownDocument {
	readonly #content: string;
	readonly #tree: Root;
	readonly #definition: GetDefinition;
	readonly #sourceLines: number[];

	private constructor(content: string, tree: Root) {
		this.#content = content;
		this.#tree = tree;
		this.#definition = definitions(tree);
		this.#sourceLines = [1];
		let sourceLine = 1;
		for (const ending of content.matchAll(new RegExp(lineEndingPattern.source, "g"))) {
			sourceLine += [...ending[0].matchAll(/\n/g)].length;
			this.#sourceLines.push(sourceLine);
		}
	}

	static parse(content: string): MarkdownDocument {
		return new MarkdownDocument(
			content,
			fromMarkdown(content, {
				extensions: [frontmatter(["yaml", "toml"])],
				mdastExtensions: [frontmatterFromMarkdown(["yaml", "toml"])],
			}),
		);
	}

	headings(): { text: string; id: string; line: number; depth: Heading["depth"] }[] {
		const slugger = new GithubSlugger();
		const headings: { text: string; id: string; line: number; depth: Heading["depth"] }[] = [];
		let offset = 0;
		let line = 1;
		visit(this.#tree, "heading", (node) => {
			const start = node.position!.start.offset!;
			line += [...this.#content.slice(offset, start).matchAll(/\n/g)].length;
			offset = start;
			const text = markdownText(node, { includeHtml: false });
			headings.push({ text, id: slugger.slug(text), line, depth: node.depth });
		});
		return headings;
	}

	links(): string[] {
		const destinations: string[] = [];
		visit(this.#tree, ["link", "linkReference"] as const, (node) => {
			destinations.push(this.destination(node));
		});
		return destinations;
	}

	supersedes(path: string): string[] {
		return [
			...new Set(
				this.declarations(path)
					.filter((declaration) => declaration.kind === "Supersedes")
					.flatMap((declaration) => declaration.targets),
			),
		];
	}

	declarations(path: string): DecisionDeclaration[] {
		const declarations: DecisionDeclaration[] = [];
		visit(this.#tree, "paragraph", (paragraph, _index, parent) => {
			if (parent!.type !== "root") return SKIP;
			declarations.push(...this.paragraphDeclarations(paragraph, path));
		});
		return declarations;
	}

	clauses(path: string): DecisionClause[] {
		const segmenter = new Intl.Segmenter("en-AU", { granularity: "sentence" });
		const declarations = new Set(this.declarations(path).map((declaration) => declaration.line));
		const clauses: DecisionClause[] = [];
		let retired: number | undefined;
		visit(this.#tree, (node, _index, parent) => {
			if (node.type === "blockquote") return SKIP;
			if (node.type === "heading" && parent!.type === "root") {
				if (retired !== undefined && node.depth <= retired) retired = undefined;
				if (retired === undefined && markdownText(node, { includeHtml: false }).trim() === "Retired")
					retired = node.depth;
				return SKIP;
			}
			if (retired !== undefined) return SKIP;
			if (node.type !== "paragraph") return;
			const { start, end } = node.position!;
			const rows = this.#content.slice(start.offset!, end.offset!).split(lineEndingPattern);
			const kept = rows
				.map((text, index) => ({ text, line: start.line + index }))
				.filter((row) => !declarations.has(row.line));
			// No GFM extension is installed; retain each source row rather than guessing table cells.
			if (rows.some((row) => /^\s*\|?\s*:?-+:?\s*\|[\s|:-]*$/.test(row))) {
				for (const row of kept)
					clauses.push({
						text: row.text.replace(/\s+/g, " ").trim(),
						line: this.#sourceLines[row.line - 1]!,
						endLine: this.#sourceLines[row.line - 1]!,
					});
				return SKIP;
			}
			const { text, mask } = this.prose(node, path, kept.length === rows.length ? new Set() : declarations);
			for (const segment of segmenter.segment(mask)) {
				clauses.push({
					text: text.slice(segment.index, segment.index + segment.segment.length).trim(),
					line: this.#sourceLines[start.line - 1]!,
					endLine: this.#sourceLines[end.line - 1]!,
				});
			}
			return SKIP;
		});
		return clauses;
	}

	private prose(node: Paragraph, path: string, declarations: ReadonlySet<number>): { text: string; mask: string } {
		let text = "";
		let mask = "";
		visit(node, (inline) => {
			if (inline.type === "text" || inline.type === "inlineCode") {
				// mdast cooks code line endings into spaces, so a partial span has no decoded line map.
				if (
					inline.type === "inlineCode" &&
					declarations.has(inline.position!.start.line) &&
					inline.position!.start.line !== inline.position!.end.line
				)
					throw new DecisionFilesError("invalid", `${path}: code span crosses an excluded declaration line`);
				const value = inline.value
					.split(lineEndingPattern)
					.map((piece, index) => (declarations.has(inline.position!.start.line + index) ? "" : piece))
					.join("\n");
				text += value;
				mask +=
					inline.type === "inlineCode"
						? value.replace(/[^\p{L}\p{N}\p{M}\p{Cf}\s]/gu, (mark) => "x".repeat(mark.length))
						: value;
			} else if (inline.type === "break") {
				text += " ";
				mask += " ";
			}
		});
		return { text: text.replace(/\s+/g, " ").trim(), mask: mask.replace(/\s+/g, " ").trim() };
	}

	private destination(node: Link | LinkReference): string {
		return node.type === "link" ? node.url : this.#definition(node.identifier)!.url;
	}

	private paragraphDeclarations(paragraph: Paragraph, path: string): DecisionDeclaration[] {
		const firstLine = paragraph.position!.start.line;
		const lines: { prose: string; links: { offset: number; destination: string }[] }[] = Array.from(
			{ length: paragraph.position!.end.line - firstLine + 1 },
			() => ({ prose: "", links: [] }),
		);
		visit(paragraph, (node) => {
			const { start, end } = node.position!;
			const line = lines[start.line - firstLine]!;
			switch (node.type) {
				case "text": {
					const prose = node.value.split(lineEndingPattern);
					if (prose.length !== end.line - start.line + 1)
						throw new DecisionFilesError(
							"invalid",
							`Invalid paragraph text in ${path} at line ${start.line}: decoded line endings disagree with source lines`,
						);
					for (let number = start.line; number <= end.line; number++)
						lines[number - firstLine]!.prose += prose[number - start.line]!;
					break;
				}
				case "link":
				case "linkReference":
				case "inlineCode":
				case "html":
				case "image":
				case "imageReference":
					if (node.type === "link" || node.type === "linkReference")
						line.links.push({ offset: line.prose.length, destination: this.destination(node) });
					for (let number = start.line; number <= end.line; number++) lines[number - firstLine]!.prose += "\u0000";
					return SKIP;
			}
		});
		const declarations: DecisionDeclaration[] = [];
		for (const [index, line] of lines.entries()) {
			const kind = line.prose.startsWith("Supersedes:")
				? "Supersedes"
				: line.prose.startsWith("Amends:")
					? "Amends"
					: undefined;
			if (kind === undefined) continue;
			const declaration: DecisionDeclaration = {
				kind,
				targets: [],
				line: firstLine + index,
				sourceLine: this.#sourceLines[firstLine + index - 1]!,
				text: JSON.stringify(line),
			};
			declarations.push(declaration);
			const prose = line.prose.slice(`${kind}:`.length);
			if (absencePattern.test(prose.trimStart())) continue;
			const sentence = [...new Intl.Segmenter("en-AU", { granularity: "sentence" }).segment(line.prose)][0]!.segment;
			declaration.text = JSON.stringify({
				prose: sentence,
				links: line.links.filter((link) => link.offset < sentence.length),
			});
			const bare = [...prose.matchAll(bareTargetPattern)].map((match) => ({
				offset: match.index + `${kind}:`.length,
				destination: match[1]!,
			}));
			for (const { offset, destination } of [...line.links, ...bare].sort((a, b) => a.offset - b.offset)) {
				if (offset >= sentence.length) continue;
				const repositoryRelative = destination.startsWith("docs/decisions/") || destination.startsWith("/");
				const input =
					destination.startsWith("/") && !destination.startsWith("//") ? destination.slice(1) : destination;
				const target = LocalDestination.resolve(`${posix.dirname(path)}/`, input, repositoryRelative);
				if (target !== undefined && decisionPathPattern.test(target.path)) declaration.targets.push(target.path);
			}
		}
		return declarations;
	}
}

export class LocalDestination {
	readonly path: string;
	readonly fragment: string;

	private constructor(path: string, fragment: string) {
		this.path = path;
		this.fragment = fragment;
	}

	static resolve(from: string, destination: string, repositoryRelative = false): LocalDestination | undefined {
		if (!repositoryRelative && /^(?:[/\\](?![/\\])|%2f|%5c)/i.test(destination))
			throw new DecisionFilesError("invalid", `Invalid destination ${destination}: outside the repository`);
		const root = new URL("file://melian-repository/repository/");
		// URL parsing strips or trims controls and spaces that mdast can decode in a filename.
		const input = destination.replace(/[\u0000-\u0020]/g, encodeURIComponent);
		const base = new URL(from.split("/").map(encodeURIComponent).join("/"), root);
		const url = URL.parse(input, base.href);
		if (url === null) throw new DecisionFilesError("invalid", `Invalid destination ${destination}: invalid URL`);
		if (URL.canParse(input) || url.host === new URL(input, "file://other-repository/repository/").host)
			return undefined;
		const resolved = repositoryRelative ? new URL(input, root) : url;
		let pathname: string;
		try {
			pathname = decodeURIComponent(resolved.pathname);
		} catch {
			throw new DecisionFilesError("invalid", `Invalid destination ${destination}: invalid URI encoding`);
		}
		const normalized = posix.normalize(pathname);
		if (!normalized.startsWith(root.pathname))
			throw new DecisionFilesError("invalid", `Invalid destination ${destination}: outside the repository`);
		return new LocalDestination(
			normalized.slice(root.pathname.length),
			resolved.href.includes("#") ? resolved.href.slice(resolved.href.indexOf("#")) : "",
		);
	}
}
