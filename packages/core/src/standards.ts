import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { directoriesUpToRoot, melianPaths, repoRelative } from "./paths.ts";

/** One standards file, ready to render into a prompt. `path` is repository-relative with forward slashes. */
export interface StandardsSection {
	readonly path: string;
	readonly content: string;
	/** The file whose `@` import line brought this one in, when it was imported rather than found. */
	readonly importedBy?: string;
}

const importLine = /^@(\S+)$/;

// Claude Code's import syntax: a line holding only `@path`. Lines inside fenced code blocks are text.
function imports(content: string): { paths: string[]; onlyImports: boolean } {
	const paths: string[] = [];
	let onlyImports = true;
	let fenced = false;
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("```")) fenced = !fenced;
		const match = fenced ? null : importLine.exec(line);
		if (match !== null) paths.push(match[1]!);
		else if (line !== "") onlyImports = false;
	}
	return { paths, onlyImports: onlyImports && paths.length > 0 };
}

async function standardsFiles(directory: string): Promise<string[]> {
	const standards = join(directory, melianPaths.standards);
	const entries = await readdir(standards).catch(() => []);
	return [
		join(directory, "AGENTS.md"),
		join(directory, "CLAUDE.md"),
		...entries
			.filter((entry) => entry.endsWith(".md"))
			.sort()
			.map((entry) => join(standards, entry)),
	];
}

/**
 * Collects the standards that apply to `path`, a file or directory inside the repository at `repoRoot`, nearest first.
 *
 * Each directory from the path's up to the root contributes its `AGENTS.md`, `CLAUDE.md`, and `.melian/standards/*.md`,
 * in that order. A file's `@path` import lines are followed one level, each imported file placed after its importer;
 * imports reaching outside the repository are skipped. A file holding nothing but imports, such as a `CLAUDE.md` that
 * reads `@AGENTS.md`, contributes only what it imports. A file reached twice, through a symlink or a second import,
 * appears once, at its nearest position.
 */
export async function loadStandards(repoRoot: string, path: string): Promise<StandardsSection[]> {
	const root = await realpath(repoRoot);
	const inside = (file: string) => file === root || file.startsWith(`${root}${sep}`);
	const seen = new Set<string>();
	const sections: StandardsSection[] = [];
	const read = async (file: string): Promise<string | undefined> => {
		const real = await realpath(file).catch(() => undefined);
		if (real === undefined || !inside(real) || seen.has(real)) return undefined;
		const content = await readFile(real, "utf8").catch(() => undefined);
		if (content === undefined) return undefined;
		seen.add(real);
		return content;
	};
	for (const directory of await directoriesUpToRoot(repoRoot, path)) {
		for (const file of await standardsFiles(directory)) {
			const content = await read(file);
			if (content === undefined) continue;
			const found = imports(content);
			const source = repoRelative(repoRoot, file);
			if (!found.onlyImports) sections.push({ path: source, content });
			for (const imported of found.paths) {
				const target = resolve(dirname(file), imported);
				const importedContent = await read(target);
				if (importedContent !== undefined) {
					sections.push({ path: repoRelative(repoRoot, target), content: importedContent, importedBy: source });
				}
			}
		}
	}
	return sections;
}
