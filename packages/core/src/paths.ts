import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { OutsideRepositoryError } from "./errors.ts";

/**
 * Where Melian's files live, relative to a directory in the repository. `melian.yaml` and `.melian/` may sit in any
 * directory; `standards` and `lenses` resolve nearest-first like `melian.yaml`. `knowledge` is read only at the root.
 * `localConfig` and `secrets`, beside the root `melian.yaml`, are a maintainer's own, read only from the working tree.
 */
export const melianPaths = {
	config: "melian.yaml",
	localConfig: "melian.local.yaml",
	secrets: "melian.secrets.yaml",
	home: ".melian",
	lenses: ".melian/lenses",
	standards: ".melian/standards",
	knowledge: ".melian/knowledge",
} as const;

const policyNames = new Set([melianPaths.config, "AGENTS.md", "CLAUDE.md"]);

// A maintainer's own files, matched in any case: a case-insensitive filesystem opens a committed
// `MELIAN.SECRETS.YAML` as `melian.secrets.yaml`, so a commit of either under another case is policy too.
const ownNames = new Set<string>([melianPaths.localConfig, melianPaths.secrets]);

/**
 * The names of the files that configure a static tool, in any directory. The head's copy drives the tool's run on the
 * head, so a change to one is a change to what judges the head.
 */
export const analyserConfigNames = [
	"biome.json",
	"biome.jsonc",
	"tsconfig*.json",
	"package.json",
	"package-lock.json",
	".eslintrc*",
	"eslint.config.*",
] as const;

const analyserConfig = /^(?:biome\.jsonc?|tsconfig.*\.json|package(?:-lock)?\.json|\.eslintrc.*|eslint\.config\..*)$/;

// Whether a repository-relative path configures a static tool, by its name alone.
export function isAnalyserConfig(path: string): boolean {
	return analyserConfig.test(path.split("/").at(-1)!);
}

// Whether a repository-relative path steers Melian: a melian.yaml, a standards file, anything under a .melian/, or a
// static tool's configuration.
export function isPolicyFile(path: string): boolean {
	const segments = path.split("/");
	return (
		policyNames.has(segments.at(-1)!) ||
		ownNames.has(segments.at(-1)!.toLowerCase()) ||
		segments.slice(0, -1).includes(melianPaths.home) ||
		isAnalyserConfig(path)
	);
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
