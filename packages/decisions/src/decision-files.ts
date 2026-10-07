import { posix } from "node:path";
import { openSource, visibleText } from "@melian-agent/core";

/** A decision file could not supply a complete, unambiguous baseline. */
export class DecisionFilesError extends Error {
	readonly code: "incomplete" | "invalid";

	constructor(code: "incomplete" | "invalid", message: string) {
		super(message);
		this.name = "DecisionFilesError";
		this.code = code;
	}
}

/** One written decision, with repository-relative supersession targets. */
export class DecisionFile {
	readonly path: string;
	readonly title: string;
	readonly supersedes: readonly string[];

	private constructor(path: string, title: string, supersedes: readonly string[]) {
		this.path = path;
		this.title = title;
		this.supersedes = supersedes;
	}

	/** Parses the heading and dated Markdown filenames on Supersedes lines. */
	static parse(path: string, content: string): DecisionFile {
		const title = /^# (.+)$/m.exec(content)?.[1] ?? path;
		const targets = [...content.matchAll(/^Supersedes:[ \t]*([^\n]*)$/gm)].flatMap(([_, line]) => {
			if (/^(?:none|no decision file)\b/i.test(line!)) return [];
			return [...line!.matchAll(/(?:\]\()?((?:docs\/decisions\/)?\d{4}-\d{2}-\d{2}-[\w-]+\.md)/g)].map(
				([_, target]) => posix.join("docs/decisions", posix.basename(target!)),
			);
		});
		return new DecisionFile(path, title, [...new Set(targets)]);
	}
}

/** Prompt bounds apply after the complete base graph has been resolved. */
export const decisionIndexLimits = { entries: 100, rowCharacters: 512 } as const;

/** All decisions at one revision, with superseded decisions kept as history. */
export class DecisionFiles {
	readonly #files: readonly DecisionFile[];
	readonly #successors: ReadonlyMap<string, readonly string[]>;

	private constructor(files: readonly DecisionFile[], successors: ReadonlyMap<string, readonly string[]>) {
		this.#files = files;
		this.#successors = successors;
	}

	/** Loads every Markdown decision at base; an incomplete read refuses the review. */
	static async open(repoRoot: string, base: string): Promise<DecisionFiles> {
		const source = await openSource(repoRoot, { kind: "revision", commit: base });
		const paths = await source.findPaths(/^docs\/decisions\/.*\.md$/);
		const files = [];
		for (const path of paths) {
			const content = await source.readText(path, 256 * 1024);
			if (content === undefined) throw new DecisionFilesError("incomplete", `The base decision ${path} is absent`);
			files.push(DecisionFile.parse(path, content));
		}
		return DecisionFiles.from(files);
	}

	/** Resolves all supersession edges before any prompt entries are omitted. */
	static from(files: readonly DecisionFile[]): DecisionFiles {
		const byPath = new Map(files.map((file) => [file.path, file]));
		const successors = new Map<string, string[]>();
		for (const file of files) {
			for (const target of file.supersedes) {
				if (!byPath.has(target))
					throw new DecisionFilesError("invalid", `${file.path} supersedes absent ${target}`);
				successors.set(target, [...(successors.get(target) ?? []), file.path]);
			}
		}
		const pending = new Set(byPath.keys());
		while (pending.size > 0) {
			const leaves = [...pending].filter(
				(path) => !byPath.get(path)!.supersedes.some((target) => pending.has(target)),
			);
			if (leaves.length === 0) throw new DecisionFilesError("invalid", "The base Supersedes graph contains a cycle");
			for (const path of leaves) pending.delete(path);
		}
		return new DecisionFiles(
			[...files].sort((a, b) => a.path.localeCompare(b.path)),
			successors,
		);
	}

	/** Renders bounded candidate paths and titles, with direct successors for inactive entries. */
	render(): string {
		const shown = this.#files.slice(0, decisionIndexLimits.entries);
		const rows = shown.map((file) => {
			const successors = this.#successors.get(file.path);
			const status = successors === undefined ? "ACTIVE" : `INACTIVE; superseded by ${successors.join(", ")}`;
			return visibleText(`[${status}] ${file.path} — ${file.title}`).slice(0, decisionIndexLimits.rowCharacters);
		});
		const omitted = this.#files.length - shown.length;
		return [
			...rows,
			...(omitted > 0 ? [`[and ${omitted} more decisions; discover them with base search]`] : []),
			`[rows show at most ${decisionIndexLimits.rowCharacters} characters; read base files for full titles and links]`,
		].join("\n");
	}
}
