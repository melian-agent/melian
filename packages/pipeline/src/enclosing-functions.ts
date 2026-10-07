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
 * The work is bounded too. A file with more than `anchorsPerFile` added lines or `callablesPerFile` named functions is left
 * to `read_file` whole, as is one that would take the review past `anchors` or `callables` across its files, and once
 * `found` functions are held no more are taken. The prompt says when any of these held something back.
 */
export const enclosingLimits = {
	files: 200,
	fileBytes: 512 * 1024,
	functionLines: 250,
	promptBytes: 64 * 1024,
	nameBytes: 200,
	listed: 100,
	anchorsPerFile: 5_000,
	anchors: 20_000,
	callablesPerFile: 20_000,
	callables: 100_000,
	found: 2_000,
} as const;

const cappedWhy = {
	files: `more than ${enclosingLimits.files} TypeScript files changed`,
	fileBytes: `a TypeScript file was larger than ${enclosingLimits.fileBytes / 1024} KiB`,
	unreadable: "a TypeScript file could not be read at the head",
	anchorsPerFile: `a file had more than ${enclosingLimits.anchorsPerFile} added lines`,
	anchors: `the files together had more than ${enclosingLimits.anchors} added lines`,
	callablesPerFile: `a file had more than ${enclosingLimits.callablesPerFile} named functions`,
	callables: `the files together had more than ${enclosingLimits.callables} named functions`,
	found: `more than ${enclosingLimits.found} functions held a change`,
} as const;

const unavailableNote =
	"The head's functions could not be read, so none is carried here; read the whole function around each hunk of a TypeScript file with read_file.";

/** What the change prompt says when its diff was cut and so carries no function. */
export const cutDiffNote =
	"The diff was cut, so no enclosing function is carried here; read the whole function around each hunk of a TypeScript file with read_file.";

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

// The named functions of a file in the order the compiler visits them, or `undefined` once there are more than `limit`.
function callables(source: SourceFile, text: string, limit: number): Callable[] | undefined {
	const starts = lineStarts(text);
	const found: Callable[] = [];
	const visit = (node: Node): void => {
		if (found.length > limit) return;
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
	return found.length > limit ? undefined : found;
}

// A max-heap of the callables whose start the sweep has passed: the latest start first, and for one start line the
// shorter span, then the one the compiler visited last. It visits an outer function before the ones inside it, so the
// innermost around a line is the later visit when the spans match.
class Open {
	readonly #items: { readonly callable: Callable; readonly order: number }[] = [];

	static #before(a: { callable: Callable; order: number }, b: { callable: Callable; order: number }): boolean {
		return (
			a.callable.startLine > b.callable.startLine ||
			(a.callable.startLine === b.callable.startLine &&
				(a.callable.endLine < b.callable.endLine ||
					(a.callable.endLine === b.callable.endLine && a.order > b.order)))
		);
	}

	push(callable: Callable, order: number): void {
		const items = this.#items;
		let at = items.length;
		items.push({ callable, order });
		while (at > 0) {
			const parent = (at - 1) >> 1;
			if (!Open.#before(items[at]!, items[parent]!)) break;
			[items[at], items[parent]] = [items[parent]!, items[at]!];
			at = parent;
		}
	}

	top(): Callable | undefined {
		return this.#items[0]?.callable;
	}

	pop(): void {
		const items = this.#items;
		const last = items.pop();
		if (last === undefined || items.length === 0) return;
		items[0] = last;
		let at = 0;
		for (;;) {
			const left = 2 * at + 1;
			const right = left + 1;
			let best = at;
			if (left < items.length && Open.#before(items[left]!, items[best]!)) best = left;
			if (right < items.length && Open.#before(items[right]!, items[best]!)) best = right;
			if (best === at) return;
			[items[at], items[best]] = [items[best]!, items[at]!];
			at = best;
		}
	}
}

// The innermost callable around each anchor, in the anchors' order sorted by line. An anchor's last line is its first or
// the next, so once a callable ends before an anchor's last line it ends before every later anchor's too, and is dropped
// for good when it surfaces.
function holders(around: readonly Callable[], anchors: readonly (readonly [number, number])[]): Callable[] {
	const byStart = around
		.map((callable, order) => ({ callable, order }))
		.sort((a, b) => a.callable.startLine - b.callable.startLine || a.order - b.order);
	const sorted = [...anchors].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const open = new Open();
	const found: Callable[] = [];
	let next = 0;
	for (const [first, last] of sorted) {
		while (next < byStart.length && byStart[next]!.callable.startLine <= first) {
			open.push(byStart[next]!.callable, byStart[next]!.order);
			next++;
		}
		for (let top = open.top(); top !== undefined && top.endLine < last; top = open.top()) open.pop();
		const holding = open.top();
		if (holding !== undefined) found.push(holding);
	}
	return found;
}

// The head lines a file's hunks put the change on: each line a hunk added, and for a hunk that only deleted, the pair of
// lines the deletion sits between, so a function counts only when it holds both.
// `undefined` once there are more than `limit`.
function anchors(file: ChangedFile, limit: number): (readonly [number, number])[] | undefined {
	const lines: (readonly [number, number])[] = [];
	for (const hunk of file.hunks) {
		if (hunk.newLines === 0) {
			lines.push([hunk.newStart, hunk.newStart + 1]);
		} else {
			let line = hunk.newStart;
			for (const row of hunk.text.split("\n")) {
				if (row.startsWith("+")) lines.push([line, line++]);
				if (lines.length > limit) return undefined;
			}
		}
		if (lines.length > limit) return undefined;
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
	/** The work limits that held something back, each named once; the lens reads what they left out with `read_file`. */
	readonly capped: readonly string[];

	private constructor(
		functions: readonly EnclosingFunction[],
		unavailable: string | undefined,
		capped: readonly string[],
	) {
		this.functions = functions;
		this.unavailable = unavailable;
		this.capped = capped;
	}

	/** An instance holding no function, for a review that asks none. */
	static none(): EnclosingFunctions {
		return new EnclosingFunctions([], undefined, []);
	}

	/** Reads the functions around `changeset`'s hunks at its head. Never throws: a failure is `unavailable`. */
	static async read(changeset: Changeset): Promise<EnclosingFunctions> {
		const { repoRoot, revision } = changeset;
		const typescript = revision.files.filter(
			(file) => typescriptFile.test(file.path) && !file.path.endsWith(".d.ts") && file.status !== "deleted",
		);
		const candidates = typescript.slice(0, enclosingLimits.files);
		if (candidates.length === 0) return EnclosingFunctions.none();
		const skipped = new Set<keyof typeof cappedWhy>();
		if (typescript.length > candidates.length) skipped.add("files");
		const texts = new Map<string, string>();
		for (const file of candidates) {
			const head = await readRevisionFile(repoRoot, revision.head, file.path, enclosingLimits.fileBytes).catch(
				() => undefined,
			);
			if (head === undefined) skipped.add("unreadable");
			else if (head.truncated) skipped.add("fileBytes");
			else texts.set(file.path, head.content);
		}
		if (texts.size === 0) return new EnclosingFunctions([], undefined, [...skipped]);
		try {
			const { functions, capped } = EnclosingFunctions.#parse(candidates, texts);
			return new EnclosingFunctions(functions, undefined, [...skipped, ...capped]);
		} catch (error) {
			return new EnclosingFunctions([], visibleText(error instanceof Error ? error.message : String(error)), []);
		}
	}

	static #parse(
		files: readonly ChangedFile[],
		texts: ReadonlyMap<string, string>,
	): { functions: EnclosingFunction[]; capped: string[] } {
		const program = HeadProgram.open(texts);
		try {
			const functions: EnclosingFunction[] = [];
			const capped = new Set<string>();
			let anchorsLeft: number = enclosingLimits.anchors;
			let callablesLeft: number = enclosingLimits.callables;
			for (const file of files) {
				const source = program.source(file.path);
				if (source === undefined) continue;
				const anchored = anchors(file, Math.min(enclosingLimits.anchorsPerFile, anchorsLeft));
				if (anchored === undefined) {
					capped.add(anchorsLeft < enclosingLimits.anchorsPerFile ? "anchors" : "anchorsPerFile");
					continue;
				}
				const text = texts.get(file.path)!;
				const around = callables(source, text, Math.min(enclosingLimits.callablesPerFile, callablesLeft));
				if (around === undefined) {
					capped.add(callablesLeft < enclosingLimits.callablesPerFile ? "callables" : "callablesPerFile");
					continue;
				}
				anchorsLeft -= anchored.length;
				callablesLeft -= around.length;
				const lines = text.split("\n");
				const taken = new Set<string>();
				const own: EnclosingFunction[] = [];
				for (const holding of holders(around, anchored)) {
					const key = `${holding.startLine}:${holding.endLine}`;
					if (taken.has(key)) continue;
					if (functions.length + own.length >= enclosingLimits.found) {
						capped.add("found");
						break;
					}
					taken.add(key);
					own.push({
						path: file.path,
						name: holding.name,
						startLine: holding.startLine,
						endLine: holding.endLine,
						...(holding.endLine - holding.startLine + 1 > enclosingLimits.functionLines
							? {}
							: { lines: lines.slice(holding.startLine - 1, holding.endLine) }),
					});
				}
				own.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
				functions.push(...own);
			}
			return { functions, capped: [...capped] };
		} finally {
			program.close();
		}
	}

	/**
	 * The prompt blocks for the functions in `only`, each in its own boundary with its lines numbered as `read_file`
	 * numbers them, past which a listing and a note say what was left out. Empty when there is nothing to show.
	 */
	blocks(only: readonly string[] | undefined, nonce: string): string[] {
		if (this.unavailable !== undefined) return [unavailableNote];
		const shown = this.functions.filter((each) => only === undefined || only.includes(each.path));
		const held = this.capped.map((reason) => cappedWhy[reason as keyof typeof cappedWhy]);
		const heldNote = `Some functions were not read, because ${held.join(" and ")}; read the changed TypeScript files with read_file.`;
		if (shown.length === 0) return held.length === 0 ? [] : [heldNote];
		const parts = [
			"Enclosing functions: the head's whole function around each hunk of a TypeScript file, with line numbers. Each block's first line names the file, the function, and its lines.",
		];
		const left: string[] = [];
		let omitted = 0;
		let size = 0;
		const smallest = Buffer.byteLength(quoteUntrusted("function", "", nonce));
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
			// The budget is spent once not even an empty block fits, and a block is at least as long as its lines.
			if (
				size + smallest + each.lines.reduce((sum, line) => sum + line.length + 1, 0) >
				enclosingLimits.promptBytes
			) {
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
		if (held.length > 0) parts.push(heldNote);
		return parts;
	}
}
