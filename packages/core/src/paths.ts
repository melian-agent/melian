import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { OutsideRepositoryError } from "./errors.ts";

/**
 * Where Melian's files live, relative to a directory in the repository. `melian.yaml` and `.melian/` may sit in any
 * directory; `standards` and `lenses` resolve nearest-first like `melian.yaml`. `knowledge` is read only at the root.
 */
export const melianPaths = {
	config: "melian.yaml",
	home: ".melian",
	lenses: ".melian/lenses",
	standards: ".melian/standards",
	knowledge: ".melian/knowledge",
} as const;

const policyNames = new Set([melianPaths.config, "AGENTS.md", "CLAUDE.md"]);

// Whether a repository-relative path steers Melian: a melian.yaml, a standards file, or anything under a .melian/.
export function isPolicyFile(path: string): boolean {
	const segments = path.split("/");
	return policyNames.has(segments.at(-1)!) || segments.slice(0, -1).includes(melianPaths.home);
}

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

// A lens path glob written relative to `directory`, made repository-relative: `./src/**` from `services/pay` is
// `services/pay/src/**`, a leading `/` is relative to `directory` too, and a leading `!` is kept. Undefined when `..`
// climbs out of the repository, so each caller can name the file and field in its own error.
export function anchorGlob(directory: string, glob: string): string | undefined {
	const negated = glob.startsWith("!");
	const pattern = (negated ? glob.slice(1) : glob).replace(/^\/+/, "");
	const anchored = posix.normalize(posix.join(directory, pattern));
	if (anchored === ".." || anchored.startsWith("../")) return undefined;
	return `${negated ? "!" : ""}${anchored}`;
}
