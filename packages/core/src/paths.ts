import { isAbsolute, relative, resolve, sep } from "node:path";
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

// A path given to a loader, absolute or relative to the root, as a repository-relative path with forward slashes.
export function repoPath(repoRoot: string, path: string): string {
	const root = resolve(repoRoot);
	const fromRoot = relative(root, resolve(root, path));
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
		throw new OutsideRepositoryError(path, root);
	return fromRoot.split(sep).join("/");
}

// Nearest first, ending with "" for the root. Walking segments, never the filesystem, always ends.
export function directoriesUpToRoot(path: string, isDirectory: boolean): string[] {
	const segments = path === "" ? [] : path.split("/");
	if (!isDirectory) segments.pop();
	return segments.map((_, index) => segments.slice(0, segments.length - index).join("/")).concat("");
}
