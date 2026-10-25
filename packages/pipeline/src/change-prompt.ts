import {
	type ChangedFile,
	type Changeset,
	type Hunk,
	type LineRanges,
	readRevisionLink,
	type StoredCoverageLines,
	type UnitField,
	visibleText,
} from "@melian-agent/core";
import { cutDiffNote, type EnclosingFunctions } from "./enclosing-functions.ts";
import { quoteUntrusted } from "./untrusted.ts";

/** The bounds a change prompt keeps: the whole prompt, the metadata block of file units it left out, a symlink's target. */
export const promptLimits = { bytes: 200 * 1024, metadataBytes: 64 * 1024, targetBytes: 4 * 1024 } as const;

/**
 * What one lens prompt delivered, by head path: the hunk indexes its diff blocks rendered, the file fields it named,
 * from a file's block or the metadata block, and the files whose hunks the size limit left out.
 */
export type PromptDelivery = {
	hunks: Record<string, number[]>;
	fields: Record<string, UnitField[]>;
	omitted: string[];
};

/** A symlink's target at the head, by head path, as `ChangePrompt.readTargets` read it; absent when unread. */
export type SymlinkTargets = Readonly<Record<string, { readonly target: string; readonly truncated: boolean }>>;

function overlaps(ranges: LineRanges | undefined, first: number, count: number): boolean {
	if (ranges === undefined || count === 0) return false;
	const last = first + count - 1;
	return ranges.some(([from, to]) => from <= last && to >= first);
}

/**
 * The input a lens receives: the revision, the files it changes, and its zero-context diff, bounded at
 * {@link promptLimits}. Everything from the head is quoted inside the review's boundary. Blocks go smallest first, so
 * one large file never keeps a small one's hunks out, and a delta round's hunks under review come before the rest of
 * the diff, which follows as context.
 */
export class ChangePrompt {
	readonly changeset: Changeset;
	readonly nonce: string;
	readonly targets: SymlinkTargets;

	constructor(changeset: Changeset, nonce: string, targets: SymlinkTargets = {}) {
		this.changeset = changeset;
		this.nonce = nonce;
		this.targets = targets;
	}

	/** Reads the head target of every changed file that is a symlink at the head, bounded at 4 KiB; one unread is left out. */
	static async readTargets(changeset: Changeset): Promise<SymlinkTargets> {
		const targets: Record<string, { target: string; truncated: boolean }> = {};
		for (const file of changeset.revision.files) {
			if (file.newKind !== "symlink") continue;
			try {
				targets[file.path] = await readRevisionLink(
					changeset.repoRoot,
					changeset.revision.head,
					file.path,
					promptLimits.targetBytes,
				);
			} catch {
				// A target git cannot read is left out, so its field stays a gap until a round reads it.
			}
		}
		return targets;
	}

	/**
	 * The prompt, limited to the files `only` names when given, matching a renamed file by its old path or its new one.
	 * With `tools: false`, for a reader with no tools such as a decider, it does not tell the reader to read the head.
	 */
	render(
		only?: readonly string[],
		options: {
			readonly tools?: boolean;
			readonly functions?: EnclosingFunctions;
			readonly delta?: StoredCoverageLines;
		} = {},
	): string {
		return this.renderInput(only, options).text;
	}

	/** The bounded prompt, whether its size limit left out any hunk, and what it delivered. */
	renderInput(
		only?: readonly string[],
		options: {
			readonly tools?: boolean;
			readonly functions?: EnclosingFunctions;
			readonly delta?: StoredCoverageLines;
		} = {},
	): { readonly text: string; readonly cut: boolean; readonly delivered: PromptDelivery } {
		const { nonce } = this;
		const { base, head } = this.changeset.revision;
		const files = this.changeset.revision.files.filter(
			(file) =>
				only === undefined ||
				only.includes(file.path) ||
				(file.oldPath !== undefined && only.includes(file.oldPath)),
		);
		const units = new Map(this.changeset.revision.fileUnits().map((unit) => [unit.path, unit]));
		const named = (file: ChangedFile) =>
			`${file.oldPath === undefined ? "" : `${visibleText(file.oldPath)} -> `}${visibleText(file.path)}`;
		const tools = options.tools !== false;
		const header = [
			`Review the change from ${base.slice(0, 12)} to ${head.slice(0, 12)}.`,
			"",
			"Files changed:",
			quoteUntrusted("listing", files.map((file) => `${file.status} ${named(file)}`).join("\n"), nonce),
			"",
			`Each file's diff follows in its own block, whose first line names the file and whose second gives its modes and kinds. The diff has no context lines.${tools ? " Read the head revision with read_file for the code around each hunk." : ""}`,
		].join("\n");
		const parts = [header];
		let size = Buffer.byteLength(header);
		const delivered: PromptDelivery = { hunks: {}, fields: {}, omitted: [] };
		const left: { file: ChangedFile; hunk: Hunk }[] = [];
		const unfit = new Set<string>();
		const deliver = (file: ChangedFile, fields: readonly UnitField[]) => {
			delivered.fields[file.path] = [...new Set([...(delivered.fields[file.path] ?? []), ...fields])];
		};
		const facts = (file: ChangedFile): { text: string; fields: UnitField[] } => {
			const kinds = `mode ${file.oldMode ?? "none"} (${file.oldKind ?? "none"}) -> ${file.newMode ?? "none"} (${file.newKind ?? "none"})`;
			const fields: UnitField[] = ["status", "path"];
			if (file.oldPath !== undefined) fields.push("oldPath");
			for (const field of ["oldMode", "newMode", "oldKind", "newKind"] as const)
				if (file[field] !== undefined) fields.push(field);
			fields.push("binary");
			const parts = [kinds, file.binary ? "binary" : "text"];
			if (file.newKind === "symlink") {
				const read = this.targets[file.path];
				if (read === undefined || read.truncated) parts.push("symlink target not shown");
				else {
					parts.push(`symlink target ${visibleText(read.target)}`);
					fields.push("target");
				}
			}
			if (units.get(file.path)?.kind === "empty") {
				parts.push("empty file");
				fields.push("empty");
			}
			return { text: parts.join("; "), fields };
		};
		const inDelta = (file: ChangedFile, hunk: Hunk) =>
			overlaps(options.delta?.head[file.path], hunk.newStart, hunk.newLines) ||
			overlaps(options.delta?.base[file.oldPath ?? file.path], hunk.oldStart, hunk.oldLines);
		type Block = { file: ChangedFile; hunks: Hunk[]; text: string; fields: UnitField[] };
		const block = (file: ChangedFile, hunks: Hunk[]): Block => {
			const fact = facts(file);
			const body = file.binary ? ["(binary)"] : hunks.map((hunk) => `${hunk.header}\n${hunk.text}`);
			const text = quoteUntrusted("diff", [`${named(file)} (${file.status})`, fact.text, ...body].join("\n"), nonce);
			return { file, hunks, text, fields: fact.fields };
		};
		const bySize = (blocks: Block[]) => blocks.sort((a, b) => Buffer.byteLength(a.text) - Buffer.byteLength(b.text));
		const place = (blocks: Block[]) => {
			for (const each of bySize(blocks)) {
				const bytes = Buffer.byteLength(each.text) + 2;
				if (size + bytes > promptLimits.bytes) {
					for (const hunk of each.hunks) left.push({ file: each.file, hunk });
					unfit.add(each.file.path);
					continue;
				}
				size += bytes;
				parts.push(each.text);
				delivered.hunks[each.file.path] = [
					...(delivered.hunks[each.file.path] ?? []),
					...each.hunks.map((hunk) => hunk.index),
				];
				deliver(each.file, each.fields);
			}
		};
		if (options.delta === undefined) place(files.map((file) => block(file, [...file.hunks])));
		else {
			const review = files.flatMap((file) => {
				const hunks = file.hunks.filter((hunk) => inDelta(file, hunk));
				return hunks.length > 0 || options.delta?.units[file.path] !== undefined ? [block(file, hunks)] : [];
			});
			const rest = files.flatMap((file) => {
				const hunks = file.hunks.filter((hunk) => !inDelta(file, hunk));
				return hunks.length > 0 ? [block(file, hunks)] : [];
			});
			parts.push("## The change under review\n\nThese hunks are what this round reviews.");
			place(review);
			if (rest.length > 0) {
				parts.push(
					"## Context\n\nThe rest of the diff, which earlier rounds reviewed. Read it for what the change under review touches.",
				);
				place(rest);
			}
		}
		const cut = left.length > 0;
		if (cut) {
			delivered.omitted = [...new Set(left.map(({ file }) => file.path))];
			const owed = left.map(({ file, hunk }) =>
				hunk.newLines > 0
					? `${visibleText(file.path)} lines ${hunk.newStart}-${hunk.newStart + hunk.newLines - 1}`
					: `${visibleText(file.oldPath ?? file.path)} lines ${hunk.oldStart}-${hunk.oldStart + hunk.oldLines - 1} at the base`,
			);
			parts.push(
				tools
					? `These hunks were left out for size. Read each with read_file, in windows, before you finish:\n${quoteUntrusted("listing", owed.join("\n"), nonce)}`
					: "[The diff continues; the remaining hunks are omitted.]",
			);
		}
		// A file unit whose block the limit left out still reaches the lens by its fields alone, under a bound of its own,
		// whether or not any hunk was left out with it.
		const metadata: string[] = [];
		let metadataSize = 0;
		const unlisted = files.filter(
			(each) => units.has(each.path) && unfit.has(each.path) && delivered.fields[each.path] === undefined,
		);
		for (const file of unlisted) {
			const fact = facts(file);
			const line = `${named(file)} (${file.status}): ${fact.text}`;
			if (metadataSize + Buffer.byteLength(line) + 1 > promptLimits.metadataBytes) continue;
			metadataSize += Buffer.byteLength(line) + 1;
			metadata.push(line);
			deliver(file, fact.fields);
		}
		if (metadata.length > 0)
			parts.push(`File units left out of the diff:\n${quoteUntrusted("listing", metadata.join("\n"), nonce)}`);
		// The functions follow the diff, past its limit, so a cut diff never costs a function, and a function never a hunk.
		if (cut && options.functions !== undefined) parts.push(cutDiffNote);
		if (!cut && options.functions !== undefined)
			parts.push(
				...options.functions.blocks(
					files.map((file) => file.path),
					nonce,
				),
			);
		return { text: parts.join("\n\n"), cut, delivered };
	}
}
