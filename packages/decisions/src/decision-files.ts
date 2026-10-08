import { posix } from "node:path";
import { openSource, visibleText } from "@melian-agent/core";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

function markdownNodes(node: Nodes): Nodes[] {
	return [
		node,
		...("children" in node && node.type !== "link" && node.type !== "linkReference"
			? node.children.flatMap(markdownNodes)
			: []),
	];
}

function supersessionProse(content: string): string {
	const nodes = markdownNodes(fromMarkdown(content));
	const definitions = new Map(
		nodes
			.filter((node) => node.type === "definition")
			.reverse()
			.map((node) => [node.identifier, node.url]),
	);
	return nodes
		.filter((node) => node.type === "paragraph")
		.map((paragraph) => {
			const start = paragraph.position!.start.offset!;
			return markdownNodes(paragraph)
				.filter((node) => node.type === "link" || node.type === "linkReference" || node.type === "inlineCode")
				.reverse()
				.reduce(
					(text, node) => {
						const destination = (
							node.type === "inlineCode"
								? ""
								: node.type === "link"
									? node.url
									: definitions.get(node.identifier)!
						).replaceAll("\n", "%0A");
						return `${text.slice(0, node.position!.start.offset! - start)}\u0000${destination}\u0000${text.slice(node.position!.end.offset! - start)}`;
					},
					content.slice(start, paragraph.position!.end.offset),
				);
		})
		.join("\n");
}

function localDecisionTargets(destination: string): string[] {
	let path: string;
	try {
		path = decodeURIComponent(destination.split(/[?#]/, 1)[0]!);
	} catch {
		throw new DecisionFilesError("invalid", `Invalid supersession destination ${destination}`);
	}
	return /^\/?(?:[^:/]+\/)*\d{4}-\d{2}-\d{2}-[\w-]+\.md$/.test(path) ? [path] : [];
}

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

	/** Parses the heading and prose Supersedes lines, excluding code examples. */
	static parse(path: string, content: string): DecisionFile {
		const title = /^# (.+)$/m.exec(content)?.[1] ?? path;
		const targets = [...supersessionProse(content).matchAll(/^Supersedes:[ \t]*([^\n]*)$/gm)].flatMap(([_, line]) => {
			if (/^(?:none|no decision file)\b/i.test(line!)) return [];
			return [...line!.matchAll(/\u0000([^\u0000]*)\u0000|((?:[\w.-]+\/)*\d{4}-\d{2}-\d{2}-[\w-]+\.md)/g)]
				.flatMap(([_, link, bare]) => (link === undefined ? [bare!] : localDecisionTargets(link)))
				.map((target) =>
					target.startsWith("/")
						? posix.normalize(target.slice(1))
						: target.startsWith("docs/decisions/")
							? posix.normalize(target)
							: posix.join(posix.dirname(path), target),
				);
		});
		return new DecisionFile(path, title, [...new Set(targets)]);
	}
}

/** Prompt bounds apply after the complete base graph has been resolved. */
export const decisionIndexLimits = { bytes: 64 * 1024 } as const;

/** All decisions at one revision, with superseded decisions kept as history. */
export class DecisionFiles {
	readonly #files: readonly DecisionFile[];
	readonly #successors: ReadonlyMap<string, readonly string[]>;

	private constructor(files: readonly DecisionFile[], successors: ReadonlyMap<string, readonly string[]>) {
		this.#files = files;
		this.#successors = successors;
	}

	/** Loads every Markdown decision at base; an incomplete read refuses the review. */
	static async load(repoRoot: string, base: string): Promise<DecisionFiles> {
		const source = await openSource(repoRoot, { kind: "revision", commit: base });
		const paths = await source.findPaths(/^docs\/decisions\/.*\.md$/s);
		const files = [];
		for (const path of paths) {
			const content = await source.readText(path, 256 * 1024);
			if (content === undefined) throw new DecisionFilesError("incomplete", `The base decision ${path} is absent`);
			files.push(DecisionFile.parse(path, content));
		}
		return DecisionFiles.from(files);
	}

	/** Resolves all supersession edges before rendering prompt entries. */
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

	/** Renders every path and title, refusing an index beyond its byte bound. */
	render(): string {
		const rows = this.#files.map((file) => {
			const successors = this.#successors.get(file.path);
			const status = successors === undefined ? "ACTIVE" : `INACTIVE; superseded by ${successors.join(", ")}`;
			return visibleText(`[${status}] ${file.path} — ${file.title}`);
		});
		const rendered = rows.join("\n");
		if (Buffer.byteLength(rendered, "utf8") > decisionIndexLimits.bytes)
			throw new DecisionFilesError(
				"incomplete",
				`Decision index exceeds ${decisionIndexLimits.bytes} bytes; ${rows.length} decisions omitted; review refused`,
			);
		return rendered;
	}
}
