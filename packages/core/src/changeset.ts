import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { type ChangedFile, joinDiff, parseNameStatus, parseNumstatBinary, parsePatchHunks } from "./diff.ts";
import { ChangesetError } from "./errors.ts";
import { git, gitOutput } from "./git.ts";

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

/** One version of a changeset, identified by its head commit. Base and head are full commit hashes. */
export interface Revision {
	readonly head: string;
	readonly base: string;
	readonly files: readonly ChangedFile[];
}

/**
 * A branch range under review.
 *
 * `id` is stable across revisions and unique within a repository: it hashes the range's refs by name, so new commits
 * on the head branch give a new revision of the same changeset.
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
	/**
	 * Throw `dirtyWorktree` when the working tree has uncommitted or untracked changes. Set it when a later step reads
	 * the head from the working tree rather than from git, so the review cannot silently cover different code.
	 */
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
		if (side === "" || side.includes("..") || side.startsWith("-") || /\s/.test(side)) {
			throw new ChangesetError("invalidRange", `"${side}" is not a ref`, { ref: side });
		}
	}
	return spec;
}

async function repositoryRoot(path: string): Promise<string> {
	const notARepository = new ChangesetError("notARepository", `${path} is not inside a git working tree`);
	const info = await stat(path).catch(() => undefined);
	if (!info?.isDirectory()) throw notARepository;
	const result = await git(path, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) throw notARepository;
	return result.stdout.trim();
}

async function commitOf(repoRoot: string, ref: string): Promise<string> {
	const result = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	if (result.code !== 0) throw new ChangesetError("unknownRef", `${ref} does not name a commit`, { ref });
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
	const result = await git(repoRoot, ["merge-base", base, head]);
	if (result.code !== 0) {
		throw new ChangesetError("noMergeBase", `${spec.base} and ${spec.head} share no history`, {
			ref: `${spec.base}...${spec.head}`,
		});
	}
	return result.stdout.trim();
}

async function dirtyPaths(repoRoot: string): Promise<string[]> {
	const output = await gitOutput(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
	const paths: string[] = [];
	const fields = output.split("\0");
	for (let i = 0; i < fields.length && fields[i] !== ""; i++) {
		paths.push(fields[i]!.slice(3));
		// A rename or copy is followed by its source path in a field of its own.
		if (/^[RC]/.test(fields[i]!)) i++;
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
	"--diff-algorithm=myers",
	"--indent-heuristic",
	"--inter-hunk-context=0",
	"--submodule=short",
];

async function diff(repoRoot: string, base: string, head: string): Promise<ChangedFile[]> {
	// diff.renames=copies would report copies, whose hunks are against the copy's source.
	const run = (format: string[]) =>
		gitOutput(repoRoot, ["-c", "diff.renames=true", "diff", ...diffFlags, ...format, base, head, "--"]);
	const [nameStatus, numstat, patch] = await Promise.all([
		run(["--name-status", "-z"]),
		run(["--numstat", "-z"]),
		run(["--unified=0"]),
	]);
	return joinDiff(parseNameStatus(nameStatus), parseNumstatBinary(numstat), parsePatchHunks(patch));
}

/**
 * Resolves a range in the repository containing `repoRoot` to a changeset with one revision.
 *
 * Shells out to `git`. Throws {@link ChangesetError}: `notARepository`, `invalidRange`, `unknownRef`, `noMergeBase`
 * when a three-dot range has unrelated sides, `dirtyWorktree` under `requireClean`, and `gitUnavailable` or `gitFailed`
 * when git itself fails.
 */
export async function resolveRange(
	repoRoot: string,
	range: string | RangeSpec,
	options: ResolveRangeOptions = {},
): Promise<RangeChangeset> {
	const spec = typeof range === "string" ? parseRangeSpec(range) : checkRange(range);
	const root = await repositoryRoot(repoRoot);
	const baseRef = await commitOf(root, spec.base);
	const head = await commitOf(root, spec.head);
	const base = spec.mode === "threeDot" ? await mergeBase(root, spec, baseRef, head) : baseRef;
	if (options.requireClean) {
		const paths = await dirtyPaths(root);
		if (paths.length > 0) {
			throw new ChangesetError("dirtyWorktree", `the working tree has uncommitted changes in ${paths.join(", ")}`, {
				paths,
			});
		}
	}
	const identity = [
		"range",
		spec.mode,
		await canonicalName(root, spec.base, baseRef),
		await canonicalName(root, spec.head, head),
	].join("\0");
	return {
		kind: "range",
		id: `range-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
		repoRoot: root,
		spec,
		revision: { head, base, files: await diff(root, base, head) },
	};
}
