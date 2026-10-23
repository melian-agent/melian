import { openSource, visibleText } from "@melian-agent/core";
import { DecisionFilesError } from "./decision-files-error.ts";
import { LocalDestination, MarkdownDocument } from "./markdown.ts";

/** The largest complete design-heading index sent to a reviewer. */
export const designIndexLimits = { bytes: 64 * 1024 } as const;

/** The largest design file, and the most bytes all design files together, read from the trusted base. */
export const designFileLimits = { bytes: 512 * 1024, totalBytes: 1024 * 1024, lines: 20_000, linkedFiles: 64 } as const;

/** Base vocabulary from the design and the local sections it links. */
export class DesignSections {
	readonly #rows: readonly string[];

	private constructor(rows: readonly string[]) {
		this.#rows = rows;
	}

	/** Loads headings from base design text and Markdown section links. */
	static async load(repoRoot: string, base: string): Promise<DesignSections> {
		const source = await openSource(repoRoot, { kind: "revision", commit: base });
		const content = await source.readText("docs/design.md", designFileLimits.bytes);
		if (content === undefined) return DesignSections.from([]);
		const design = DesignSections.parse("docs/design.md", content);
		const documents = [{ path: "docs/design.md", document: design }];
		let total = Buffer.byteLength(content, "utf8");
		const paths = new Set<string>();
		for (const destination of design.links()) {
			const target = LocalDestination.resolve("docs/design.md", destination);
			if (target === undefined || !target.path.endsWith(".md")) continue;
			if (target.fragment === "" && !target.path.startsWith("docs/design/")) continue;
			paths.add(target.path);
		}
		paths.delete("docs/design.md");
		if (paths.size > designFileLimits.linkedFiles)
			throw new DecisionFilesError(
				"incomplete",
				`Design links ${paths.size} section files; the limit is ${designFileLimits.linkedFiles}; review refused`,
			);
		for (const path of [...paths].sort()) {
			const linked = await source.readText(path, designFileLimits.bytes);
			if (linked === undefined)
				throw new DecisionFilesError("incomplete", `The base design section ${path} is absent`);
			total += Buffer.byteLength(linked, "utf8");
			if (total > designFileLimits.totalBytes)
				throw new DecisionFilesError(
					"incomplete",
					`Design files total ${total} bytes by ${path}; the limit is ${designFileLimits.totalBytes}; review refused`,
				);
			documents.push({ path, document: DesignSections.parse(path, linked) });
		}
		return DesignSections.index(documents);
	}

	/** Indexes headings with their base file and line, excluding fenced examples. */
	static from(files: readonly { path: string; content: string }[]): DesignSections {
		return DesignSections.index(
			files.map((file) => ({ path: file.path, document: DesignSections.parse(file.path, file.content) })),
		);
	}

	private static parse(path: string, content: string): MarkdownDocument {
		const lines = lineCount(content);
		if (lines > designFileLimits.lines)
			throw new DecisionFilesError(
				"incomplete",
				`Design file ${path} has ${lines} lines; the limit is ${designFileLimits.lines}; review refused`,
			);
		return MarkdownDocument.parse(content);
	}

	private static index(documents: readonly { path: string; document: MarkdownDocument }[]): DesignSections {
		const rows: string[] = [];
		let bytes = 0;
		for (const { path, document } of documents) {
			for (const heading of document.headings()) {
				const row = visibleText(`${path}:${heading.line} — ${heading.text}`);
				bytes += Buffer.byteLength(row, "utf8") + (rows.length === 0 ? 0 : 1);
				rows.push(row);
				if (bytes > designIndexLimits.bytes) throw DesignSections.indexTooLarge(rows.length);
			}
		}
		return new DesignSections(rows);
	}

	private static indexTooLarge(headings: number): DecisionFilesError {
		return new DecisionFilesError(
			"incomplete",
			`Design index exceeds ${designIndexLimits.bytes} bytes; ${headings} headings omitted; review refused`,
		);
	}

	/** Renders the complete heading index. */
	render(): string {
		return this.#rows.join("\n");
	}
}

function lineCount(text: string): number {
	let lines = 0;
	let ended = true;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		ended = code === 10 || code === 13;
		if (code === 10 || (code === 13 && text.charCodeAt(i + 1) !== 10)) lines++;
	}
	return ended ? lines : lines + 1;
}
