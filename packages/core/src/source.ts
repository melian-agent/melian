import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { git, isNotARepository } from "./git.ts";

/**
 * Where policy (`melian.yaml`) and standards are read from. The host chooses, because only the host knows who wrote
 * what: for a pull request it passes the base commit, so a head cannot rewrite the policy or prompts of its own review;
 * for a maintainer's local run it may pass the working tree. Core never decides trust, and one load never mixes sources.
 */
export type RepositorySource = { readonly kind: "revision"; readonly commit: string } | { readonly kind: "worktree" };

export type EntryKind = "file" | "directory" | "symlink" | "other";

export interface Entry {
	readonly name: string;
	readonly kind: EntryKind;
}

export type SourceErrorCode =
	| "missingRoot"
	| "notARepository"
	| "unknownCommit"
	| "symlink"
	| "tooLarge"
	| "unreadable";

// Loaders translate this into their own typed error, so it never leaves the package.
export class SourceError extends Error {
	readonly code: SourceErrorCode;
	readonly path: string;

	constructor(code: SourceErrorCode, path: string, message: string, options: { cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "SourceError";
		this.code = code;
		this.path = path;
	}
}

// Paths are repository-relative with forward slashes, "" for the root, and already checked to stay inside it.
// Neither implementation follows a symlink: a symlink is refused with `symlink`, and a path beneath a symlinked
// directory does not exist, as in git's own trees.
export interface SourceReader {
	// Names a file for messages: the path for the working tree, git's `<commit>:<path>` for a revision.
	label(path: string): string;
	// Undefined when the path does not exist. Throws `symlink`, `tooLarge` past `maxBytes`, or `unreadable`.
	readText(path: string, maxBytes: number): Promise<string | undefined>;
	// Undefined when the directory does not exist. Throws `symlink` for a symlinked directory.
	list(directory: string): Promise<readonly Entry[] | undefined>;
	exists(path: string): Promise<EntryKind | undefined>;
}

export async function openSource(repoRoot: string, source: RepositorySource): Promise<SourceReader> {
	if (!(await stat(repoRoot).catch(() => undefined))?.isDirectory()) {
		throw new SourceError("missingRoot", repoRoot, `${repoRoot} is not a directory`);
	}
	return source.kind === "worktree" ? worktreeSource(repoRoot) : revisionSource(repoRoot, source.commit);
}

function tooLarge(label: string, size: number, maxBytes: number): SourceError {
	return new SourceError("tooLarge", label, `${label} is ${size} bytes; the limit is ${maxBytes}`);
}

function symlink(label: string): SourceError {
	return new SourceError("symlink", label, `${label} is a symlink, which Melian does not follow`);
}

function kindOfStats(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isDirectory()) return "directory";
	return stats.isFile() ? "file" : "other";
}

function isAbsence(error: NodeJS.ErrnoException): boolean {
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function worktreeSource(root: string): SourceReader {
	const unreadable = (path: string) => (cause: NodeJS.ErrnoException) => {
		throw new SourceError("unreadable", path, `${path}: ${cause.message}`, { cause });
	};
	// lstat each component, so that a symlinked directory partway down hides what lies beneath it.
	const exists = async (path: string): Promise<EntryKind | undefined> => {
		if (path === "") return "directory";
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const stats = await lstat(join(root, prefix)).catch((error: NodeJS.ErrnoException) =>
				isAbsence(error) ? undefined : unreadable(prefix)(error),
			);
			if (stats === undefined) return undefined;
			const kind = kindOfStats(stats);
			if (i === parts.length) return kind;
			if (kind !== "directory") return undefined;
		}
		return undefined;
	};
	return {
		label: (path) => path,
		exists,
		async readText(path, maxBytes) {
			const kind = await exists(path);
			if (kind === undefined) return undefined;
			if (kind === "symlink") throw symlink(path);
			if (kind !== "file") throw new SourceError("unreadable", path, `${path} is not a file`);
			// O_NOFOLLOW refuses a symlink swapped in after the lstat above.
			const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ELOOP") throw symlink(path);
					return isAbsence(error) ? undefined : unreadable(path)(error);
				},
			);
			if (handle === undefined) return undefined;
			try {
				const { size } = await handle.stat();
				if (size > maxBytes) throw tooLarge(path, size, maxBytes);
				return await handle.readFile("utf8");
			} catch (error) {
				if (error instanceof SourceError) throw error;
				return unreadable(path)(error as NodeJS.ErrnoException);
			} finally {
				await handle.close();
			}
		},
		async list(directory) {
			const kind = await exists(directory);
			if (kind === "symlink") throw symlink(directory);
			if (kind !== "directory") return undefined;
			const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(unreadable(directory));
			return entries.map((entry) => ({ name: entry.name, kind: kindOfStats(entry) }));
		},
	};
}

export interface TreeEntry {
	readonly kind: EntryKind;
	readonly object: string;
	readonly size: number;
	readonly path: string;
}

function treeKind(mode: string): EntryKind {
	if (mode === "040000") return "directory";
	if (mode === "120000") return "symlink";
	return mode.startsWith("100") ? "file" : "other";
}

// `git ls-tree -l -z`: `<mode> <type> <object> <size>\t<path>`, the size padded and `-` for a tree.
export function parseTree(output: string): TreeEntry[] {
	return output
		.split("\0")
		.filter((line) => line !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			const [mode, , object, size] = line.slice(0, tab).split(/ +/);
			return { kind: treeKind(mode!), object: object!, size: Number(size), path: line.slice(tab + 1) };
		});
}

async function revisionSource(repoRoot: string, commit: string): Promise<SourceReader> {
	const notARepository = new SourceError(
		"notARepository",
		repoRoot,
		`${repoRoot} is not the root of a git working tree`,
	);
	const prefix = await git(repoRoot, ["rev-parse", "--show-prefix"]);
	if (prefix.code !== 0 && !isNotARepository(prefix.stderr)) {
		throw new SourceError("unreadable", repoRoot, `${repoRoot}: ${prefix.stderr.trim()}`);
	}
	if (prefix.code !== 0 || prefix.stdout.trim() !== "") throw notARepository;
	const unknownCommit = new SourceError("unknownCommit", commit, `${commit} does not name a commit`);
	if (commit.startsWith("-") || commit.startsWith("^")) throw unknownCommit;
	const resolved = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
	// --quiet silences an unknown commit, so anything on stderr is a different failure.
	if (resolved.code !== 0 && resolved.stderr.trim() !== "") {
		throw new SourceError("unreadable", commit, `${commit}: ${resolved.stderr.trim()}`);
	}
	if (resolved.code !== 0) throw unknownCommit;
	const sha = resolved.stdout.trim();
	const label = (path: string) => `${sha.slice(0, 12)}:${path}`;
	const run = async (path: string, args: readonly string[]): Promise<string> => {
		const result = await git(repoRoot, args);
		if (result.code !== 0) {
			throw new SourceError("unreadable", label(path), `${label(path)}: ${result.stderr.trim()}`);
		}
		return result.stdout;
	};
	// --literal-pathspecs, so that a `*` or `:` in a name is that character and nothing else.
	const lsTree = (path: string, pathspec: readonly string[]) =>
		run(path, ["--literal-pathspecs", "ls-tree", "-z", "-l", "--full-tree", sha, "--", ...pathspec]).then(parseTree);
	const entry = async (path: string) => (await lsTree(path, [path])).find((found) => found.path === path);
	return {
		label,
		async exists(path) {
			return path === "" ? "directory" : (await entry(path))?.kind;
		},
		async readText(path, maxBytes) {
			const found = await entry(path);
			if (found === undefined) return undefined;
			if (found.kind === "symlink") throw symlink(label(path));
			if (found.kind !== "file") throw new SourceError("unreadable", label(path), `${label(path)} is not a file`);
			if (found.size > maxBytes) throw tooLarge(label(path), found.size, maxBytes);
			return run(path, ["cat-file", "blob", found.object]);
		},
		async list(directory) {
			const kind = directory === "" ? "directory" : (await entry(directory))?.kind;
			if (kind === "symlink") throw symlink(label(directory));
			if (kind !== "directory") return undefined;
			const entries = await lsTree(directory, directory === "" ? [] : [`${directory}/`]);
			return entries.map((found) => ({ name: posix.basename(found.path), kind: found.kind }));
		},
	};
}
