import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
	const isDirectory = (await stat(target).catch(() => undefined))?.isDirectory() ?? false;
	const directories: string[] = [];
	for (let directory = isDirectory ? target : dirname(target); ; directory = dirname(directory)) {
		directories.push(directory);
		if (directory === root) return directories;
	}
}
