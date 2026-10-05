import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { ChangeOverlap, CodeLocation, EvidenceSite } from "./cause.ts";
import { type ChangedFile, joinDiff, parseNumstatBinary, parsePatchHunks, parseRaw } from "./diff.ts";
import { ChangesetError, FindingError } from "./errors.ts";
import {
	type Cause,
	canonicalPath,
	type EvidenceRevision,
	type FindingTrigger,
	type LocationCause,
} from "./findings.ts";
import { git, gitFailure, gitOutput, gitOutputBytes, isNotARepository, requireGitVersion } from "./git.ts";
import { isPolicyFile } from "./paths.ts";

/**
 * How a range picks its base.
 *
 * - `twoDot`, written `a..b`: the base is `a` itself. The diff includes the reverse of anything `a` gained since `b`
 *   branched from it.
 * - `threeDot`, written `a...b`: the base is the merge base of `a` and `b`. The diff holds only what `b` added, which is
 *   what a pull request shows. This is the default.
 */
export type RangeMode = "twoDot" | "threeDot";

/** A parsed range, with each side as the user wrote it. */
export interface RangeSpec {
	readonly base: string;
	readonly head: string;
	readonly mode: RangeMode;
}

/** Options for {@link Changeset.resolve}. */
export interface ResolveRangeOptions {
	/** Throw `dirtyWorktree` when the working tree has uncommitted or untracked changes. */
	readonly requireClean?: boolean;
}

/**
 * Parses a range as the CLI accepts it.
 *
 * `a..b` and `a...b` keep git's meaning, and an empty side means `HEAD`. A single ref `a` means `a...HEAD`, the pull
 * request view of the current branch against `a`.
 */
export function parseRangeSpec(spec: string): RangeSpec {
	const threeDot = spec.indexOf("...");
	const twoDot = spec.indexOf("..");
	const [base, head, mode]: [string, string, RangeMode] =
		threeDot !== -1
			? [spec.slice(0, threeDot), spec.slice(threeDot + 3), "threeDot"]
			: twoDot !== -1
				? [spec.slice(0, twoDot), spec.slice(twoDot + 2), "twoDot"]
				: [spec, "HEAD", "threeDot"];
	if (spec === "" || (base === "" && head === "")) {
		throw new ChangesetError("invalidRange", `"${spec}" names no ref; write base..head, base...head, or base`, {
			ref: spec,
		});
	}
	return checkRange({ base: base || "HEAD", head: head || "HEAD", mode });
}

// Refuses anything git could read as an option or a second range before it reaches a git argument list.
function checkRange(spec: RangeSpec): RangeSpec {
	for (const side of [spec.base, spec.head]) {
		// `^ref` is a negation: rev-parse answers `^<sha>`, which is not a commit.
		if (side === "" || side.includes("..") || side.startsWith("-") || side.startsWith("^") || /\s/.test(side)) {
			throw new ChangesetError("invalidRange", `"${side}" is not a ref`, { ref: side });
		}
	}
	return spec;
}

async function repositoryRoot(path: string): Promise<string> {
	const notARepository = new ChangesetError("notARepository", `${path} is not inside a git working tree`);
	const info = await stat(path).catch(() => undefined);
	if (!info?.isDirectory()) throw notARepository;
	const args = ["rev-parse", "--show-toplevel"];
	const result = await git(path, args);
	// Only git's own words mean no repository. Dubious ownership or a broken config also fail here, and need saying.
	if (result.code !== 0) throw isNotARepository(result.stderr) ? notARepository : gitFailure(args, result);
	return result.stdout.trim();
}

// --quiet silences an unknown ref, so anything on stderr is a different failure.
async function commitOf(repoRoot: string, ref: string): Promise<string> {
	const args = ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
	const result = await git(repoRoot, args);
	if (result.code !== 0 && result.stderr.trim() === "") {
		throw new ChangesetError("unknownRef", `${ref} does not name a commit`, { ref });
	}
	if (result.code !== 0) throw gitFailure(args, result);
	return result.stdout.trim();
}

// Names a ref by its full name, such as refs/heads/main, so `main` and `heads/main` give one identity.
// A commit hash or an expression like HEAD~2 has no full name and stands for itself.
async function canonicalName(repoRoot: string, ref: string, commit: string): Promise<string> {
	const result = await git(repoRoot, ["rev-parse", "--symbolic-full-name", ref]);
	const name = result.stdout.trim();
	return result.code === 0 && name.startsWith("refs/") ? name : commit;
}

async function mergeBase(repoRoot: string, spec: RangeSpec, base: string, head: string): Promise<string> {
	const args = ["merge-base", base, head];
	const result = await git(repoRoot, args);
	// git exits 1 without a word when the sides share no history, and 128 with a message for anything else.
	if (result.code === 1 && result.stderr.trim() === "") {
		throw new ChangesetError("noMergeBase", `${spec.base} and ${spec.head} share no history`, {
			ref: `${spec.base}...${spec.head}`,
		});
	}
	if (result.code !== 0) throw gitFailure(args, result);
	return result.stdout.trim();
}

async function dirtyPaths(repoRoot: string): Promise<string[]> {
	const output = await gitOutput(repoRoot, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=normal",
		"--ignore-submodules=none",
	]);
	const paths: string[] = [];
	const fields = output.split("\0");
	for (let i = 0; i < fields.length && fields[i] !== ""; i++) {
		paths.push(fields[i]!.slice(3));
		// A rename or copy, in the index or the working tree, is followed by its source path in a field of its own.
		if (/^(?:[RC].|.[RC])/.test(fields[i]!)) i++;
	}
	return paths;
}

// Pinned so that hunk boundaries do not depend on each user's diff configuration.
const diffFlags = [
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--no-relative",
	"--find-renames",
	// git's default; a lower diff.renameLimit turns an edited rename into a deletion and an addition.
	"-l1000",
	"--diff-algorithm=myers",
	"--indent-heuristic",
	"--inter-hunk-context=0",
	"--submodule=short",
	// Overrides diff.ignoreSubmodules and the ignore setting in .gitmodules, which a head commit controls.
	"--ignore-submodules=none",
	// Cancels diff.orderFile, so files come in git's path order.
	"-O/dev/null",
];

async function diff(repoRoot: string, base: string, head: string): Promise<ChangedFile[]> {
	// diff.renames=copies would report copies, whose hunks are against the copy's source.
	// The working tree's .gitattributes belong to whatever is checked out, often the head; `*.ts -diff` there would
	// turn the head's own changes into a binary file with no hunks.
	const args = (format: string[]) => [
		`--attr-source=${base}`,
		"-c",
		"diff.renames=true",
		"diff",
		...diffFlags,
		...format,
		base,
		head,
		"--",
	];
	// Paths come from the raw view as bytes; the other two views only need counting.
	const [raw, numstat, patch] = await Promise.all([
		gitOutputBytes(repoRoot, args(["--raw", "-z", "--no-abbrev"])),
		gitOutput(repoRoot, args(["--numstat", "-z"])),
		gitOutput(repoRoot, args(["--unified=0"])),
	]);
	return joinDiff(parseRaw(raw), parseNumstatBinary(numstat), parsePatchHunks(patch));
}

/**
 * The changeset ID of a pull request reviewed as one: a hash of the kind, the provider, the repository, and the number,
 * so every push to the pull request is a new revision of one changeset. A range hashes its kind too, so a range that
 * names the refs a host fetched for a pull request never shares the pull request's ID, and so never its storage.
 */
export function pullRequestChangesetId(
	provider: string,
	repository: { readonly owner: string; readonly name: string },
	number: number,
): string {
	const identity = ["pull-request", provider, repository.owner.toLowerCase(), repository.name.toLowerCase(), number];
	return `pull-${createHash("sha256").update(identity.join("\0")).digest("hex").slice(0, 16)}`;
}

function onlyMoved(file: ChangedFile): boolean {
	return file.status === "renamed" && file.hunks.length === 0;
}

function overlaps(start: number, end: number, from: number, count: number): boolean {
	return count > 0 && start < from + count && end >= from;
}

/** A {@link Revision} as JSON. */
export interface RevisionFields {
	readonly head: string;
	readonly base: string;
	readonly files: readonly ChangedFile[];
	readonly policyFiles: readonly string[];
}

/** A {@link Changeset} as JSON. */
export interface ChangesetFields {
	readonly kind: "range";
	readonly id: string;
	readonly repoRoot: string;
	readonly spec: RangeSpec;
	readonly revision: RevisionFields;
}

/**
 * One version of a changeset, identified by its head commit. Base and head are full commit hashes.
 *
 * `policyFiles` lists, sorted, every path in `files` that steers Melian itself: a `melian.yaml`, an `AGENTS.md` or
 * `CLAUDE.md`, anything under a `.melian/` directory, or a static tool's configuration such as `biome.json`,
 * `tsconfig*.json`, or `package.json`, at any depth, on either side of a rename. A review reads
 * policy from the base, so these changes are reviewed as code rather than obeyed; a lens can be handed them as quoted
 * data. A file such a standard imports with `@` is not listed, because only loading the standards reveals it.
 */
export class Revision {
	readonly head: string;
	readonly base: string;
	readonly files: readonly ChangedFile[];
	readonly policyFiles: readonly string[];

	private constructor(fields: RevisionFields) {
		this.head = fields.head;
		this.base = fields.base;
		this.files = fields.files;
		this.policyFiles = fields.policyFiles;
	}

	/**
	 * The revision from `base` to `head` that changes `files`. Its policy files are the ones given, as a stored revision
	 * holds them, or else derived from `files`.
	 */
	static from(fields: Omit<RevisionFields, "policyFiles"> & { readonly policyFiles?: readonly string[] }): Revision {
		const policyFiles =
			fields.policyFiles ?? [...new Set(Revision.#touched(fields.files).filter(isPolicyFile))].sort();
		return new Revision({ head: fields.head, base: fields.base, files: fields.files, policyFiles });
	}

	static #touched(files: readonly ChangedFile[]): string[] {
		return files.flatMap((file) => (file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]));
	}

	/** Every path the revision changes, a renamed file by its old path and its new one, in diff order. */
	paths(): string[] {
		return Revision.#touched(this.files);
	}

	/**
	 * The lines the revision adds or changes, by repository-relative path: inclusive `[first, last]` ranges at head, in
	 * line order. Deleted, binary, and percent-encoded files have none. Only these lines take an inline comment that is
	 * sure to land.
	 */
	diffLines(): Record<string, [number, number][]> {
		const lines: Record<string, [number, number][]> = {};
		for (const file of this.files) {
			if (file.status === "deleted" || file.binary || file.percentEncoded) continue;
			const ranges = file.hunks
				.filter((hunk) => hunk.newLines > 0)
				.map((hunk): [number, number] => [hunk.newStart, hunk.newStart + hunk.newLines - 1]);
			if (ranges.length > 0) lines[file.path] = ranges;
		}
		return lines;
	}

	/**
	 * The hunk that introduced lines `startLine` to `endLine` of `path` at head, as a finding's trigger names it, with
	 * its added lines as the snippet; `undefined` when no hunk adds any of them.
	 */
	trigger(path: string, startLine: number, endLine: number): FindingTrigger | undefined {
		const file = this.files.find((each) => each.path === path);
		const hunk = file?.hunks.find(
			(each) => each.newLines > 0 && startLine < each.newStart + each.newLines && endLine >= each.newStart,
		);
		if (hunk === undefined) return undefined;
		const added = hunk.text
			.split("\n")
			.filter((row) => row.startsWith("+"))
			.map((row) => row.slice(1))
			.join("\n");
		return { file: path, index: hunk.index, snippet: added };
	}

	/** The revision as JSON, as a durable task's input holds it. */
	toJSON(): RevisionFields {
		const { head, base, files, policyFiles } = this;
		return { head, base, files, policyFiles };
	}

	/**
	 * The part of the change a location falls on, whatever its role, or `undefined` when it falls on nothing the change
	 * did. At head: a hunk's new lines in a file the change keeps. At the base: a hunk's old lines in a file the base
	 * had, named by its base path, so deleted lines count as changed code. On either side, any line of a file the change
	 * renamed without editing, named by its path on that side, since the rename is what the change did to it, unless
	 * `findingFile`, the head path of the finding the location supports, is itself a file the change only moved: moving
	 * files changes none of their lines, so no rename proves anything about a defect inside one, its own or a sibling's.
	 * Compares canonical paths; throws `FindingError` `invalidPath` for a path that is not repository-relative.
	 */
	changeOverlap(
		location: CodeLocation & { readonly revision?: EvidenceRevision },
		findingFile?: string,
	): ChangeOverlap | undefined {
		const path = canonicalPath(location.file, "/evidence/file");
		const end = location.endLine ?? location.startLine;
		const base = location.revision === "base";
		const changed = this.files.find((file) =>
			base
				? (file.oldPath ?? file.path) === path && file.status !== "added"
				: file.path === path && file.status !== "deleted",
		);
		if (changed === undefined) return undefined;
		if (onlyMoved(changed)) {
			const findingPath = findingFile === undefined ? undefined : canonicalPath(findingFile, "/file");
			const findingMoved = this.files.some((file) => file.path === findingPath && onlyMoved(file));
			return findingMoved ? undefined : { kind: "rename", file: changed };
		}
		const hunk = changed.hunks.find((each) =>
			base
				? overlaps(location.startLine, end, each.oldStart, each.oldLines)
				: overlaps(location.startLine, end, each.newStart, each.newLines),
		);
		return hunk === undefined ? undefined : { kind: "hunk", hunk };
	}

	/**
	 * The part of the change a piece of evidence proves caused a finding in `findingFile`, by
	 * {@link Revision.changeOverlap}, or `undefined` when it proves nothing. Only a `cause` location proves anything; a
	 * `context` location never does.
	 */
	causeOverlap(site: EvidenceSite, findingFile?: string): ChangeOverlap | undefined {
		canonicalPath(site.file, "/evidence/file");
		return site.role === "cause" ? this.changeOverlap(site, findingFile) : undefined;
	}

	/**
	 * Classifies a finding's cause by where it sits and, given its evidence, by what that evidence proves.
	 *
	 * Location proves `introduced` only: a location in an added file, binary files included, or overlapping any hunk's
	 * new lines is `introduced`. Any other location is `affected` when one of `evidence`'s locations proves the change
	 * caused it, by {@link Revision.causeOverlap}, and `pre-existing` otherwise, including code beside or around a pure
	 * deletion, which has no new lines, and code in a file the change only renamed, whatever renamed file its evidence
	 * cites. A file deleted at head has no lines to point at, so a location in one throws `FindingError` `deletedFile`.
	 * Compares canonical paths, so `./src/run.ts` is `src/run.ts`; throws `FindingError` `invalidPath` for a path that is
	 * absolute, escapes the repository, or uses a backslash.
	 */
	classifyCause(location: CodeLocation): LocationCause;
	classifyCause(location: CodeLocation, evidence: readonly EvidenceSite[]): Cause;
	classifyCause(location: CodeLocation, evidence: readonly EvidenceSite[] = []): Cause {
		const located = this.#causeByLocation(location);
		if (located === "introduced") return located;
		return evidence.some((site) => this.causeOverlap(site, location.file) !== undefined)
			? "affected"
			: "pre-existing";
	}

	#causeByLocation(location: CodeLocation): LocationCause {
		const path = canonicalPath(location.file, "/file");
		const changed = this.files.find((file) => file.path === path);
		if (changed === undefined) return "pre-existing";
		if (changed.status === "deleted") {
			throw new FindingError("deletedFile", `${path} is deleted at head, so no finding can point into it`, {
				path: "/file",
			});
		}
		if (changed.status === "added") return "introduced";
		const end = location.endLine ?? location.startLine;
		return changed.hunks.some((hunk) => overlaps(location.startLine, end, hunk.newStart, hunk.newLines))
			? "introduced"
			: "pre-existing";
	}
}

/**
 * A branch range under review.
 *
 * `id` is unique within a repository and stable across revisions: it hashes the range's refs by full name, so new
 * commits on the head branch give a new revision of the same changeset. A side with no ref name, such as a detached
 * `HEAD` or a commit hash, is hashed by its commit, so every new commit there starts a new changeset. Only ranges exist
 * so far; staged, working-tree, and pull request changesets join as other kinds.
 */
export class Changeset {
	readonly kind: "range";
	readonly id: string;
	readonly repoRoot: string;
	readonly spec: RangeSpec;
	readonly revision: Revision;

	private constructor(fields: Omit<ChangesetFields, "revision"> & { readonly revision: Revision }) {
		this.kind = fields.kind;
		this.id = fields.id;
		this.repoRoot = fields.repoRoot;
		this.spec = fields.spec;
		this.revision = fields.revision;
	}

	/** The changeset a stored one describes, as a durable task's input holds it. */
	static from(fields: ChangesetFields): Changeset {
		return new Changeset({ ...fields, revision: Revision.from(fields.revision) });
	}

	/**
	 * Resolves a range in the repository containing `repoRoot` to a changeset with one revision.
	 *
	 * Shells out to `git`. Throws {@link ChangesetError}: `notARepository`, `invalidRange`, `unknownRef`, `noMergeBase`
	 * when a three-dot range has unrelated sides, `dirtyWorktree` under `requireClean`, `gitTooOld` before git 2.40, and
	 * `gitUnavailable` or `gitFailed` when git itself fails. Diff attributes come from the base commit, never from the
	 * working tree.
	 */
	static async resolve(
		repoRoot: string,
		range: string | RangeSpec,
		options: ResolveRangeOptions = {},
	): Promise<Changeset> {
		const spec = typeof range === "string" ? parseRangeSpec(range) : checkRange(range);
		const root = await repositoryRoot(repoRoot);
		await requireGitVersion(root);
		const [baseRef, head] = await Promise.all([commitOf(root, spec.base), commitOf(root, spec.head)]);
		const base = spec.mode === "threeDot" ? await mergeBase(root, spec, baseRef, head) : baseRef;
		if (options.requireClean) {
			const paths = await dirtyPaths(root);
			if (paths.length > 0) {
				throw new ChangesetError(
					"dirtyWorktree",
					`the working tree has uncommitted changes in ${paths.join(", ")}`,
					{
						paths,
					},
				);
			}
		}
		const names = await Promise.all([canonicalName(root, spec.base, baseRef), canonicalName(root, spec.head, head)]);
		const identity = ["range", spec.mode, ...names].join("\0");
		const files = await diff(root, base, head);
		return new Changeset({
			kind: "range",
			id: `range-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
			repoRoot: root,
			spec,
			revision: Revision.from({ head, base, files }),
		});
	}

	/** The same range under another changeset ID, such as a pull request's from `pullRequestChangesetId`. */
	withId(id: string): Changeset {
		return new Changeset({ ...this, id });
	}

	/** The changeset as JSON, as a durable task's input holds it. */
	toJSON(): ChangesetFields {
		const { kind, id, repoRoot, spec } = this;
		return { kind, id, repoRoot, spec, revision: this.revision.toJSON() };
	}
}
