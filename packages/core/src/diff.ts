import { ChangesetError } from "./errors.ts";

/** How a file changed between base and head. A type change, such as a file becoming a symlink, counts as `modified`. */
export type FileStatus = "added" | "modified" | "deleted" | "renamed";

/**
 * One hunk of a zero-context unified diff.
 *
 * Ranges follow git's convention: a count of 0 means the hunk only adds (or only deletes) lines, and its start on that
 * side is the line after which the change sits. `text` holds the hunk's lines without the `@@` header, each still
 * carrying its `+`, `-`, or `\` prefix.
 */
export interface Hunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly header: string;
	readonly text: string;
}

/**
 * What a path holds on one side of a diff, from its git mode: `file` (100644), `executable` (100755), `symlink`
 * (120000), or `submodule` (160000, a gitlink).
 */
export type FileKind = "file" | "executable" | "symlink" | "submodule";

/**
 * One file in a revision's diff. Paths are repository-relative with forward slashes. A binary file has no hunks.
 *
 * `oldMode` and `newMode` are git's octal modes, absent on the side where the file does not exist; `oldKind` and
 * `newKind` name them. A mode change alone, such as a file becoming executable, is `modified` with no hunks.
 */
export interface ChangedFile {
	readonly status: FileStatus;
	readonly path: string;
	readonly oldPath?: string;
	readonly oldMode?: string;
	readonly newMode?: string;
	readonly oldKind?: FileKind;
	readonly newKind?: FileKind;
	readonly binary: boolean;
	readonly hunks: readonly Hunk[];
}

interface RawEntry {
	readonly status: FileStatus;
	readonly path: string;
	readonly oldPath?: string;
	readonly oldMode?: string;
	readonly newMode?: string;
	readonly oldKind?: FileKind;
	readonly newKind?: FileKind;
	readonly typeChanged?: boolean;
}

const statuses: Record<string, FileStatus> = { A: "added", M: "modified", T: "modified", D: "deleted", R: "renamed" };
const absentMode = "000000";

function diffMismatch(detail: string): ChangesetError {
	return new ChangesetError("gitFailed", `git diff output could not be parsed: ${detail}`);
}

function kindOf(mode: string): FileKind {
	if (mode === "120000") return "symlink";
	if (mode === "160000") return "submodule";
	return mode === "100755" ? "executable" : "file";
}

function sides(oldMode: string, newMode: string): Partial<RawEntry> {
	return {
		...(oldMode === absentMode ? {} : { oldMode, oldKind: kindOf(oldMode) }),
		...(newMode === absentMode ? {} : { newMode, newKind: kindOf(newMode) }),
	};
}

const rawHeader = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/;

// `git diff --raw -z`: a `:oldmode newmode oldsha newsha status` field, then one path, or two for a rename.
export function parseRaw(output: string): RawEntry[] {
	const fields = output.split("\0");
	const entries: RawEntry[] = [];
	let i = 0;
	while (i < fields.length && fields[i] !== "") {
		const header = rawHeader.exec(fields[i]!);
		const status = header === null ? undefined : statuses[header[3]!];
		if (header === null || status === undefined) throw diffMismatch(`unexpected raw entry ${fields[i]}`);
		const modes = sides(header[1]!, header[2]!);
		if (status === "renamed") {
			entries.push({ status, oldPath: fields[i + 1]!, path: fields[i + 2]!, ...modes });
			i += 3;
		} else {
			entries.push({ status, path: fields[i + 1]!, ...modes, ...(header[3] === "T" ? { typeChanged: true } : {}) });
			i += 2;
		}
	}
	return entries;
}

export function parseNumstatBinary(output: string): boolean[] {
	const fields = output.split("\0");
	const binary: boolean[] = [];
	let i = 0;
	while (i < fields.length && fields[i] !== "") {
		const field = fields[i]!;
		binary.push(field.startsWith("-\t-\t"));
		const pathStart = field.indexOf("\t", field.indexOf("\t") + 1) + 1;
		// A rename leaves the path empty and puts the old and new paths in the next two fields.
		i += pathStart === field.length ? 3 : 1;
	}
	return binary;
}

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatchHunks(output: string): Hunk[][] {
	const files: Hunk[][] = [];
	let hunks: Hunk[] | undefined;
	let header: RegExpExecArray | undefined;
	let headerLine = "";
	let body: string[] = [];
	const closeHunk = () => {
		if (hunks === undefined || header === undefined) return;
		hunks.push({
			oldStart: Number(header[1]),
			oldLines: header[2] === undefined ? 1 : Number(header[2]),
			newStart: Number(header[3]),
			newLines: header[4] === undefined ? 1 : Number(header[4]),
			header: headerLine,
			text: body.join("\n"),
		});
		header = undefined;
		body = [];
	};
	const lines = output.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			closeHunk();
			hunks = [];
			files.push(hunks);
		} else if (line.startsWith("@@ ")) {
			closeHunk();
			const match = hunkHeader.exec(line);
			if (match === null) throw diffMismatch(`malformed hunk header ${line}`);
			header = match;
			headerLine = line;
		} else if (header !== undefined) {
			body.push(line);
		}
	}
	closeHunk();
	return files;
}

// Git emits the raw, numstat, and patch views of one diff in the same file order. The patch alone shows a type
// change, such as a file becoming a symlink, as a deletion followed by an addition.
export function joinDiff(
	raw: readonly RawEntry[],
	binary: readonly boolean[],
	hunks: readonly Hunk[][],
): ChangedFile[] {
	const sections = raw.reduce((count, entry) => count + (entry.typeChanged ? 2 : 1), 0);
	if (binary.length !== raw.length || hunks.length !== sections) {
		throw diffMismatch(`${raw.length} files by name, ${binary.length} by count, ${hunks.length} in the patch`);
	}
	let section = 0;
	return raw.map(({ typeChanged, ...entry }, index) => {
		const fileHunks = typeChanged ? [...hunks[section]!, ...hunks[section + 1]!] : hunks[section]!;
		section += typeChanged ? 2 : 1;
		return { ...entry, binary: binary[index]!, hunks: binary[index]! ? [] : fileHunks };
	});
}
