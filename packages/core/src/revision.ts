import { posix } from "node:path";
import { OutsideRepositoryError, RevisionError } from "./errors.ts";
import { git } from "./git.ts";

/** What a path names at a revision. A submodule is a commit recorded in the tree, not a directory to read. */
export type RevisionEntryKind = "file" | "directory" | "symlink" | "submodule";

/** One tree entry at a revision. `path` is repository-relative with forward slashes; `size` is set for files. */
export interface RevisionEntry {
	readonly path: string;
	readonly kind: RevisionEntryKind;
	readonly size?: number;
}

/** A file's content at a revision. `truncated` is set when the file was longer than the byte limit. */
export interface RevisionFile {
	readonly path: string;
	readonly content: string;
	readonly size: number;
	readonly truncated: boolean;
}

/** One line matching a search, with its 1-based line number. `text` is cut at the line limit. */
export interface RevisionMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

/** What {@link searchRevision} looks for. */
export interface RevisionSearch {
	readonly pattern: string;
	/** Read `pattern` as a POSIX extended regular expression. Default: a fixed string. */
	readonly regex?: boolean;
	readonly ignoreCase?: boolean;
	/** Search only this file or directory. */
	readonly path?: string;
}

/** The bounds every revision read applies, so a model's tool call cannot pull an unbounded answer into its context. */
export const revisionLimits = {
	fileBytes: 256 * 1024,
	searchMatches: 200,
	matchChars: 300,
	listEntries: 1000,
} as const;

/**
 * Checks that `path` stays inside the repository and returns it normalised: forward slashes, no `.` segments, and no
 * leading or trailing slash. The repository root is the empty string. Throws {@link OutsideRepositoryError} for an
 * absolute path or one that climbs out with `..`.
 */
export function repositoryPath(path: string): string {
	const outside = new OutsideRepositoryError(path, "the repository root");
	if (path.includes("\0") || posix.isAbsolute(path)) throw outside;
	const normalised = posix.normalize(path === "" ? "." : path).replace(/\/+$/, "");
	if (normalised === ".." || normalised.startsWith("../")) throw outside;
	return normalised === "." ? "" : normalised;
}

// A revision from outside could otherwise be read as an option or carry a path of its own.
function checkRevision(revision: string): void {
	if (revision === "" || revision.startsWith("-") || /[\s:]/.test(revision)) {
		throw new RevisionError("invalidRevision", `"${revision}" is not a revision`);
	}
}

// `:(literal)` turns off pathspec magic and globbing, so a file named `*.ts` names only itself.
function pathspec(path: string, directory = false): string[] {
	if (path === "") return [];
	return [`:(literal)${path}${directory ? "/" : ""}`];
}

const kinds: Readonly<Record<string, RevisionEntryKind>> = { blob: "file", tree: "directory", commit: "submodule" };

// `git ls-tree -l -z` writes `<mode> <type> <object> <size>\t<path>`, NUL-terminated, the size padded with spaces.
function parseTree(output: string): (RevisionEntry & { object: string })[] {
	return output
		.split("\0")
		.filter((record) => record !== "")
		.map((record) => {
			const tab = record.indexOf("\t");
			const [mode, type, object, size] = record.slice(0, tab).split(/ +/);
			const kind = mode === "120000" ? "symlink" : (kinds[type!] ?? "file");
			const path = record.slice(tab + 1);
			return kind === "file" ? { path, kind, object: object!, size: Number(size) } : { path, kind, object: object! };
		});
}

async function lsTree(repoRoot: string, revision: string, args: readonly string[], maxBytes?: number) {
	const result = await git(repoRoot, ["ls-tree", "-z", "-l", "--full-tree", ...args], { maxBytes });
	if (result.code !== 0 && !result.truncated) {
		const unknown = /not a tree object|Not a valid object name/.test(result.stderr);
		throw new RevisionError(
			unknown ? "invalidRevision" : "gitFailed",
			unknown ? `${revision} does not name a commit` : `git ls-tree failed: ${result.stderr.trim()}`,
		);
	}
	// A cut output may end in a partial record.
	const output = result.truncated ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1) : result.stdout;
	return { entries: parseTree(output), truncated: result.truncated === true };
}

async function entryAt(repoRoot: string, revision: string, path: string) {
	if (path === "") return { path, kind: "directory" as const, object: revision };
	const { entries } = await lsTree(repoRoot, revision, [revision, "--", ...pathspec(path)]);
	const entry = entries.find((each) => each.path === path);
	if (entry === undefined) throw new RevisionError("notFound", `${path} does not exist at ${revision}`, { path });
	return entry;
}

/**
 * Reads a file as it is at `revision`, through git's object database rather than the working tree, so uncommitted
 * edits and untracked files are invisible. Content past `maxBytes` is cut and `truncated` set.
 *
 * Throws {@link OutsideRepositoryError} for a path outside the repository, and {@link RevisionError}: `notFound`,
 * `notAFile` for a directory or submodule, `symlink`, `binary` for content holding a NUL byte, and `invalidRevision`.
 */
export async function readRevisionFile(
	repoRoot: string,
	revision: string,
	path: string,
	maxBytes: number = revisionLimits.fileBytes,
): Promise<RevisionFile> {
	checkRevision(revision);
	const target = repositoryPath(path);
	const entry = await entryAt(repoRoot, revision, target);
	if (entry.kind === "symlink") throw new RevisionError("symlink", `${target} is a symbolic link`, { path: target });
	if (entry.kind !== "file")
		throw new RevisionError("notAFile", `${target || "."} is a ${entry.kind}`, { path: target });
	const result = await git(repoRoot, ["cat-file", "blob", entry.object], { maxBytes });
	if (result.code !== 0 && !result.truncated) {
		throw new RevisionError("gitFailed", `git cat-file failed: ${result.stderr.trim()}`, { path: target });
	}
	if (result.stdout.includes("\0")) throw new RevisionError("binary", `${target} is binary`, { path: target });
	return { path: target, content: result.stdout, size: entry.size ?? 0, truncated: result.truncated === true };
}

/**
 * Lists a directory as it is at `revision`: its direct entries, or every file beneath it when `recursive` is set. A
 * path naming a file lists that file alone. At most `maxEntries` entries are returned, with `truncated` set when more
 * exist. Throws as {@link readRevisionFile} does.
 */
export async function listRevisionFiles(
	repoRoot: string,
	revision: string,
	options: { readonly path?: string; readonly recursive?: boolean; readonly maxEntries?: number } = {},
): Promise<{ entries: RevisionEntry[]; truncated: boolean }> {
	checkRevision(revision);
	const target = repositoryPath(options.path ?? "");
	const maxEntries = options.maxEntries ?? revisionLimits.listEntries;
	const withoutObject = ({ object: _, ...entry }: RevisionEntry & { object: string }): RevisionEntry => entry;
	const entry = await entryAt(repoRoot, revision, target);
	if (entry.kind !== "directory") return { entries: [withoutObject(entry)], truncated: false };
	const recursive = options.recursive ? ["-r"] : [];
	// Room for each entry's mode, object, size, and a long path; the count below is the real bound.
	const args = [...recursive, revision, "--", ...pathspec(target, true)];
	const listed = await lsTree(repoRoot, revision, args, maxEntries * 1024);
	return {
		entries: listed.entries.slice(0, maxEntries).map(withoutObject),
		truncated: listed.truncated || listed.entries.length > maxEntries,
	};
}

/**
 * Searches the files at `revision` with `git grep`, skipping binary files. Returns at most `maxMatches` matching lines,
 * each cut at {@link revisionLimits} `matchChars`, with `truncated` set when more matched.
 *
 * Throws {@link RevisionError} `invalidPattern` for a regular expression git cannot compile, and as
 * {@link readRevisionFile} does for the path and revision.
 */
export async function searchRevision(
	repoRoot: string,
	revision: string,
	search: RevisionSearch,
	maxMatches: number = revisionLimits.searchMatches,
): Promise<{ matches: RevisionMatch[]; truncated: boolean }> {
	checkRevision(revision);
	const target = repositoryPath(search.path ?? "");
	const args = [
		// grep.column would add a column field to every match.
		"-c",
		"grep.column=false",
		"grep",
		"-z",
		"-n",
		"-I",
		"--no-color",
		"--full-name",
		search.regex ? "-E" : "-F",
		...(search.ignoreCase ? ["-i"] : []),
		"-e",
		search.pattern,
		revision,
		"--",
		...pathspec(target),
	];
	const result = await git(repoRoot, args, { maxBytes: maxMatches * (revisionLimits.matchChars + 1024) });
	if (result.code === 1 && result.stderr === "") return { matches: [], truncated: false };
	if (result.code !== 0 && !result.truncated) {
		const message = result.stderr.trim();
		if (/unable to resolve revision/.test(message)) {
			throw new RevisionError("invalidRevision", `${revision} does not name a commit`);
		}
		if (search.regex) {
			throw new RevisionError("invalidPattern", `"${search.pattern}" is not a valid regular expression: ${message}`);
		}
		throw new RevisionError("gitFailed", `git grep failed: ${message}`);
	}
	// Each match is `<revision>:<path>\0<line>\0<text>\n`; a cut output may end in a partial match.
	const records = result.stdout.split("\n");
	if (result.truncated || !result.stdout.endsWith("\n")) records.pop();
	const prefix = `${revision}:`;
	const matches = records
		.filter((record) => record !== "")
		.map((record) => {
			const [where, line, ...text] = record.split("\0");
			const path = where!.startsWith(prefix) ? where!.slice(prefix.length) : where!;
			return { path, line: Number(line), text: text.join("\0").slice(0, revisionLimits.matchChars) };
		});
	return {
		matches: matches.slice(0, maxMatches),
		truncated: result.truncated === true || matches.length > maxMatches,
	};
}
