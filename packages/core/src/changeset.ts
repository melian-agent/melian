import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { type ChangedFile, joinDiff, parseNumstatBinary, parsePatchHunks, parseRaw } from "./diff.ts";
import { ChangesetError } from "./errors.ts";
import { git, gitFailure, gitOutput, isNotARepository, requireGitVersion } from "./git.ts";
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

/**
 * One version of a changeset, identified by its head commit. Base and head are full commit hashes.
 *
 * `policyFiles` lists, sorted, every path in `files` that steers Melian itself: a `melian.yaml`, an `AGENTS.md` or
 * `CLAUDE.md`, or anything under a `.melian/` directory, at any depth, on either side of a rename. A review reads
 * policy from the base, so these changes are reviewed as code rather than obeyed; a lens can be handed them as quoted
 * data. A file such a standard imports with `@` is not listed, because only loading the standards reveals it.
 */
export interface Revision {
	readonly head: string;
	readonly base: string;
	readonly files: readonly ChangedFile[];
	readonly policyFiles: readonly string[];
}

/**
 * A branch range under review.
 *
 * `id` is unique within a repository and stable across revisions: it hashes the range's refs by full name, so new
 * commits on the head branch give a new revision of the same changeset. A side with no ref name, such as a detached
 * `HEAD` or a commit hash, is hashed by its commit, so every new commit there starts a new changeset.
 */
export interface RangeChangeset {
	readonly kind: "range";
	readonly id: string;
	readonly repoRoot: string;
	readonly spec: RangeSpec;
	readonly revision: Revision;
}

/** The unit under review. Only ranges exist so far; staged, working-tree, and pull request changesets join this union. */
export type Changeset = RangeChangeset;

/** Options for {@link resolveRange}. */
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
	const run = (format: string[]) =>
		gitOutput(repoRoot, [
			`--attr-source=${base}`,
			"-c",
			"diff.renames=true",
			"diff",
			...diffFlags,
			...format,
			base,
			head,
			"--",
		]);
	const [raw, numstat, patch] = await Promise.all([
		run(["--raw", "-z", "--no-abbrev"]),
		run(["--numstat", "-z"]),
		run(["--unified=0"]),
	]);
	return joinDiff(parseRaw(raw), parseNumstatBinary(numstat), parsePatchHunks(patch));
}

/**
 * Resolves a range in the repository containing `repoRoot` to a changeset with one revision.
 *
 * Shells out to `git`. Throws {@link ChangesetError}: `notARepository`, `invalidRange`, `unknownRef`, `noMergeBase`
 * when a three-dot range has unrelated sides, `dirtyWorktree` under `requireClean`, `gitTooOld` before git 2.40, and
 * `gitUnavailable` or `gitFailed` when git itself fails. Diff attributes come from the base commit, never from the
 * working tree.
 */
export async function resolveRange(
	repoRoot: string,
	range: string | RangeSpec,
	options: ResolveRangeOptions = {},
): Promise<RangeChangeset> {
	const spec = typeof range === "string" ? parseRangeSpec(range) : checkRange(range);
	const root = await repositoryRoot(repoRoot);
	await requireGitVersion(root);
	const [baseRef, head] = await Promise.all([commitOf(root, spec.base), commitOf(root, spec.head)]);
	const base = spec.mode === "threeDot" ? await mergeBase(root, spec, baseRef, head) : baseRef;
	if (options.requireClean) {
		const paths = await dirtyPaths(root);
		if (paths.length > 0) {
			throw new ChangesetError("dirtyWorktree", `the working tree has uncommitted changes in ${paths.join(", ")}`, {
				paths,
			});
		}
	}
	const names = await Promise.all([canonicalName(root, spec.base, baseRef), canonicalName(root, spec.head, head)]);
	const identity = ["range", spec.mode, ...names].join("\0");
	const files = await diff(root, base, head);
	const touched = files.flatMap((file) => (file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]));
	return {
		kind: "range",
		id: `range-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
		repoRoot: root,
		spec,
		revision: { head, base, files, policyFiles: [...new Set(touched.filter(isPolicyFile))].sort() },
	};
}
