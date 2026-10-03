import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { OutsideRepositoryError } from "./errors.ts";

/**
 * Where Melian's files live, relative to a directory in the repository. `melian.yaml` may sit in any directory. The
 * `.melian/` directory at the repository root holds lenses, standards, and knowledge.
 */
export const melianPaths = {
	config: "melian.yaml",
	home: ".melian",
	lenses: ".melian/lenses",
	standards: ".melian/standards",
	knowledge: ".melian/knowledge",
} as const;

export function repoRelative(repoRoot: string, path: string): string {
	return relative(repoRoot, path).split(sep).join("/");
}

// A path that does not exist, such as a file the changeset deleted, counts as a file.
export async function directoriesUpToRoot(repoRoot: string, path: string): Promise<string[]> {
	const root = resolve(repoRoot);
	const target = resolve(root, path);
	const fromRoot = relative(root, target);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
		throw new OutsideRepositoryError(path, root);
	const segments = fromRoot === "" ? [] : fromRoot.split(sep);
	const isDirectory = segments.length === 0 || ((await stat(target).catch(() => undefined))?.isDirectory() ?? false);
	if (!isDirectory) segments.pop();
	// Walking segments rather than calling dirname until it reaches the root ends even when the root does not exist.
	return segments.map((_, index) => join(root, ...segments.slice(0, segments.length - index))).concat(root);
}
