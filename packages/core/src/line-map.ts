import { diffFlags } from "./changeset.ts";
import { parseNumstatBinary, parsePatchHunks } from "./diff.ts";
import { git } from "./git.ts";

/** A run of lines in one file, both ends inclusive and 1-based. */
export interface LineSpan {
	readonly startLine: number;
	readonly endLine: number;
}

type Hunk = {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
};

/** Which commits and file a {@link LineMap} reads. */
export interface LineMapSides {
	/** The older commit. */
	readonly from: string;
	/** The newer commit. */
	readonly to: string;
	/** The repository-relative path at both commits; a rename is never followed. */
	readonly path: string;
	/** The commit whose `.gitattributes` decide the diff, as every Melian diff reads its base's. */
	readonly attributesFrom: string;
}

// A side of a zero-context hunk, as its lines, or the gap after `at` when it holds none.
type Side = { readonly start: number; readonly count: number };

// Whether `side` touches `span`: a changed line inside it or beside it, or, for a side with no lines, a gap inside it
// or at either edge. A zero-count side sits after its start line, so it is never read as touching nothing.
function touches(side: Side, span: LineSpan): boolean {
	if (side.count === 0) return side.start >= span.startLine - 1 && side.start <= span.endLine;
	return side.start <= span.endLine + 1 && side.start + side.count - 1 >= span.startLine - 1;
}

/**
 * How one file's lines moved between two commits, as git's zero-context diff says, with core's pinned diff flags and
 * renames off. A file git cannot diff as text, a `-diff` or binary file, a path that is not a regular file at both
 * commits, and any git failure, such as a missing object after a force push, leave the map unmapped: it then says no
 * span is untouched and maps nothing, never that nothing changed.
 */
export class LineMap {
	readonly #hunks: readonly Hunk[] | undefined;

	private constructor(hunks: readonly Hunk[] | undefined) {
		this.#hunks = hunks;
	}

	/** Reads the diff of `path` between `from` and `to` in `repoRoot`. Never throws: a failure gives an unmapped map. */
	static async between(repoRoot: string, sides: LineMapSides): Promise<LineMap> {
		const hunks = await LineMap.#read(repoRoot, sides).catch(() => undefined);
		return new LineMap(hunks);
	}

	static async #read(repoRoot: string, { from, to, path, attributesFrom }: LineMapSides): Promise<Hunk[] | undefined> {
		if ([from, to, attributesFrom].some((ref) => ref.startsWith("-"))) return undefined;
		const regular = async (commit: string) => {
			const listed = await git(repoRoot, [
				"--literal-pathspecs",
				"ls-tree",
				"-z",
				"--full-tree",
				commit,
				"--",
				path,
			]);
			// One entry, `<mode> <type> <object>\t<path>`: a regular or executable file, never a symlink, tree or submodule.
			const entries = listed.stdout.split("\0").filter((entry) => entry !== "");
			return listed.code === 0 && entries.length === 1 && /^100(?:644|755) /.test(entries[0]!);
		};
		if (!(await regular(from)) || !(await regular(to))) return undefined;
		// git reads no attributes, silently, from a well-formed object ID it does not hold, so the source must exist.
		const source = await git(repoRoot, ["cat-file", "-e", `${attributesFrom}^{commit}`]);
		if (source.code !== 0) return undefined;
		const args = (format: readonly string[], older = from, newer = to) => [
			"--literal-pathspecs",
			`--attr-source=${attributesFrom}`,
			"diff",
			...diffFlags,
			// After the pinned --find-renames, so a rename is never followed.
			"--no-renames",
			...format,
			older,
			newer,
			"--",
			path,
		];
		// An unchanged path gives no numstat entry, so ask git whether the whole file is text at each commit.
		const empty = await git(repoRoot, ["hash-object", "-t", "tree", "/dev/null"]);
		const whole = await Promise.all(
			[from, to].map((commit) => git(repoRoot, args(["--numstat", "-z"], empty.stdout.trim(), commit))),
		);
		// A failed hash-object leaves an empty ref, which git refuses.
		if (whole.some(({ code, stdout }) => code !== 0 || parseNumstatBinary(stdout).join() !== "false"))
			return undefined;
		const [numstat, patch] = await Promise.all([
			git(repoRoot, args(["--numstat", "-z"])),
			git(repoRoot, args(["--unified=0"])),
		]);
		if (numstat.code !== 0 || patch.code !== 0) return undefined;
		const binary = parseNumstatBinary(numstat.stdout);
		const files = parsePatchHunks(patch.stdout);
		if (binary.length !== files.length || binary.length > 1 || binary[0] === true) return undefined;
		return (files[0] ?? []).map(({ oldStart, oldLines, newStart, newLines }) => ({
			oldStart,
			oldLines,
			newStart,
			newLines,
		}));
	}

	/** Whether git could map the file at all. */
	get mapped(): boolean {
		return this.#hunks !== undefined;
	}

	/**
	 * Whether no hunk touches `old`, a span at the older commit, or `current`, a span at the newer: no changed line in
	 * or beside either, and no insertion or deletion inside or at either edge. Unmapped, it is never true.
	 */
	untouched(old: LineSpan, current: LineSpan): boolean {
		if (this.#hunks === undefined) return false;
		return this.#hunks.every(
			(hunk) =>
				!touches({ start: hunk.oldStart, count: hunk.oldLines }, old) &&
				!touches({ start: hunk.newStart, count: hunk.newLines }, current),
		);
	}

	/** Where `old`, a span at the older commit, sits at the newer one, or `undefined` when a hunk touches it or the map is unmapped. */
	map(old: LineSpan): LineSpan | undefined {
		if (this.#hunks === undefined) return undefined;
		let shift = 0;
		for (const hunk of this.#hunks) {
			const side = { start: hunk.oldStart, count: hunk.oldLines };
			if (touches(side, old)) return undefined;
			if (hunk.oldStart < old.startLine) shift += hunk.newLines - hunk.oldLines;
		}
		return { startLine: old.startLine + shift, endLine: old.endLine + shift };
	}
}
