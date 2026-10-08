import { posix } from "node:path";
import { openSource, visibleText } from "@melian-agent/core";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { DecisionFilesError } from "./decision-files.ts";

/** The largest complete design-heading index sent to a reviewer. */
export const designIndexLimits = { bytes: 64 * 1024 } as const;

function markdownNodes(node: Nodes): Nodes[] {
	return [node, ...("children" in node ? node.children.flatMap(markdownNodes) : [])];
}

/** Base vocabulary from the design and the local sections it links. */
export class DesignSections {
	readonly #rows: readonly string[];

	private constructor(rows: readonly string[]) {
		this.#rows = rows;
	}

	/** Loads headings from base design text and Markdown section links. */
	static async load(repoRoot: string, base: string): Promise<DesignSections> {
		const source = await openSource(repoRoot, { kind: "revision", commit: base });
		const content = await source.readText("docs/design.md", 256 * 1024);
		if (content === undefined) return DesignSections.from([]);
		const files = [{ path: "docs/design.md", content }];
		const paths = new Set<string>();
		const nodes = markdownNodes(fromMarkdown(content));
		const definitions = new Map(
			nodes
				.filter((node) => node.type === "definition")
				.reverse()
				.map((node) => [node.identifier, node.url]),
		);
		for (const node of nodes.filter((node) => node.type === "link" || node.type === "linkReference")) {
			const target = node.type === "link" ? node.url : definitions.get(node.identifier)!;
			const destination = target.split(/[?#]/, 1)[0]!;
			if (destination.includes(":") || destination.startsWith("//")) continue;
			let section: string;
			try {
				section = decodeURIComponent(destination);
			} catch {
				throw new DecisionFilesError("invalid", "A linked design section has invalid URI encoding");
			}
			if (!section.endsWith(".md")) continue;
			const path = posix.normalize(posix.join("docs", section));
			if (section.startsWith("/") || path.startsWith("../"))
				throw new DecisionFilesError("invalid", "A linked design section is outside the repository");
			if (!target.includes("#") && !path.startsWith("docs/design/")) continue;
			paths.add(path);
		}
		paths.delete("docs/design.md");
		for (const path of [...paths].sort()) {
			const linked = await source.readText(path, 256 * 1024);
			if (linked === undefined)
				throw new DecisionFilesError("incomplete", `The base design section ${path} is absent`);
			files.push({ path, content: linked });
		}
		return DesignSections.from(files);
	}

	/** Indexes headings with their base file and line, excluding fenced examples. */
	static from(files: readonly { path: string; content: string }[]): DesignSections {
		const rows: string[] = [];
		for (const file of files) {
			for (const node of markdownNodes(fromMarkdown(file.content)).filter((node) => node.type === "heading")) {
				const heading = markdownNodes(node).reduce(
					(text, part) => ("value" in part ? text + part.value : text),
					"",
				);
				rows.push(visibleText(`${file.path}:${node.position!.start.line} — ${heading}`));
			}
		}
		return new DesignSections(rows);
	}

	/** Renders the complete heading index or refuses review above its byte bound. */
	render(): string {
		const rendered = this.#rows.join("\n");
		if (Buffer.byteLength(rendered, "utf8") > designIndexLimits.bytes)
			throw new DecisionFilesError(
				"incomplete",
				`Design index exceeds ${designIndexLimits.bytes} bytes; ${this.#rows.length} headings omitted; review refused`,
			);
		return rendered;
	}
}
