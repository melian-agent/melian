import { posix } from "node:path";
import { StandardsError } from "./errors.ts";
import { directoriesUpToRoot, melianPaths, repoPath } from "./paths.ts";
import {
	type Entry,
	type EntryKind,
	openSource,
	type RepositorySource,
	SourceError,
	type SourceReader,
} from "./source.ts";

/** One standards file, ready to render into a prompt. `path` is repository-relative with forward slashes. */
export interface StandardsSection {
	readonly path: string;
	readonly content: string;
	/** The file whose `@` import line brought this one in, when it was imported rather than found. */
	readonly importedBy?: string;
}

/** The largest standards file the loader reads, and the most it reads for one path in total. Past either is an error. */
export const standardsLimits = { fileBytes: 256 * 1024, totalBytes: 1024 * 1024 } as const;

// An `@path` token at the start of a line or after whitespace, so `tal@example.com` is not one. Trailing sentence
// punctuation belongs to the prose, not the path.
const importToken = /(^|\s)@([^\s`]+?)[.,;:!?)]*(?=\s|$)/g;
const codeSpan = /`+[^`]*`+/g;

// Claude Code's import syntax: `@path` anywhere in the text, except inside a code span or a fenced code block, fenced
// with ``` or ~~~. A file whose every line is imports, such as a CLAUDE.md reading `@AGENTS.md`, is import-only.
function imports(content: string): { paths: string[]; onlyImports: boolean } {
	const paths: string[] = [];
	let onlyImports = true;
	let fence: string | undefined;
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		const marker = /^(```|~~~)/.exec(line)?.[1];
		if (fence === undefined && marker !== undefined) fence = marker;
		else if (fence !== undefined && marker === fence) fence = undefined;
		else if (fence === undefined) {
			const text = line.replace(codeSpan, " ");
			const found = [...text.matchAll(importToken)].map((match) => match[2]!);
			paths.push(...found);
			if (text.replace(importToken, "").trim() !== "") onlyImports = false;
			continue;
		}
		onlyImports = false;
	}
	return { paths, onlyImports: onlyImports && paths.length > 0 };
}

function fromSource(error: unknown): never {
	if (!(error instanceof SourceError) || error.code === "symlink") throw error;
	throw new StandardsError(error.code, error.path, error.message, { cause: error });
}

// A symlink is skipped rather than refused, so that a `CLAUDE.md` linked to `AGENTS.md` costs nothing; the file it
// points at is read under its own name if it is a standards file.
function skippingSymlinks<T>(read: Promise<T>): Promise<T | undefined> {
	return read.catch((error: unknown) => {
		if (error instanceof SourceError && error.code === "symlink") return undefined;
		return fromSource(error);
	});
}

async function standardsFiles(source: SourceReader, directory: string): Promise<string[]> {
	const standards = posix.join(directory, melianPaths.standards);
	const entries = (await skippingSymlinks(source.list(standards))) ?? [];
	return [
		posix.join(directory, "AGENTS.md"),
		posix.join(directory, "CLAUDE.md"),
		...entries
			.filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
			.map((entry) => entry.name)
			.sort()
			.map((name) => posix.join(standards, name)),
	];
}

// Imports resolve against the importing file's directory and must stay inside the repository.
function importTarget(file: string, imported: string): string | undefined {
	if (posix.isAbsolute(imported)) return undefined;
	const target = posix.normalize(posix.join(posix.dirname(file), imported));
	return target === ".." || target.startsWith("../") ? undefined : target;
}

/**
 * Collects the standards that apply to `path`, a file or directory inside the repository at `repoRoot`, nearest first,
 * reading every file from `source`: a commit, or the working tree. The host picks the source; for a pull request it
 * passes the base commit, so that the head's changes to standards are reviewed as code and apply once merged.
 *
 * Each directory from the path's up to the root contributes its `AGENTS.md`, `CLAUDE.md`, and `.melian/standards/*.md`,
 * in that order. A file's `@path` imports, anywhere outside code, are followed one level, each imported file placed
 * after its importer; an import that leaves the repository or names no file is skipped. A file holding nothing but
 * imports, such as a `CLAUDE.md` that reads `@AGENTS.md`, contributes only what it imports. A file reached twice appears once, at its nearest position.
 *
 * A missing file and a symlink are skipped. Throws {@link StandardsError} for a file over
 * `standardsLimits.fileBytes`, for more than `standardsLimits.totalBytes` in all, for any other read failure, and for
 * a root that is missing or not a repository; and {@link OutsideRepositoryError} when `path` is outside `repoRoot`.
 */
export async function loadStandards(
	repoRoot: string,
	source: RepositorySource,
	path: string,
): Promise<StandardsSection[]> {
	return (await StandardsLoader.open(repoRoot, source)).load(path);
}

class StandardsLoader implements SourceReader {
	readonly repoRoot: string;
	readonly reader: SourceReader;
	readonly texts = new Map<string, Promise<string | undefined>>();
	readonly directories = new Map<string, Promise<readonly Entry[] | undefined>>();
	readonly kinds = new Map<string, Promise<EntryKind | undefined>>();

	private constructor(repoRoot: string, reader: SourceReader) {
		this.repoRoot = repoRoot;
		this.reader = reader;
	}

	static async open(repoRoot: string, source: RepositorySource): Promise<StandardsLoader> {
		return new StandardsLoader(repoRoot, await openSource(repoRoot, source).catch(fromSource));
	}

	label(path: string): string {
		return this.reader.label(path);
	}
	readText(path: string, maxBytes: number): Promise<string | undefined> {
		let read = this.texts.get(path);
		if (read === undefined) {
			read = this.reader.readText(path, maxBytes);
			this.texts.set(path, read);
		}
		return read;
	}
	list(directory: string): Promise<readonly Entry[] | undefined> {
		let read = this.directories.get(directory);
		if (read === undefined) {
			read = this.reader.list(directory);
			this.directories.set(directory, read);
		}
		return read;
	}
	exists(path: string): Promise<EntryKind | undefined> {
		let read = this.kinds.get(path);
		if (read === undefined) {
			read = this.reader.exists(path);
			this.kinds.set(path, read);
		}
		return read;
	}
	findPaths(pattern: RegExp): Promise<string[]> {
		return this.reader.findPaths(pattern);
	}

	async load(path: string): Promise<StandardsSection[]> {
		const target = repoPath(this.repoRoot, path);
		const sections: StandardsSection[] = [];
		const included = new Set<string>();
		const expanded = new Set<string>();
		let total = 0;
		const counted = new Set<string>();
		const read = async (file: string): Promise<string | undefined> => {
			const content = await skippingSymlinks(this.readText(file, standardsLimits.fileBytes));
			if (!counted.has(file)) total += content === undefined ? 0 : Buffer.byteLength(content);
			counted.add(file);
			if (total > standardsLimits.totalBytes) {
				throw new StandardsError(
					"totalTooLarge",
					this.label(file),
					`standards for ${target || "the repository root"} exceed ${standardsLimits.totalBytes} bytes at ${this.label(file)}`,
				);
			}
			return content;
		};
		const isDirectory = (await this.exists(target).catch(fromSource)) === "directory";
		for (const directory of directoriesUpToRoot(target, isDirectory)) {
			for (const file of await standardsFiles(this, directory)) {
				// A file already imported from a nearer directory keeps that position, but its own imports still apply.
				if (expanded.has(file)) continue;
				const content = await read(file);
				if (content === undefined) continue;
				expanded.add(file);
				const found = imports(content);
				if (!found.onlyImports && !included.has(file)) sections.push({ path: file, content });
				included.add(file);
				for (const imported of found.paths) {
					const importPath = importTarget(file, imported);
					if (importPath === undefined || included.has(importPath)) continue;
					// In running text, `@name` is often prose: a folder, a team, a package scope. Only a file is an import.
					if ((await this.exists(importPath).catch(fromSource)) !== "file") continue;
					const importedContent = await read(importPath);
					if (importedContent === undefined) continue;
					included.add(importPath);
					sections.push({ path: importPath, content: importedContent, importedBy: file });
				}
			}
		}
		return sections;
	}
}

/** The bounded standards a lens reads, with whole sections omitted to keep its prompt within the total limit. */
export class StandardsReading {
	readonly sections: readonly StandardsSection[];
	readonly omitted: readonly string[];

	private constructor(sections: readonly StandardsSection[], omitted: readonly string[]) {
		this.sections = sections;
		this.omitted = omitted;
	}

	/** Unions sections in their first-seen order and drops the deepest sections first when the union exceeds 1 MiB. */
	static from(sections: readonly StandardsSection[]): StandardsReading {
		const seen = new Set<string>();
		const unique = sections.filter((section) => {
			if (seen.has(section.path)) return false;
			seen.add(section.path);
			return true;
		});
		let total = unique.reduce((bytes, section) => bytes + Buffer.byteLength(section.content), 0);
		const depth = (section: StandardsSection) => {
			const path = section.importedBy ?? section.path;
			const directory = posix.dirname(path).replace(/(?:^|\/)\.melian\/standards$/, "");
			return directory === "." || directory === "" ? 0 : directory.split("/").length;
		};
		const order = unique
			.map((section, index) => ({ section, index, depth: depth(section) }))
			.sort((a, b) => b.depth - a.depth || b.index - a.index);
		const omitted = new Set<string>();
		for (const { section } of order) {
			if (total <= standardsLimits.totalBytes) break;
			omitted.add(section.path);
			total -= Buffer.byteLength(section.content);
		}
		return new StandardsReading(
			unique.filter((section) => !omitted.has(section.path)),
			[...omitted],
		);
	}

	/** The paths actually rendered, in section order. */
	paths(): string[] {
		return this.sections.map((section) => section.path);
	}

	/** The omission note a lens's check record carries, absent when every section fits. */
	note(): string | undefined {
		return this.omitted.length === 0
			? undefined
			: `left out ${this.omitted.length} standards section${this.omitted.length === 1 ? "" : "s"} past ${standardsLimits.totalBytes / 1024} KiB: ${this.omitted.join(", ")}`;
	}
}

/** Standards for changed paths from one host-chosen source, sharing reads across their directory chains. */
export class Standards {
	readonly source: RepositorySource;
	readonly #repoRoot: string;
	readonly #chains: ReadonlyMap<string, readonly StandardsSection[]>;
	readonly #directories: ReadonlyMap<string, string>;

	private constructor(
		repoRoot: string,
		source: RepositorySource,
		chains: ReadonlyMap<string, readonly StandardsSection[]>,
		directories: ReadonlyMap<string, string>,
	) {
		this.#repoRoot = repoRoot;
		this.source = source;
		this.#chains = chains;
		this.#directories = directories;
	}

	/**
	 * Reads each standards file and directory once for all paths. Every single path must fit the loader's bounds;
	 * symlinks are skipped and imports resolve one level. Throws the same typed errors as {@link loadStandards}.
	 */
	static async load(repoRoot: string, source: RepositorySource, paths: readonly string[]): Promise<Standards> {
		const loader = await StandardsLoader.open(repoRoot, source);
		const chains = new Map<string, readonly StandardsSection[]>();
		const directories = new Map<string, string>();
		for (const path of paths) {
			const target = repoPath(repoRoot, path);
			const directory =
				(await loader.exists(target).catch(fromSource)) === "directory" ? target : posix.dirname(target);
			directories.set(target, directory);
			if (!chains.has(directory)) chains.set(directory, await loader.load(path));
		}
		return new Standards(repoRoot, source, chains, directories);
	}

	/**
	 * The union of the files' chains, nearest first per file and deduplicated at the first occurrence. A lens over
	 * many directories gets a bounded union, with whole sections farthest from the root omitted and named in its note.
	 */
	forFiles(files: readonly string[]): StandardsReading {
		return StandardsReading.from(
			files.flatMap((file) => {
				const target = repoPath(this.#repoRoot, file);
				const directory = this.#directories.get(target) ?? posix.dirname(target);
				return this.#chains.get(directory) ?? [];
			}),
		);
	}
}

/** A standards carrier found in the source, with its size or the symlink the reader skipped. */
export type StandardsEntry =
	| { readonly path: string; readonly bytes: number; readonly oversized: boolean }
	| { readonly path: string; readonly symlink: true };

/** A source's standards carriers at every depth, without following imports or reviewing their contents. */
export class StandardsInventory {
	readonly entries: readonly StandardsEntry[];

	private constructor(entries: readonly StandardsEntry[]) {
		this.entries = entries;
	}

	/**
	 * Finds AGENTS.md, CLAUDE.md and .melian/standards/*.md through the source's path listing. Reads stay within the
	 * per-file bound; an oversized file contributes its reported size, and a symlink contributes a warning alone.
	 * Throws {@link StandardsError} for other source failures.
	 */
	static async inspect(repoRoot: string, source: RepositorySource): Promise<StandardsInventory> {
		const reader = await openSource(repoRoot, source).catch(fromSource);
		const paths = await reader
			.findPaths(/(?:^|\/)(?:AGENTS\.md|CLAUDE\.md)$|(?:^|\/)\.melian\/standards\/[^/]+\.md$/s)
			.catch(fromSource);
		const entries: StandardsEntry[] = [];
		for (const path of paths.sort()) {
			try {
				const content = await reader.readText(path, standardsLimits.fileBytes);
				if (content !== undefined) entries.push({ path, bytes: Buffer.byteLength(content), oversized: false });
			} catch (error) {
				if (error instanceof SourceError && error.code === "symlink") entries.push({ path, symlink: true });
				else if (error instanceof SourceError && error.code === "tooLarge" && error.size !== undefined)
					entries.push({ path, bytes: error.size, oversized: true });
				else fromSource(error);
			}
		}
		return new StandardsInventory(entries);
	}

	/** The number of regular files found; skipped symlinks do not count. */
	count(): number {
		return this.entries.filter((entry) => "bytes" in entry).length;
	}

	/** The total size of the regular files, including those too large to read. */
	bytes(): number {
		return this.entries.reduce((total, entry) => total + ("bytes" in entry ? entry.bytes : 0), 0);
	}

	/** The oversized files and skipped symlinks. */
	warnings(): readonly StandardsEntry[] {
		return this.entries.filter((entry) => "symlink" in entry || entry.oversized);
	}
}
