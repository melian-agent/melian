import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { ChangeOverlap, CodeLocation, EvidenceSite } from "./cause.ts";
import { type FileUnit, type LinesByPath, type UnitField, type UnitKind, unionRanges } from "./coverage-units.ts";
import { type ChangedFile, joinDiff, parseNumstatBinary, parsePatchHunks, parseRaw } from "./diff.ts";
import { ChangesetError, FindingError } from "./errors.ts";
import {
	type Cause,
	canonicalPath,
	type EvidenceRevision,
	type Finding,
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

function submodule(file: ChangedFile): boolean {
	return file.oldKind === "submodule" || file.newKind === "submodule";
}

function onlyMoved(file: ChangedFile): boolean {
	return file.status === "renamed" && file.hunks.length === 0;
}

function overlaps(start: number, end: number, from: number, count: number): boolean {
	return count > 0 && start < from + count && end >= from;
}

/** What a round of review covers of a revision. The one scope today is the whole diff. */
export type RevisionScope = "diff";

/** The two commits a revision runs between, as a stored record names them. */
export interface RevisionSides {
	readonly base: string;
	readonly head: string;
}

/** A revision key read back by {@link Revision.parseKey}. */
export interface RevisionKeyParts extends RevisionSides {
	readonly scope: RevisionScope;
}

const scopes: readonly string[] = ["diff"] satisfies readonly RevisionScope[];

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

	/**
	 * The key every document stores a reviewed revision under, and the one place a key is built: `<base>..<head>` for
	 * the whole diff. A pull request retargeted onto a new base keeps its head but has another diff, so it is another
	 * revision, reviewed afresh. Throws `ChangesetError` `unknownScope` for a scope it does not know, so a stored or
	 * typed-around scope never makes a key of its own.
	 */
	static key(sides: RevisionSides, scope: RevisionScope = "diff"): string {
		if (!scopes.includes(scope)) {
			throw new ChangesetError(
				"unknownScope",
				`a revision key has no scope "${String(scope)}"; the one scope is "diff"`,
			);
		}
		return [sides.base, sides.head].join("..");
	}

	/** The sides and scope of a key {@link Revision.key} built, or `undefined` for text that is not one. */
	static parseKey(key: string): RevisionKeyParts | undefined {
		const sides = key.split("..");
		if (sides.length !== 2 || sides.some((side) => side === "" || side.startsWith("."))) return undefined;
		return { base: sides[0]!, head: sides[1]!, scope: "diff" };
	}

	/** A revision for a reader: each side cut to its first twelve characters, as `<base>..<head>`. */
	static display(sides: RevisionSides): string {
		return Revision.key({ base: sides.base.slice(0, 12), head: sides.head.slice(0, 12) });
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
	 * The lines the revision adds, by head path, and the lines it removes from the base, by base path, as coverage counts
	 * them: a renamed file's removed lines sit under its old path. A binary file and a submodule pointer have none, since
	 * no lens tool reads either; they are file units.
	 */
	changedLines(): { readonly head: LinesByPath; readonly base: LinesByPath } {
		const head: LinesByPath = {};
		const base: LinesByPath = {};
		for (const file of this.files) {
			if (file.binary || submodule(file)) continue;
			const added = file.hunks
				.filter((hunk) => hunk.newLines > 0)
				.map((hunk): [number, number] => [hunk.newStart, hunk.newStart + hunk.newLines - 1]);
			const removed = file.hunks
				.filter((hunk) => hunk.oldLines > 0)
				.map((hunk): [number, number] => [hunk.oldStart, hunk.oldStart + hunk.oldLines - 1]);
			if (added.length > 0) head[file.path] = unionRanges(added, []);
			if (removed.length > 0) base[file.oldPath ?? file.path] = unionRanges(removed, []);
		}
		return { head, base };
	}

	/**
	 * Every changed file whose change lines cannot describe, as a coverage unit of its own: a file with no hunks, such as
	 * a binary update, a mode-only change, an empty file added or deleted, or a pure rename; every submodule pointer,
	 * whatever its hunks say; and a file whose mode or kind changes beside its hunks. A unit is keyed by its head path, or its base path when deleted,
	 * and lists every field a lens must receive: those its `ChangedFile` holds, a symlink's target and an empty file's
	 * emptiness.
	 */
	fileUnits(): FileUnit[] {
		return this.files.flatMap((file): FileUnit[] => {
			const modeChanged = file.oldMode !== undefined && file.newMode !== undefined && file.oldMode !== file.newMode;
			if (file.hunks.length > 0 && !modeChanged && !submodule(file)) return [];
			const kind: UnitKind = file.binary
				? "binary"
				: submodule(file)
					? "submodule"
					: file.oldKind === "symlink" || file.newKind === "symlink"
						? "symlink"
						: file.status === "added" || file.status === "deleted"
							? "empty"
							: file.status === "renamed" && !modeChanged
								? "rename"
								: "mode";
			const present: Record<UnitField, boolean> = {
				status: true,
				path: true,
				oldPath: file.oldPath !== undefined,
				oldMode: file.oldMode !== undefined,
				newMode: file.newMode !== undefined,
				oldKind: file.oldKind !== undefined,
				newKind: file.newKind !== undefined,
				binary: true,
				target: file.newKind === "symlink",
				empty: kind === "empty",
			};
			const fields = (Object.keys(present) as UnitField[]).filter((field) => present[field]);
			return [{ path: file.path, ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }), kind, fields }];
		});
	}

	/**
	 * Where line `line` of `path` at this revision's base sits at its head, read as a map between two heads of one
	 * changeset: moved by the hunks before it and renamed with its file. `undefined` when a hunk's old range holds the
	 * line or the file is deleted or binary, since nothing then says the line is the same line.
	 */
	mapLine(path: string, line: number): { readonly path: string; readonly line: number } | undefined {
		const file = this.files.find((each) => (each.oldPath ?? each.path) === path && each.status !== "added");
		if (file === undefined) return { path, line };
		if (file.status === "deleted" || file.binary) return undefined;
		let shift = 0;
		for (const hunk of file.hunks) {
			const last = hunk.oldStart + hunk.oldLines - 1;
			if (hunk.oldLines > 0 && line >= hunk.oldStart && line <= last) return undefined;
			if (hunk.oldLines > 0 ? last < line : hunk.oldStart < line) shift += hunk.newLines - hunk.oldLines;
		}
		return { path: file.path, line: line + shift };
	}

	/**
	 * Where lines `first` to `last` of `path` at this revision's base sit at its head, read as a move between two heads:
	 * moved by the hunks before them, or, when a hunk changed them, at the first new line after that hunk, which is
	 * changed, never gone. `undefined` for a file the move deleted or made binary, where no line stands for it.
	 */
	moveLines(
		path: string,
		first: number,
		last: number,
	): { readonly path: string; readonly first: number; readonly last: number; readonly changed: boolean } | undefined {
		const file = this.files.find((each) => (each.oldPath ?? each.path) === path && each.status !== "added");
		if (file === undefined) return { path, first, last, changed: false };
		if (file.status === "deleted" || file.binary) return undefined;
		const start = this.mapLine(path, first);
		const end = this.mapLine(path, last);
		const touching = (hunk: (typeof file.hunks)[number]) =>
			hunk.oldLines > 0
				? hunk.oldStart <= last && hunk.oldStart + hunk.oldLines - 1 >= first
				: hunk.oldStart >= first && hunk.oldStart < last;
		const hunk = file.hunks.find(touching);
		if (start !== undefined && end !== undefined && hunk === undefined)
			return { path: start.path, first: start.line, last: end.line, changed: false };
		const line =
			hunk === undefined
				? (start?.line ?? first)
				: hunk.newLines > 0
					? hunk.newStart + hunk.newLines
					: hunk.newStart + 1;
		return { path: file.path, first: line, last: line, changed: true };
	}

	/** Whether the revision lists `path` at all, under its old path or its new one. */ /** Whether the revision lists `path` at all, under its old path or its new one. */
	lists(path: string): boolean {
		return this.files.some((file) => file.path === path || file.oldPath === path);
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
	 * The changed files `findings` name, by their own path or any evidence location's, head or base, with each hunk's
	 * ranges and no text: what the merge reads, small enough for a stored task input to hold.
	 */
	outline(findings: readonly Finding[]): ChangedFile[] {
		const paths = new Set<string | undefined>(
			findings.flatMap((finding) => [
				finding.properties.path,
				...[...finding.claims(), ...(finding.properties.otherClaims ?? [])].flatMap((claim) =>
					(claim.evidence ?? []).map((location) => location.file),
				),
			]),
		);
		return this.files
			.filter((file) => paths.has(file.path) || paths.has(file.oldPath))
			.map((file) => ({ ...file, hunks: file.hunks.map((hunk) => ({ ...hunk, header: "", text: "" })) }));
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
		return this.changeOverlaps(location, findingFile)[0];
	}

	/** Every part of the change a location falls on, as {@link Revision.changeOverlap} reads each, in diff order. */
	changeOverlaps(
		location: CodeLocation & { readonly revision?: EvidenceRevision },
		findingFile?: string,
	): ChangeOverlap[] {
		const path = canonicalPath(location.file, "/evidence/file");
		const end = location.endLine ?? location.startLine;
		const base = location.revision === "base";
		const changed = this.files.find((file) =>
			base
				? (file.oldPath ?? file.path) === path && file.status !== "added"
				: file.path === path && file.status !== "deleted",
		);
		if (changed === undefined) return [];
		if (onlyMoved(changed)) {
			const findingPath = findingFile === undefined ? undefined : canonicalPath(findingFile, "/file");
			const findingMoved = this.files.some((file) => file.path === findingPath && onlyMoved(file));
			return findingMoved ? [] : [{ kind: "rename", file: changed }];
		}
		return changed.hunks
			.filter((each) =>
				base
					? overlaps(location.startLine, end, each.oldStart, each.oldLines)
					: overlaps(location.startLine, end, each.newStart, each.newLines),
			)
			.map((hunk): ChangeOverlap => ({ kind: "hunk", hunk }));
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

/** How a head moved from an earlier round's head: along its history, or in a way no line map can follow. */
export class HeadMove {
	readonly kind: "moved" | "unresolved" | "rewritten" | "merged";
	readonly revision?: Revision;

	private constructor(kind: HeadMove["kind"], revision?: Revision) {
		this.kind = kind;
		if (revision !== undefined) this.revision = revision;
	}

	/**
	 * Reads how `to` descends from `from` in the repository at `repoRoot`: `unresolved` when git cannot resolve `from`
	 * as a commit, or cannot run there at all, `rewritten` when `from` is not an ancestor of `to`, as after a force push or a rebase, `merged` when
	 * a merge commit sits between them, and otherwise `moved`, with the diff between the two heads under the review's
	 * own diff flags and rename detection.
	 */
	static async read(repoRoot: string, from: string, to: string): Promise<HeadMove> {
		// A git that cannot start or a checkout that is gone resolves nothing, which voids as an unknown head does.
		const resolved = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${from}^{commit}`]).catch(
			() => undefined,
		);
		if (resolved?.code !== 0) return new HeadMove("unresolved");
		const ancestor = await git(repoRoot, ["merge-base", "--is-ancestor", from, to]);
		if (ancestor.code !== 0) return new HeadMove("rewritten");
		const merges = await gitOutput(repoRoot, ["rev-list", "--merges", `^${from}`, to]);
		if (merges.trim() !== "") return new HeadMove("merged");
		const root = await repositoryRoot(repoRoot);
		return new HeadMove("moved", Revision.from({ base: from, head: to, files: await diff(root, from, to) }));
	}

	/** Why coverage from round `since` did not carry, for a move that is not along the history. */
	reason(since: string): string {
		switch (this.kind) {
			case "unresolved":
				return `${since}'s head cannot be resolved`;
			case "rewritten":
				return `${since}'s head is not an ancestor of this head, so the branch was rewritten`;
			case "merged":
				return `a merge commit sits between ${since}'s head and this head`;
			default:
				return `the head moved along its history since ${since}`;
		}
	}
}
