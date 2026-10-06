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

/** Bounds on individual reads, single chains, and rendered per-lens unions. */
export const standardsLimits = { fileBytes: 256 * 1024, totalBytes: 1024 * 1024, sections: 1024 } as const;

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
	readonly refused = new Map<string, string[]>();
	readonly ignored = new Map<string, Promise<boolean>>();
	readonly oversized = new Map<string, string[]>();
	readonly rootErrors = new Map<string, StandardsError[]>();
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
	isIgnored(path: string): Promise<boolean> {
		let ignored = this.ignored.get(path);
		if (ignored === undefined) {
			ignored = this.reader.isIgnored(path).catch((error: unknown) => {
				if (
					error instanceof SourceError &&
					error.code === "unreadable" &&
					/beyond a symbolic link/.test(error.message)
				)
					return true;
				throw error;
			});
			this.ignored.set(path, ignored);
		}
		return ignored;
	}

	findPaths(pattern: RegExp): Promise<string[]> {
		return this.reader.findPaths(pattern);
	}

	async load(path: string, omitOversized = false): Promise<StandardsSection[]> {
		const target = repoPath(this.repoRoot, path);
		const sections: StandardsSection[] = [];
		const refused: string[] = [];
		this.refused.set(target, refused);
		const oversized: string[] = [];
		const rootErrors: StandardsError[] = [];
		this.oversized.set(target, oversized);
		this.rootErrors.set(target, rootErrors);
		const included = new Set<string>();
		const expanded = new Set<string>();
		let total = 0;
		const counted = new Set<string>();
		const read = async (file: string, rootCarrier: boolean): Promise<string | undefined> => {
			let content: string | undefined;
			try {
				content = await skippingSymlinks(this.readText(file, standardsLimits.fileBytes));
			} catch (error) {
				if (!omitOversized || !(error instanceof StandardsError) || error.code !== "tooLarge") throw error;
				if (rootCarrier) rootErrors.push(error);
				else oversized.push(file);
				return undefined;
			}
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
				const content = await read(file, directory === "");
				if (content === undefined) continue;
				expanded.add(file);
				const found = imports(content);
				if (!found.onlyImports && !included.has(file)) sections.push({ path: file, content });
				included.add(file);
				for (const imported of found.paths) {
					const importPath = importTarget(file, imported);
					if (importPath === undefined || included.has(importPath)) continue;
					if (
						/^(?:melian\.(?:secrets|local)\.yaml|\.env[^/]*)$/i.test(posix.basename(importPath)) ||
						(await this.isIgnored(importPath).catch(fromSource))
					) {
						refused.push(`${file} -> ${importPath}`);
						continue;
					}
					// In running text, `@name` is often prose: a folder, a team, a package scope. Only a file is an import.
					if ((await this.exists(importPath).catch(fromSource)) !== "file") continue;
					const importedContent = await read(importPath, false);
					if (importedContent === undefined) continue;
					included.add(importPath);
					sections.push({ path: importPath, content: importedContent, importedBy: file });
				}
			}
		}
		return sections;
	}
}

function standardsDirectory(path: string): string {
	return posix.dirname(path).replace(/(?:^|\/)\.melian\/standards$/, "") || ".";
}

function listedPaths(paths: readonly string[]): string {
	const listed: string[] = [];
	let bytes = 0;
	for (const path of paths) {
		if (bytes + Buffer.byteLength(path) > 4096 || listed.length === 10) break;
		listed.push(path);
		bytes += Buffer.byteLength(path) + 2;
	}
	return [...listed, ...(listed.length === paths.length ? [] : [`and ${paths.length - listed.length} more`])].join(
		", ",
	);
}

/** The bounded standards a lens reads, with whole sections omitted to keep its prompt within the total limit. */
export class StandardsReading {
	readonly sections: readonly StandardsSection[];
	readonly omitted: readonly string[];
	readonly refused: readonly string[];
	readonly oversized: readonly string[];

	private constructor(
		sections: readonly StandardsSection[],
		omitted: readonly string[],
		refused: readonly string[],
		oversized: readonly string[],
	) {
		this.sections = sections;
		this.omitted = [...new Set([...omitted, ...oversized])];
		this.oversized = oversized;
		this.refused = refused;
	}

	/** Unions sections in their first-seen order and keeps nearest chains where possible within 1 MiB of rendered text and 1024 sections. */
	static from(
		sections: readonly StandardsSection[],
		refused: readonly string[] = [],
		nearest: readonly string[] = [],
		oversized: readonly string[] = [],
	): StandardsReading {
		const seen = new Set<string>();
		const unique = sections.filter((section) => {
			if (seen.has(section.path)) return false;
			seen.add(section.path);
			return true;
		});
		const bytes = (section: StandardsSection) =>
			Buffer.byteLength(`### ${section.path}\n\n${section.content.trim()}`) + 128;
		let total = 1024 + unique.reduce((total, section) => total + bytes(section), 0);
		let count = unique.length;
		const preferred = new Set(nearest);
		const depth = (section: StandardsSection) => {
			const path = section.importedBy ?? section.path;
			const directory = standardsDirectory(path);
			return directory === "." || directory === "" ? 0 : directory.split("/").length;
		};
		const order = unique
			.map((section, index) => ({ section, index, depth: depth(section) }))
			.sort(
				(a, b) =>
					Number(preferred.has(a.section.path)) - Number(preferred.has(b.section.path)) ||
					b.depth - a.depth ||
					b.index - a.index,
			);
		const omitted = new Set<string>();
		for (const { section } of order) {
			if (total <= standardsLimits.totalBytes && count <= standardsLimits.sections) break;
			omitted.add(section.path);
			total -= bytes(section);
			count--;
		}
		return new StandardsReading(
			unique.filter((section) => !omitted.has(section.path)),
			[...omitted],
			[...new Set(refused)],
			[...new Set(oversized)],
		);
	}

	/** The paths actually rendered, in section order. */
	paths(): string[] {
		return this.sections.map((section) => section.path);
	}

	/** The omission note a lens's check record carries, absent when every section fits. */
	note(): string | undefined {
		const capped = this.omitted.filter((path) => !this.oversized.includes(path));
		const omission =
			capped.length === 0
				? undefined
				: `left out ${capped.length} standards section${capped.length === 1 ? "" : "s"} past ${standardsLimits.totalBytes / 1024} KiB: ${listedPaths(capped)}`;
		return (
			[
				omission,
				...(this.oversized.length === 0
					? []
					: [`left out standards over ${standardsLimits.fileBytes / 1024} KiB: ${listedPaths(this.oversized)}`]),
				...(this.refused.length === 0 ? [] : [`refused standards imports: ${listedPaths(this.refused)}`]),
			]
				.filter(Boolean)
				.join("; ") || undefined
		);
	}
}

/** Standards for changed paths from one host-chosen source, sharing reads across their directory chains. */
export class Standards {
	readonly source: RepositorySource;
	readonly #repoRoot: string;
	readonly #chains: ReadonlyMap<string, readonly StandardsSection[]>;
	readonly #refused: ReadonlyMap<string, readonly string[]>;
	readonly #oversized: ReadonlyMap<string, readonly string[]>;
	readonly #rootErrors: ReadonlyMap<string, readonly StandardsError[]>;
	readonly #directories: ReadonlyMap<string, string>;

	private constructor(
		repoRoot: string,
		source: RepositorySource,
		chains: ReadonlyMap<string, readonly StandardsSection[]>,
		directories: ReadonlyMap<string, string>,
		refused: ReadonlyMap<string, readonly string[]>,
		oversized: ReadonlyMap<string, readonly string[]>,
		rootErrors: ReadonlyMap<string, readonly StandardsError[]>,
	) {
		this.#repoRoot = repoRoot;
		this.source = Object.freeze({ ...source });
		this.#chains = chains;
		this.#directories = directories;
		this.#refused = refused;
		this.#oversized = oversized;
		this.#rootErrors = rootErrors;
	}

	/**
	 * Reads each standards file and directory once for all paths. Oversized nested files become chain omissions;
	 * oversized root files throw when {@link forFiles} requests their chain. Other bounds and errors match {@link loadStandards}.
	 */
	static async load(repoRoot: string, source: RepositorySource, paths: readonly string[]): Promise<Standards> {
		const loader = await StandardsLoader.open(repoRoot, source);
		const chains = new Map<string, readonly StandardsSection[]>();
		const directories = new Map<string, string>();
		const refused = new Map<string, readonly string[]>();
		const oversized = new Map<string, readonly string[]>();
		const rootErrors = new Map<string, readonly StandardsError[]>();
		for (const path of paths) {
			const target = repoPath(repoRoot, path);
			const directory =
				(await loader.exists(target).catch(fromSource)) === "directory" ? target : posix.dirname(target);
			directories.set(target, directory);
			if (!chains.has(directory)) {
				chains.set(directory, await loader.load(path, true));
				oversized.set(directory, loader.oversized.get(target) ?? []);
				rootErrors.set(directory, loader.rootErrors.get(target) ?? []);
				refused.set(directory, loader.refused.get(target) ?? []);
			}
		}
		return new Standards(
			repoRoot,
			source.kind === "revision" ? { kind: "revision", commit: loader.reader.commit! } : source,
			chains,
			directories,
			refused,
			oversized,
			rootErrors,
		);
	}

	/** True only when this reading and the validated policy resolve to the same commit. */
	async trustedBy(policy: RepositorySource | undefined): Promise<boolean> {
		if (this.source.kind !== "revision" || policy?.kind !== "revision") return false;
		const reader = await openSource(this.#repoRoot, policy).catch(fromSource);
		return reader.commit === this.source.commit;
	}

	/**
	 * The union of the files' chains, nearest first per file and deduplicated at the first occurrence. A lens over
	 * many directories gets a bounded union, preferring each file's nearest rules and naming omissions in its note.
	 * Throws {@link StandardsError} with `pathNotLoaded` for a path not passed to {@link load}.
	 */
	forFiles(files: readonly string[]): StandardsReading {
		for (const file of files) {
			const target = repoPath(this.#repoRoot, file);
			const directory = this.#directories.get(target);
			if (directory === undefined) {
				throw new StandardsError("pathNotLoaded", target, `standards were not loaded for ${target}`);
			}
			const error = this.#rootErrors.get(directory)?.[0];
			if (error !== undefined) throw error;
		}
		return StandardsReading.from(
			files.flatMap((file) => {
				const target = repoPath(this.#repoRoot, file);
				const directory = this.#directories.get(target) ?? posix.dirname(target);
				return this.#chains.get(directory) ?? [];
			}),
			files.flatMap((file) => {
				const target = repoPath(this.#repoRoot, file);
				return this.#refused.get(this.#directories.get(target) ?? posix.dirname(target)) ?? [];
			}),
			files.flatMap((file) => {
				const target = repoPath(this.#repoRoot, file);
				const chain = this.#chains.get(this.#directories.get(target) ?? posix.dirname(target));
				const nearest = chain?.[0];
				if (nearest === undefined) return [];
				const scope = standardsDirectory(nearest.importedBy ?? nearest.path);
				return chain!
					.filter((section) => standardsDirectory(section.importedBy ?? section.path) === scope)
					.map(({ path }) => path);
			}),
			files.flatMap((file) => {
				const target = repoPath(this.#repoRoot, file);
				return this.#oversized.get(this.#directories.get(target) ?? posix.dirname(target)) ?? [];
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
