import { posix } from "node:path";
import { openSource, visibleText } from "@melian-agent/core";
import { DecisionFilesError } from "./decision-files.ts";

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
		for (const [, target] of content.matchAll(/\[[^\]]+\]\(([^)\s:#]+\.md#[^)\s]+|design\/[^)\s]+\.md)\)/g)) {
			const path = posix.normalize(posix.join("docs", target!.split("#")[0]!));
			if (target!.startsWith("/") || path.startsWith("../"))
				throw new DecisionFilesError("invalid", "A linked design section is outside the repository");
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
			let fence: string | undefined;
			for (const [index, line] of file.content.split("\n").entries()) {
				const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
				if (marker !== undefined) {
					if (fence === undefined) fence = marker;
					else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
					continue;
				}
				const heading = /^#{1,6}[ \t]+(.+)$/.exec(line)?.[1];
				if (fence === undefined && heading !== undefined)
					rows.push(visibleText(`${file.path}:${index + 1} — ${heading}`));
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
