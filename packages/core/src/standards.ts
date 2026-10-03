import { posix } from "node:path";
import { StandardsError } from "./errors.ts";
import { directoriesUpToRoot, melianPaths, repoPath } from "./paths.ts";
import { openSource, type RepositorySource, SourceError, type SourceReader } from "./source.ts";

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
	const target = repoPath(repoRoot, path);
	const reader = await openSource(repoRoot, source).catch(fromSource);
	const sections: StandardsSection[] = [];
	const included = new Set<string>();
	const expanded = new Set<string>();
	let total = 0;
	const read = async (file: string): Promise<string | undefined> => {
		const content = await skippingSymlinks(reader.readText(file, standardsLimits.fileBytes));
		total += content === undefined ? 0 : Buffer.byteLength(content);
		if (total > standardsLimits.totalBytes) {
			throw new StandardsError(
				"totalTooLarge",
				reader.label(file),
				`standards for ${target || "the repository root"} exceed ${standardsLimits.totalBytes} bytes at ${reader.label(file)}`,
			);
		}
		return content;
	};
	const isDirectory = (await reader.exists(target).catch(fromSource)) === "directory";
	for (const directory of directoriesUpToRoot(target, isDirectory)) {
		for (const file of await standardsFiles(reader, directory)) {
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
				if ((await reader.exists(importPath).catch(fromSource)) !== "file") continue;
				const importedContent = await read(importPath);
				if (importedContent === undefined) continue;
				included.add(importPath);
				sections.push({ path: importPath, content: importedContent, importedBy: file });
			}
		}
	}
	return sections;
}
