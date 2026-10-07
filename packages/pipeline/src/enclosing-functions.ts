import { type ChangedFile, type Changeset, readRevisionFile, visibleText } from "@melian-agent/core";
import {
	isArrowFunction,
	isClassDeclaration,
	isClassExpression,
	isConstructorDeclaration,
	isExportAssignment,
	isFunctionDeclaration,
	isFunctionExpression,
	isGetAccessorDeclaration,
	isMethodDeclaration,
	isPropertyAssignment,
	isPropertyDeclaration,
	isSetAccessorDeclaration,
	isVariableDeclaration,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";
import { HeadProgram } from "./compiler-graph.ts";
import { quoteUntrusted } from "./untrusted.ts";

/**
 * What the change prompt carries of the head's functions. A file past `fileBytes`, a function past `functionLines`, and
 * the blocks past `promptBytes` are left to the lens's own `read_file`, which its instructions say; so are files past
 * `files`. A function left out is listed by name, and `promptBytes` counts that listing too: a name keeps its first
 * `nameBytes` bytes, and past `listed` entries, or the bytes the blocks left, the listing says how many more it left out.
 */
export const enclosingLimits = {
	files: 200,
	fileBytes: 512 * 1024,
	functionLines: 250,
	promptBytes: 64 * 1024,
	nameBytes: 200,
	listed: 100,
} as const;

const typescriptFile = /\.(?:[cm]?ts|tsx)$/;

/** One function, method, or accessor of a TypeScript file at the head that holds a line the change touched. */
export interface EnclosingFunction {
	readonly path: string;
	readonly name: string;
	readonly startLine: number;
	readonly endLine: number;
	/** The function's lines, numbered from `startLine`; absent when it is longer than {@link enclosingLimits}`.functionLines`. */
	readonly lines?: readonly string[];
}

interface Callable {
	readonly name: string;
	readonly startLine: number;
	readonly endLine: number;
}

// A function the code names: a declaration, a method, a constructor or accessor, or a function value a variable, a
// property, or a default export holds. A callback passed to a call has no name of its own, and the function around it
// is the one that matters.
function declaredName(node: Node): string | undefined {
	const name = namedBy(node);
	if (name === undefined) return undefined;
	let kept = name.slice(0, enclosingLimits.nameBytes);
	while (Buffer.byteLength(kept) > enclosingLimits.nameBytes) kept = kept.slice(0, -1);
	return kept;
}

function namedBy(node: Node): string | undefined {
	if (isFunctionDeclaration(node)) return node.name?.getText() ?? "default";
	if (isMethodDeclaration(node) || isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node)) {
		return `${classLabel(node)}${node.name.getText()}`;
	}
	if (isConstructorDeclaration(node)) return `${classLabel(node)}constructor`;
	if (isArrowFunction(node) || isFunctionExpression(node)) {
		const { parent } = node;
		if (isVariableDeclaration(parent) || isPropertyAssignment(parent) || isPropertyDeclaration(parent)) {
			return `${isPropertyDeclaration(parent) ? classLabel(parent) : ""}${parent.name.getText()}`;
		}
		if (isExportAssignment(parent)) return "default";
	}
	return undefined;
}

function classLabel(node: Node): string {
	for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
		if (isClassDeclaration(parent) || isClassExpression(parent)) {
			const name = (parent as Node & { name?: Node }).name?.getText();
			return name === undefined ? "" : `${name}.`;
		}
	}
	return "";
}

// The offset each line starts at, counting only LF as git and `read_file` do. The compiler's own line map also breaks at
// a lone CR, U+2028 and U+2029, so a function's bounds come from this table, never from it.
function lineStarts(text: string): number[] {
	const starts = [0];
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
	return starts;
}

// The one-based line holding `offset`.
function lineAt(starts: readonly number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (starts[middle]! <= offset) low = middle;
		else high = middle - 1;
	}
	return low + 1;
}

function callables(source: SourceFile, text: string): Callable[] {
	const starts = lineStarts(text);
	const found: Callable[] = [];
	const visit = (node: Node): void => {
		const name = declaredName(node);
		if (name !== undefined) {
			found.push({
				name,
				startLine: lineAt(starts, node.getStart(source)),
				endLine: lineAt(starts, node.end),
			});
		}
		node.forEachChild(visit);
	};
	source.forEachChild(visit);
	return found;
}

// The head lines a file's hunks put the change on: each line a hunk added, and for a hunk that only deleted, the pair of
// lines the deletion sits between, so a function counts only when it holds both.
function anchors(file: ChangedFile): (readonly [number, number])[] {
	const lines: (readonly [number, number])[] = [];
	for (const hunk of file.hunks) {
		if (hunk.newLines === 0) {
			lines.push([hunk.newStart, hunk.newStart + 1]);
			continue;
		}
		let line = hunk.newStart;
		for (const row of hunk.text.split("\n")) {
			if (row.startsWith("+")) lines.push([line, line++]);
		}
	}
	return lines;
}

/**
 * The innermost named function around each line a change touched, in the TypeScript files it changed, as the head has
 * them. The compiler reads the head's text from git, never the working tree; a file outside {@link enclosingLimits}, one
 * the compiler cannot read, and a hunk outside every function carry nothing, and the lens reads those with `read_file`.
 */
export class EnclosingFunctions {
	readonly functions: readonly EnclosingFunction[];
	/** Why the compiler could not be asked, when it could not; the functions are then empty. */
	readonly unavailable: string | undefined;

	private constructor(functions: readonly EnclosingFunction[], unavailable: string | undefined) {
		this.functions = functions;
		this.unavailable = unavailable;
	}

	/** An instance holding no function, for a review that asks none. */
	static none(): EnclosingFunctions {
		return new EnclosingFunctions([], undefined);
	}

	/** Reads the functions around `changeset`'s hunks at its head. Never throws: a failure is `unavailable`. */
	static async read(changeset: Changeset): Promise<EnclosingFunctions> {
		const { repoRoot, revision } = changeset;
		const candidates = revision.files
			.filter((file) => typescriptFile.test(file.path) && !file.path.endsWith(".d.ts"))
			.slice(0, enclosingLimits.files);
		if (candidates.length === 0) return EnclosingFunctions.none();
		const texts = new Map<string, string>();
		for (const file of candidates) {
			const head = await readRevisionFile(repoRoot, revision.head, file.path, enclosingLimits.fileBytes).catch(
				() => undefined,
			);
			if (head !== undefined && !head.truncated) texts.set(file.path, head.content);
		}
		if (texts.size === 0) return EnclosingFunctions.none();
		try {
			return new EnclosingFunctions(EnclosingFunctions.#parse(candidates, texts), undefined);
		} catch (error) {
			return new EnclosingFunctions([], visibleText(error instanceof Error ? error.message : String(error)));
		}
	}

	static #parse(files: readonly ChangedFile[], texts: ReadonlyMap<string, string>): EnclosingFunction[] {
		const program = HeadProgram.open(texts);
		try {
			const found: EnclosingFunction[] = [];
			for (const file of files) {
				const source = program.source(file.path);
				if (source === undefined) continue;
				const text = texts.get(file.path)!;
				const around = callables(source, text);
				const lines = text.split("\n");
				const taken = new Set<string>();
				for (const [first, last] of anchors(file)) {
					const holding = around
						.filter((each) => each.startLine <= first && last <= each.endLine)
						.sort((a, b) => b.startLine - a.startLine)[0];
					if (holding === undefined) continue;
					const key = `${holding.startLine}:${holding.endLine}`;
					if (taken.has(key)) continue;
					taken.add(key);
					found.push({
						path: file.path,
						name: holding.name,
						startLine: holding.startLine,
						endLine: holding.endLine,
						...(holding.endLine - holding.startLine + 1 > enclosingLimits.functionLines
							? {}
							: { lines: lines.slice(holding.startLine - 1, holding.endLine) }),
					});
				}
			}
			return found.sort(
				(a, b) =>
					files.findIndex((file) => file.path === a.path) - files.findIndex((file) => file.path === b.path) ||
					a.startLine - b.startLine,
			);
		} finally {
			program.close();
		}
	}

	/**
	 * The prompt blocks for the functions in `only`, each in its own boundary with its lines numbered as `read_file`
	 * numbers them, past which a listing and a note say what was left out. Empty when there is nothing to show.
	 */
	blocks(only: readonly string[] | undefined, nonce: string): string[] {
		const shown = this.functions.filter((each) => only === undefined || only.includes(each.path));
		if (shown.length === 0) return [];
		const parts = [
			"Enclosing functions: the head's whole function around each hunk of a TypeScript file, with line numbers. Each block's first line names the file, the function, and its lines.",
		];
		const left: string[] = [];
		let omitted = 0;
		let size = 0;
		const leave = (label: string) => {
			const bytes = Buffer.byteLength(label) + 1;
			if (left.length >= enclosingLimits.listed || size + bytes > enclosingLimits.promptBytes) {
				omitted++;
				return;
			}
			size += bytes;
			left.push(label);
		};
		for (const each of shown) {
			const label = `${visibleText(each.path)}:${each.startLine}-${each.endLine} ${visibleText(each.name)}`;
			if (each.lines === undefined) {
				leave(label);
				continue;
			}
			const width = String(each.endLine).length;
			const block = quoteUntrusted(
				"function",
				[
					label,
					...each.lines.map((line, index) => `${String(each.startLine + index).padStart(width)}\t${line}`),
				].join("\n"),
				nonce,
			);
			if (size + Buffer.byteLength(block) > enclosingLimits.promptBytes) {
				leave(label);
				continue;
			}
			size += Buffer.byteLength(block);
			parts.push(block);
		}
		if (left.length > 0 || omitted > 0) {
			parts.push("Functions not shown, because they are long or the limit was reached; read each with read_file:");
			if (left.length > 0) parts.push(quoteUntrusted("listing", left.join("\n"), nonce));
			if (omitted > 0)
				parts.push(`and ${omitted} more not listed here; read the changed TypeScript files with read_file.`);
		}
		return parts;
	}
}
