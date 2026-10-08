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

export const decisionPathPattern = /^docs\/decisions\/.*\.md$/s;

export class MarkdownDocument {
	readonly #tree: Root;
	readonly #definition: GetDefinition;

	private constructor(tree: Root) {
		this.#tree = tree;
		this.#definition = definitions(tree);
	}

	static parse(content: string): MarkdownDocument {
		return new MarkdownDocument(
			fromMarkdown(content, {
				extensions: [frontmatter(["yaml", "toml"])],
				mdastExtensions: [frontmatterFromMarkdown(["yaml", "toml"])],
			}),
		);
	}

	headings(): { text: string; id: string; line: number; depth: Heading["depth"] }[] {
		const slugger = new GithubSlugger();
		const headings: { text: string; id: string; line: number; depth: Heading["depth"] }[] = [];
		visit(this.#tree, "heading", (node) => {
			const text = markdownText(node, { includeHtml: false });
			headings.push({ text, id: slugger.slug(text), line: node.position!.start.line, depth: node.depth });
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
		const targets: string[] = [];
		visit(this.#tree, "paragraph", (paragraph) => {
			targets.push(...this.paragraphTargets(paragraph, path));
		});
		return [...new Set(targets)];
	}

	private destination(node: Link | LinkReference): string {
		return node.type === "link" ? node.url : this.#definition(node.identifier)!.url;
	}

	private paragraphTargets(paragraph: Paragraph, path: string): string[] {
		const lines: { prose: string; links: { offset: number; destination: string }[] }[] = [{ prose: "", links: [] }];
		visit(paragraph, (node) => {
			const line = lines.at(-1)!;
			switch (node.type) {
				case "text": {
					const [first, ...rest] = node.value.split("\n");
					line.prose += first;
					for (const prose of rest) lines.push({ prose, links: [] });
					break;
				}
				case "link":
				case "linkReference":
					line.links.push({ offset: line.prose.length, destination: this.destination(node) });
					line.prose += "\u0000";
					return SKIP;
				case "inlineCode":
				case "html":
				case "image":
				case "imageReference":
					line.prose += "\u0000";
					return SKIP;
				case "break":
					lines.push({ prose: "", links: [] });
			}
		});
		const targets: string[] = [];
		for (const line of lines) {
			if (!line.prose.startsWith("Supersedes:")) continue;
			const prose = line.prose.slice("Supersedes:".length);
			if (/^(?:none|no decision file)\b/i.test(prose.trimStart())) continue;
			const bare = [...prose.matchAll(/(?:^|[\s,;])([^\s,;\u0000]+\.md)(?=$|[\s,;]|\.(?:$|\s))/g)].map((match) => ({
				offset: match.index + "Supersedes:".length,
				destination: match[1]!,
			}));
			for (const { destination } of [...line.links, ...bare].sort((a, b) => a.offset - b.offset)) {
				const repositoryRelative = destination.startsWith("docs/decisions/") || destination.startsWith("/");
				const input =
					destination.startsWith("/") && !destination.startsWith("//") ? destination.slice(1) : destination;
				const target = LocalDestination.resolve(`${posix.dirname(path)}/`, input, repositoryRelative);
				if (target !== undefined && decisionPathPattern.test(target.path)) targets.push(target.path);
			}
		}
		return targets;
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
		// URL removes literal tabs and newlines; mdast can decode them from character references in a filename.
		const input = destination.replaceAll("\n", "%0A").replaceAll("\r", "%0D").replaceAll("\t", "%09");
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
