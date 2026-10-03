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

/** One file in a revision's diff. Paths are repository-relative with forward slashes. A binary file has no hunks. */
export interface ChangedFile {
	readonly status: FileStatus;
	readonly path: string;
	readonly oldPath?: string;
	readonly binary: boolean;
	readonly hunks: readonly Hunk[];
}

interface NameStatus {
	readonly status: FileStatus;
	readonly path: string;
	readonly oldPath?: string;
}

const statuses: Record<string, FileStatus> = { A: "added", M: "modified", T: "modified", D: "deleted", R: "renamed" };

function diffMismatch(detail: string): ChangesetError {
	return new ChangesetError("gitFailed", `git diff output could not be parsed: ${detail}`);
}

export function parseNameStatus(output: string): NameStatus[] {
	const fields = output.split("\0");
	const entries: NameStatus[] = [];
	let i = 0;
	while (i < fields.length && fields[i] !== "") {
		const letter = fields[i]![0]!;
		const status = statuses[letter];
		if (status === undefined) throw diffMismatch(`unexpected status ${fields[i]}`);
		if (status === "renamed") {
			entries.push({ status, oldPath: fields[i + 1]!, path: fields[i + 2]! });
			i += 3;
		} else {
			entries.push({ status, path: fields[i + 1]! });
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

// Git emits the name-status, numstat, and patch views of one diff in the same file order.
export function joinDiff(
	nameStatus: readonly NameStatus[],
	binary: readonly boolean[],
	hunks: readonly Hunk[][],
): ChangedFile[] {
	if (binary.length !== nameStatus.length || hunks.length !== nameStatus.length) {
		throw diffMismatch(`${nameStatus.length} files by name, ${binary.length} by count, ${hunks.length} in the patch`);
	}
	return nameStatus.map((entry, index) => ({
		...entry,
		binary: binary[index]!,
		hunks: binary[index]! ? [] : hunks[index]!,
	}));
}
