import { openSource, visibleText } from "@melian-agent/core";
import { DecisionFilesError } from "./decision-files-error.ts";
import { type DecisionClause, type DecisionDeclaration, decisionPathPattern, MarkdownDocument } from "./markdown.ts";

export { DecisionFilesError } from "./decision-files-error.ts";

/** One written decision, with repository-relative supersession targets. */
export class DecisionFile {
	readonly path: string;
	readonly title: string;
	readonly supersedes: readonly string[];
	readonly amends: readonly string[];
	readonly declarations: readonly DecisionDeclaration[];
	readonly #document: MarkdownDocument;

	private constructor(
		path: string,
		title: string,
		declarations: readonly DecisionDeclaration[],
		document: MarkdownDocument,
	) {
		this.path = path;
		this.title = title;
		this.declarations = declarations;
		this.#document = document;
		this.supersedes = [
			...new Set(
				declarations
					.filter((declaration) => declaration.kind === "Supersedes")
					.flatMap((declaration) => declaration.targets),
			),
		];
		this.amends = [
			...new Set(
				declarations
					.filter((declaration) => declaration.kind === "Amends")
					.flatMap((declaration) => declaration.targets),
			),
		];
	}

	/** Parses the heading and prose Supersedes and Amends lines, excluding code examples. */
	static parse(path: string, content: string): DecisionFile {
		const document = MarkdownDocument.parse(content);
		const title = document.headings().find((heading) => heading.depth === 1)?.text ?? path;
		return new DecisionFile(path, title, document.declarations(path), document);
	}

	/** Extracts sentence evidence without treating textual presence as continued policy. */
	clauses(): DecisionClause[] {
		return this.#document.clauses(this.path);
	}

	/** Lists this target's clauses absent verbatim from its direct successor. */
	uncarriedBy(successor: DecisionFile): DecisionClause[] {
		const carried = new Set(successor.clauses().map((clause) => clause.text));
		return this.clauses().filter((clause) => !carried.has(clause.text));
	}
}

/** Past this many bytes of rendered index, a review warns that the decision log is long. Nothing refuses it. */
export const decisionIndexWarning = { bytes: 64 * 1024 } as const;

/** All decisions at one revision, with superseded decisions kept as history. */
export class DecisionFiles {
	readonly #files: readonly DecisionFile[];
	readonly #successors: ReadonlyMap<string, readonly string[]>;
	readonly #amendments: ReadonlyMap<string, readonly string[]>;

	private constructor(
		files: readonly DecisionFile[],
		successors: ReadonlyMap<string, readonly string[]>,
		amendments: ReadonlyMap<string, readonly string[]>,
	) {
		this.#files = files;
		this.#successors = successors;
		this.#amendments = amendments;
	}

	/** Loads every Markdown decision at base; an incomplete read refuses the review. */
	static async load(repoRoot: string, base: string): Promise<DecisionFiles> {
		const source = await openSource(repoRoot, { kind: "revision", commit: base });
		const paths = await source.findPaths(decisionPathPattern);
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
		const amendments = new Map<string, string[]>();
		for (const file of files) {
			for (const target of new Set([...file.supersedes, ...file.amends])) {
				if (!byPath.has(target)) {
					const verb = file.supersedes.includes(target) ? "supersedes" : "amends";
					throw new DecisionFilesError("invalid", `${file.path} ${verb} absent ${target}`);
				}
				const edges = file.supersedes.includes(target) ? successors : amendments;
				edges.set(target, [...(edges.get(target) ?? []), file.path]);
			}
		}
		const pending = new Set(byPath.keys());
		while (pending.size > 0) {
			const leaves = [...pending].filter(
				(path) =>
					![...byPath.get(path)!.supersedes, ...byPath.get(path)!.amends].some((target) => pending.has(target)),
			);
			if (leaves.length === 0) throw new DecisionFilesError("invalid", "The base decision graph contains a cycle");
			for (const path of leaves) pending.delete(path);
		}
		for (const [target, sources] of amendments) {
			const superseding = successors.get(target);
			if (superseding !== undefined) {
				const replacements = new Set(superseding);
				for (const path of replacements)
					for (const successor of successors.get(path) ?? []) replacements.add(successor);
				const active = [...replacements].filter((path) => !successors.has(path));
				throw new DecisionFilesError(
					"invalid",
					`${sources.join(", ")} amends inactive ${target}; amend active successors instead: ${active.join(", ")}`,
				);
			}
			const active = sources.filter((path) => !successors.has(path));
			if (active.length === 0) amendments.delete(target);
			else amendments.set(target, active);
		}
		return new DecisionFiles(
			[...files].sort((a, b) => a.path.localeCompare(b.path)),
			successors,
			amendments,
		);
	}

	/** Returns all parsed decisions after validating the complete graph. */
	files(): readonly DecisionFile[] {
		return this.#files;
	}

	/** Renders every path and title, at any size. */
	render(): string {
		const rows = this.#files.map((file) => {
			const successors = this.#successors.get(file.path);
			const amendments = this.#amendments.get(file.path);
			const active = amendments === undefined ? "ACTIVE" : `ACTIVE; amended by ${amendments.join(", ")}`;
			const status = successors === undefined ? active : `INACTIVE; superseded by ${successors.join(", ")}`;
			return visibleText(`[${status}] ${file.path} — ${file.title}`);
		});
		return [
			...rows,
			...(this.#amendments.size === 0 ? [] : ["Read both files; where they conflict, the amendment wins."]),
		].join("\n");
	}

	/** Says the decision log is long and how to compact it, once the rendered index passes {@link decisionIndexWarning}. */
	warning(): string | undefined {
		const bytes = Buffer.byteLength(this.render(), "utf8");
		if (bytes <= decisionIndexWarning.bytes) return undefined;
		const count = `${this.#files.length} decision${this.#files.length === 1 ? "" : "s"}`;
		return [
			`The decision log is long: its index is ${bytes} bytes for ${count}, past ${decisionIndexWarning.bytes / 1024} KiB.`,
			"The design lens and its verifier read the index whole, so it costs tokens and can dilute a reviewer's attention.",
			"Compact the decision log: fold amendments into the decisions they amend, merge decisions that belong together, and delete superseded decisions with the Supersedes lines that name them; git history keeps what you delete.",
			"Superseding a decision does not shorten the index, since inactive decisions are still listed.",
			"See https://github.com/melian-agent/melian/blob/main/docs/guidelines/decisions.md#compacting-the-decision-log.",
		].join(" ");
	}
}
