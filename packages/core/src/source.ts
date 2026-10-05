import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { git, isNotARepository } from "./git.ts";

/**
 * Where policy (`melian.yaml`) and standards are read from. The host chooses, because only the host knows who wrote
 * what: for a pull request it passes the base commit, so a head cannot rewrite the policy or prompts of its own review;
 * for a maintainer's local run it may pass the working tree. Core never decides trust, and one load never mixes sources.
 * A working tree may name `preferences`, the user-level preference file, by absolute path, which `loadConfig` layers
 * under `melian.local.yaml`; a revision never reads one.
 */
export type RepositorySource =
	| { readonly kind: "revision"; readonly commit: string }
	| { readonly kind: "worktree"; readonly preferences?: string };

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
	readonly size?: number;

	constructor(code: SourceErrorCode, path: string, message: string, options: { cause?: unknown; size?: number } = {}) {
		super(message, { cause: options.cause });
		this.name = "SourceError";
		this.code = code;
		this.path = path;
		if (options.size !== undefined) this.size = options.size;
	}
}

// Paths are repository-relative with forward slashes, "" for the root, and already checked to stay inside it.
// Neither implementation follows a symlink: a symlink is refused with `symlink`, and a path beneath a symlinked
// directory does not exist, as in git's own trees.
export interface SourceReader {
	readonly commit?: string;
	// Names a file for messages: the path for the working tree, git's `<commit>:<path>` for a revision.
	label(path: string): string;
	isIgnored(path: string): Promise<boolean>;
	// Undefined when the path does not exist. Throws `symlink`, `tooLarge` past `maxBytes`, or `unreadable`.
	readText(path: string, maxBytes: number): Promise<string | undefined>;
	// Undefined when the directory does not exist. Throws `symlink` for a symlinked directory.
	list(directory: string): Promise<readonly Entry[] | undefined>;
	exists(path: string): Promise<EntryKind | undefined>;
	// Every file or symlink path in the source that `pattern` matches, from one listing of the whole tree.
	findPaths(pattern: RegExp): Promise<string[]>;
}

// Splits `-z` output into paths; a path may hold a newline but never a NUL.
function nulSeparated(output: string): string[] {
	return output.split("\0").filter((path) => path !== "");
}

export async function openSource(repoRoot: string, source: RepositorySource): Promise<SourceReader> {
	if (!(await stat(repoRoot).catch(() => undefined))?.isDirectory()) {
		throw new SourceError("missingRoot", repoRoot, `${repoRoot} is not a directory`);
	}
	return source.kind === "worktree" ? new WorktreeSource(repoRoot) : RevisionSource.open(repoRoot, source.commit);
}

function tooLarge(label: string, size: number, maxBytes: number): SourceError {
	return new SourceError("tooLarge", label, `${label} is ${size} bytes; the limit is ${maxBytes}`, { size });
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

function unreadable(path: string): (cause: NodeJS.ErrnoException) => never {
	return (cause) => {
		throw new SourceError("unreadable", path, `${path}: ${cause.message}`, { cause });
	};
}

class WorktreeSource implements SourceReader {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	label(path: string): string {
		return path;
	}

	async isIgnored(path: string): Promise<boolean> {
		const result = await git(this.root, ["check-ignore", "--no-index", "--quiet", "--", path]);
		if (result.code > 1 || result.code < 0)
			throw new SourceError("unreadable", path, `${path}: ${result.stderr.trim()}`);
		return result.code === 0;
	}

	// lstat each component, so that a symlinked directory partway down hides what lies beneath it.
	async exists(path: string): Promise<EntryKind | undefined> {
		if (path === "") return "directory";
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const stats = await lstat(join(this.root, prefix)).catch((error: NodeJS.ErrnoException) =>
				isAbsence(error) ? undefined : unreadable(prefix)(error),
			);
			if (stats === undefined) return undefined;
			const kind = kindOfStats(stats);
			if (i === parts.length) return kind;
			if (kind !== "directory") return undefined;
		}
		return undefined;
	}

	async readText(path: string, maxBytes: number): Promise<string | undefined> {
		const kind = await this.exists(path);
		if (kind === undefined) return undefined;
		if (kind === "symlink") throw symlink(path);
		if (kind !== "file") throw new SourceError("unreadable", path, `${path} is not a file`);
		// O_NOFOLLOW refuses a symlink swapped in after the lstat above.
		const handle = await open(join(this.root, path), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
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
	}

	async list(directory: string): Promise<readonly Entry[] | undefined> {
		const kind = await this.exists(directory);
		if (kind === "symlink") throw symlink(directory);
		if (kind !== "directory") return undefined;
		const entries = await readdir(join(this.root, directory), { withFileTypes: true }).catch(unreadable(directory));
		return entries.map((entry) => ({ name: entry.name, kind: kindOfStats(entry) }));
	}

	// Tracked and untracked files git does not ignore, so an uncommitted lens counts and node_modules is not walked.
	async findPaths(pattern: RegExp): Promise<string[]> {
		const result = await git(this.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
		if (result.code !== 0) throw new SourceError("unreadable", this.root, `${this.root}: ${result.stderr.trim()}`);
		return [...new Set(nulSeparated(result.stdout))].filter((path) => pattern.test(path));
	}
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

class RevisionSource implements SourceReader {
	readonly repoRoot: string;
	readonly sha: string;

	private constructor(repoRoot: string, sha: string) {
		this.repoRoot = repoRoot;
		this.sha = sha;
	}

	get commit(): string {
		return this.sha;
	}

	static async open(repoRoot: string, commit: string): Promise<RevisionSource> {
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
		return new RevisionSource(repoRoot, resolved.stdout.trim());
	}

	label(path: string): string {
		return `${this.sha.slice(0, 12)}:${path}`;
	}

	async isIgnored(path: string): Promise<boolean> {
		const directory = await mkdtemp(join(tmpdir(), "melian-standards-ignore-"));
		try {
			const parts = path.split("/");
			for (let i = 0; i < parts.length; i++) {
				const ignore = posix.join(...parts.slice(0, i), ".gitignore");
				const content = await this.readText(ignore, 256 * 1024).catch((error: unknown) => {
					if (error instanceof SourceError && error.code === "symlink") return undefined;
					throw error;
				});
				if (content === undefined) continue;
				const target = join(directory, ignore);
				await mkdir(posix.dirname(target), { recursive: true });
				await writeFile(target, content);
			}
			const result = await git(this.repoRoot, [
				"--work-tree",
				directory,
				"check-ignore",
				"--no-index",
				"--quiet",
				"--",
				path,
			]);
			if (result.code > 1 || result.code < 0)
				throw new SourceError("unreadable", this.label(path), `${this.label(path)}: ${result.stderr.trim()}`);
			return result.code === 0;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	async exists(path: string): Promise<EntryKind | undefined> {
		return path === "" ? "directory" : (await this.entry(path))?.kind;
	}

	async readText(path: string, maxBytes: number): Promise<string | undefined> {
		const found = await this.entry(path);
		if (found === undefined) return undefined;
		const label = this.label(path);
		if (found.kind === "symlink") throw symlink(label);
		if (found.kind !== "file") throw new SourceError("unreadable", label, `${label} is not a file`);
		if (found.size > maxBytes) throw tooLarge(label, found.size, maxBytes);
		return this.run(path, ["cat-file", "blob", found.object]);
	}

	async list(directory: string): Promise<readonly Entry[] | undefined> {
		const kind = directory === "" ? "directory" : (await this.entry(directory))?.kind;
		if (kind === "symlink") throw symlink(this.label(directory));
		if (kind !== "directory") return undefined;
		const entries = await this.lsTree(directory, directory === "" ? [] : [`${directory}/`]);
		return entries.map((found) => ({ name: posix.basename(found.path), kind: found.kind }));
	}

	async findPaths(pattern: RegExp): Promise<string[]> {
		const output = await this.run("", ["ls-tree", "-r", "-z", "--name-only", "--full-tree", this.sha]);
		return nulSeparated(output).filter((path) => pattern.test(path));
	}

	private async run(path: string, args: readonly string[]): Promise<string> {
		const result = await git(this.repoRoot, args);
		if (result.code !== 0) {
			const label = this.label(path);
			throw new SourceError("unreadable", label, `${label}: ${result.stderr.trim()}`);
		}
		return result.stdout;
	}

	// --literal-pathspecs, so that a `*` or `:` in a name is that character and nothing else.
	private async lsTree(path: string, pathspec: readonly string[]): Promise<TreeEntry[]> {
		const args = ["--literal-pathspecs", "ls-tree", "-z", "-l", "--full-tree", this.sha, "--", ...pathspec];
		return parseTree(await this.run(path, args));
	}

	private async entry(path: string): Promise<TreeEntry | undefined> {
		return (await this.lsTree(path, [path])).find((found) => found.path === path);
	}
}
