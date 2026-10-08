import { openSource, visibleText } from "@melian-agent/core";
import { DecisionFilesError } from "./decision-files-error.ts";
import { LocalDestination, MarkdownDocument } from "./markdown.ts";

/** The largest complete design-heading index sent to a reviewer. */
export const designIndexLimits = { bytes: 64 * 1024 } as const;

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
		for (const destination of MarkdownDocument.parse(content).links()) {
			const target = LocalDestination.resolve("docs/design.md", destination);
			if (target === undefined || !target.path.endsWith(".md")) continue;
			if (target.fragment === "" && !target.path.startsWith("docs/design/")) continue;
			paths.add(target.path);
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
			for (const heading of MarkdownDocument.parse(file.content).headings()) {
				rows.push(visibleText(`${file.path}:${heading.line} — ${heading.text}`));
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
