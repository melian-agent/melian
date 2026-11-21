import {
	checkCellValue,
	checkChangeset,
	disposalMark,
	RecordError,
	recordLimit,
	SharedRecord,
} from "@melian-agent/core";
import type { Deadline } from "./deadline.ts";
import type { RecordRepository, TreeEntry } from "./repository.ts";
import { entryLimit, listingLimit, TipSize, tipLimit } from "./tip-size.ts";

export { entryLimit, listingLimit, tipLimit };

const cellName = "cell.json";
const changesetsName = "changesets";
const version = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// A changeset's cell as the branch holds it, at `changesets/<changeset>/cell.json`.
export type Cell = { readonly value: string; readonly version: string };

// The bytes of `cell.json` holding `value` at `version`.
export function cellBytes(cell: Cell): string {
	return JSON.stringify({ v: 1, value: cell.value, version: cell.version });
}

export function cellPath(changeset: string): string {
	return `changesets/${changeset}/${cellName}`;
}

// The cell in `text`, or undefined when it is not one Melian wrote: other fields, other bytes, or a value no write takes.
function parseCell(text: string): Cell | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { value, version: found } = parsed as { value?: unknown; version?: unknown };
	if (typeof value !== "string" || typeof found !== "string" || !version.test(found)) return undefined;
	const cell = { value, version: found };
	if (cellBytes(cell) !== text) return undefined;
	if (value !== disposalMark) {
		try {
			checkCellValue(value);
		} catch {
			return undefined;
		}
	}
	return cell;
}

// Every field git listed, the path as its raw bytes, so a field an entry gains joins the key.
function keyOf(entry: TreeEntry): string {
	return JSON.stringify({ ...entry, path: entry.path.toString("latin1") });
}

function isChangesets(entry: TreeEntry): boolean {
	return entry.type === "tree" && entry.path.toString("latin1") === changesetsName;
}

// Whether two listings of one level hold the same entries, by name, mode, type and object ID.
function sameEntries(first: readonly TreeEntry[], second: readonly TreeEntry[]): boolean {
	const held = new Set(first.map(keyOf));
	return first.length === second.length && second.every((entry) => held.has(keyOf(entry)));
}

function changesetName(name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	try {
		checkChangeset(name);
		return name;
	} catch {
		return undefined;
	}
}

function decode(bytes: Buffer): string | undefined {
	try {
		return utf8.decode(bytes);
	} catch {
		return undefined;
	}
}

const escapes: Readonly<Record<number, string>> = {
	7: "a",
	8: "b",
	9: "t",
	10: "n",
	11: "v",
	12: "f",
	13: "r",
	34: '"',
	92: "\\",
};

// A path that is not UTF-8 in git's own quoted form, as `git ls-tree` prints it, so a writer can find the entry. Git
// cannot be asked for one path's form, since a process argument cannot carry bytes that are not UTF-8.
function quoted(path: Buffer): string {
	let text = "";
	for (const byte of path) {
		const letter = escapes[byte];
		if (letter !== undefined) text += `\\${letter}`;
		else if (byte < 0x20 || byte >= 0x7f) text += `\\${byte.toString(8).padStart(3, "0")}`;
		else text += String.fromCharCode(byte);
	}
	return `"${text}"`;
}

// What an entry is once judged. A record or cell is filed under its changeset; anything else is a stray, filed under
// the changeset whose folder holds it, or under none when it sits anywhere else.
export type Judged =
	| { readonly is: "record"; readonly changeset: string; readonly record: SharedRecord }
	| { readonly is: "cell"; readonly changeset: string; readonly cell: Cell }
	| { readonly is: "stray"; readonly changeset: string | undefined; readonly path: string };

type Changeset = { records: Map<string, SharedRecord>; cell: Cell | undefined; strays: string[] };

// One fetched tip of the branch, every entry judged: a record at the path its own bytes give, a cell, or a stray. An
// entry is judged by its mode, type, object ID and path alone, so a handle keeps what it judged and reads each blob once.
export class StateTree {
	readonly #changesets = new Map<string, Changeset>();
	readonly #strays: string[] = [];

	private constructor(judged: readonly Judged[]) {
		for (const entry of judged) {
			if (entry.is === "stray" && entry.changeset === undefined) {
				this.#strays.push(entry.path);
				continue;
			}
			const changeset = this.#changeset(entry.changeset as string);
			if (entry.is === "record") changeset.records.set(entry.record.path, entry.record);
			else if (entry.is === "cell") changeset.cell = entry.cell;
			else changeset.strays.push(entry.path);
		}
	}

	static empty(): StateTree {
		return new StateTree([]);
	}

	// Judges every entry of `branch`'s tip `commit`, reusing what `judged` already holds and adding what it reads.
	static async read(
		repository: RecordRepository,
		branch: string,
		commit: string,
		judged: Map<string, Judged>,
		deadline: Deadline,
	): Promise<StateTree> {
		const { entries, small } = await StateTree.#measure(repository, branch, commit, deadline, false);
		const fresh = entries.filter((entry) => !judged.has(keyOf(entry)));
		const wanted = new Set(fresh.map((entry) => entry.oid).filter((oid) => small.has(oid)));
		const blobs = await repository.blobs(
			new Map([...wanted].map((oid) => [oid, small.get(oid) as number])),
			deadline,
		);
		for (const entry of fresh) judged.set(keyOf(entry), StateTree.#judge(entry, blobs.get(entry.oid)));
		return new StateTree(entries.map((entry) => judged.get(keyOf(entry)) as Judged));
	}

	// Fails as unreachable when `commit`, which a write is about to push to `branch`, holds more than a call may read.
	static async measure(
		repository: RecordRepository,
		branch: string,
		commit: string,
		deadline: Deadline,
	): Promise<void> {
		await StateTree.#measure(repository, branch, commit, deadline, true);
	}

	// Whether `commit` has `parent` as its one parent and `parent`'s tree with only whole `changesets/<name>` folders
	// removed, at least one: each other root entry and each kept folder the same by name, mode, type and object ID.
	static async removesOnly(
		repository: RecordRepository,
		parent: string,
		commit: string,
		deadline: Deadline,
	): Promise<boolean> {
		const parents = await repository.parents(commit, deadline);
		if (parents.length !== 1 || parents[0] !== parent) return false;
		const before = await repository.children(parent, deadline, listingLimit);
		const after = await repository.children(commit, deadline, listingLimit);
		if (before === undefined || after === undefined) return false;
		const was = before.find(isChangesets);
		const now = after.find((entry) => entry.path.toString("latin1") === changesetsName);
		if (was === undefined || (now !== undefined && now.type !== "tree")) return false;
		if (
			!sameEntries(
				before.filter((entry) => entry !== was),
				after.filter((entry) => entry !== now),
			)
		)
			return false;
		const folders = await repository.children(was.oid, deadline, listingLimit);
		const kept = now === undefined ? [] : await repository.children(now.oid, deadline, listingLimit);
		if (folders === undefined || kept === undefined || kept.length >= folders.length) return false;
		const held = new Set(folders.map(keyOf));
		return kept.every((entry) => held.has(keyOf(entry)));
	}

	// Each changeset folder of `commit`, by its name, with its tree's object ID, read from the top level of `changesets/`
	// alone. An entry there that is no tree or bears no changeset's name is a stray, and no folder.
	static async folders(
		repository: RecordRepository,
		commit: string,
		deadline: Deadline,
	): Promise<Map<string, string>> {
		const root = await StateTree.#children(repository, commit, deadline);
		const folder = root.find(isChangesets);
		if (folder === undefined) return new Map();
		return new Map(
			(await StateTree.#children(repository, folder.oid, deadline)).flatMap((entry) => {
				const name = entry.type === "tree" ? changesetName(decode(entry.path)) : undefined;
				return name === undefined ? [] : [[name, entry.oid] as const];
			}),
		);
	}

	// Whether the folder of `changeset` at tree `oid` holds anything the store did not write, judged as a read judges it.
	// A folder too large to judge whole counts as holding one, so nothing unjudged is removed.
	static async holdsStray(
		repository: RecordRepository,
		changeset: string,
		oid: string,
		judged: Map<string, Judged>,
		deadline: Deadline,
	): Promise<boolean> {
		const listed = await repository.entries(oid, deadline, listingLimit);
		if (listed === undefined || listed.length > entryLimit) return true;
		const prefix = Buffer.from(`${changesetsName}/${changeset}/`);
		const entries = listed.map((entry) => ({ ...entry, path: Buffer.concat([prefix, entry.path]) }));
		const readable = [...new Set(entries.filter((entry) => StateTree.#readable(entry)).map((entry) => entry.oid))];
		const sizes = await repository.sizes(readable, deadline);
		if (readable.some((blob) => (sizes.get(blob) ?? Number.POSITIVE_INFINITY) > recordLimit)) return true;
		const total = entries.reduce(
			(sum, entry) => sum + (StateTree.#readable(entry) ? (sizes.get(entry.oid) as number) : 0),
			0,
		);
		if (total > tipLimit) return true;
		const fresh = entries.filter((entry) => !judged.has(keyOf(entry)));
		const wanted = [...new Set(fresh.filter((entry) => StateTree.#readable(entry)).map((entry) => entry.oid))];
		const blobs = await repository.blobs(new Map(wanted.map((blob) => [blob, sizes.get(blob) as number])), deadline);
		for (const entry of fresh) judged.set(keyOf(entry), StateTree.#judge(entry, blobs.get(entry.oid)));
		return entries.some((entry) => (judged.get(keyOf(entry)) as Judged).is === "stray");
	}

	static async #children(repository: RecordRepository, treeish: string, deadline: Deadline): Promise<TreeEntry[]> {
		const entries = await repository.children(treeish, deadline, listingLimit);
		if (entries === undefined)
			throw new RecordError("unreachable", `one level of ${treeish} lists more than ${listingLimit} bytes`);
		return entries;
	}

	// The entries of `commit` and the sizes of its readable blobs, once both are within the limits. A write's commit, which
	// `before` says is not yet pushed, is refused in words that say so.
	static async #measure(
		repository: RecordRepository,
		branch: string,
		commit: string,
		deadline: Deadline,
		before: boolean,
	): Promise<{ entries: TreeEntry[]; small: Map<string, number> }> {
		const [holds, lists] = before ? ["would hold", "would list"] : ["holds", "lists"];
		// Past a limit every call but a retirement fails, so retiring changesets brings the tip back under; strays need git.
		const remedy = (strays: boolean) =>
			before
				? `nothing was pushed, and retiring changesets${strays ? " or removing strays" : ""} makes room`
				: `every call but a retirement fails, until changesets are retired${strays ? " or a writer removes strays from the branch with git" : ""}`;
		const listing = await repository.listing(commit, deadline, listingLimit);
		if (listing === undefined)
			throw new RecordError(
				"unreachable",
				`${branch} ${lists} more than ${listingLimit} bytes of entries at its tip, past the store's limit; ${remedy(true)}`,
			);
		const { entries } = listing;
		if (entries.length > entryLimit)
			throw new RecordError(
				"unreachable",
				`${branch} ${holds} ${entries.length} entries at its tip, past the store's limit of ${entryLimit}; ${remedy(true)}`,
			);
		const { small, total } = await StateTree.#sizes(repository, entries, deadline);
		if (total > tipLimit)
			throw new RecordError(
				"unreachable",
				`${branch} ${holds} ${total} bytes of records and cells at its tip, past the store's limit of ${tipLimit}; ${remedy(false)}`,
			);
		return { entries, small };
	}

	// What `commit` holds against each limit, counted as a read counts it before it reads a blob, and refused at none.
	static async size(repository: RecordRepository, commit: string, deadline: Deadline): Promise<TipSize> {
		const listing = await repository.listing(commit, deadline, listingLimit);
		if (listing === undefined) return TipSize.unlisted();
		const { total } = await StateTree.#sizes(repository, listing.entries, deadline);
		return TipSize.of({ entries: listing.entries.length, recordBytes: total, listingBytes: listing.bytes });
	}

	// The sizes of the readable blobs of `entries` no larger than a record may be, and their total over every path.
	static async #sizes(
		repository: RecordRepository,
		entries: readonly TreeEntry[],
		deadline: Deadline,
	): Promise<{ small: Map<string, number>; total: number }> {
		const readable = [...new Set(entries.filter((entry) => StateTree.#readable(entry)).map((entry) => entry.oid))];
		const sizes = await repository.sizes(readable, deadline);
		const small = new Map(
			readable.flatMap((oid) => {
				const size = sizes.get(oid) ?? Number.POSITIVE_INFINITY;
				return size <= recordLimit ? [[oid, size] as const] : [];
			}),
		);
		// Each path is judged and held apart, so a blob counts at every path it sits at.
		const total = entries.reduce(
			(sum, entry) => sum + (StateTree.#readable(entry) ? (small.get(entry.oid) ?? 0) : 0),
			0,
		);
		return { small, total };
	}

	// Only a regular file where a record or cell may sit is worth reading; everything else is a stray by its path alone.
	static #readable(entry: TreeEntry): boolean {
		if (entry.mode !== "100644" || entry.type !== "blob") return false;
		const parts = entry.path.toString("latin1").split("/");
		if (parts[0] !== "changesets") return false;
		return (parts.length === 3 && parts[2] === cellName) || (parts.length === 5 && parts[4]!.endsWith(".json"));
	}

	static #judge(entry: TreeEntry, bytes: Buffer | undefined): Judged {
		const path = decode(entry.path);
		const parts = (path ?? "").split("/");
		const changeset = parts[0] === "changesets" && parts.length > 2 ? changesetName(parts[1]) : undefined;
		const stray: Judged = {
			is: "stray",
			changeset: path === undefined ? StateTree.#rawScope(entry.path) : changeset,
			path: path ?? quoted(entry.path),
		};
		if (path === undefined || changeset === undefined || bytes === undefined || !StateTree.#readable(entry))
			return stray;
		const text = decode(bytes);
		if (text === undefined) return stray;
		if (parts.length === 3) {
			const cell = parseCell(text);
			return cell === undefined ? stray : { is: "cell", changeset, cell };
		}
		try {
			const record = SharedRecord.readEnvelope(text, parts[4]!.slice(0, -".json".length));
			return record.path === path ? { is: "record", changeset, record } : stray;
		} catch {
			return stray;
		}
	}

	// The changeset whose folder holds a path that is not UTF-8 throughout, when its first two parts are.
	static #rawScope(path: Buffer): string | undefined {
		const parts = path.toString("latin1").split("/");
		if (parts.length < 3 || parts[0] !== "changesets") return undefined;
		const name = decode(Buffer.from(parts[1]!, "latin1"));
		return changesetName(name);
	}

	#changeset(name: string): Changeset {
		let changeset = this.#changesets.get(name);
		if (changeset === undefined) {
			changeset = { records: new Map(), cell: undefined, strays: [] };
			this.#changesets.set(name, changeset);
		}
		return changeset;
	}

	// Every entry the store did not write, in the order the tree lists them, wherever it sits.
	get strays(): string[] {
		return [...this.#strays, ...[...this.#changesets.values()].flatMap((changeset) => changeset.strays)];
	}

	// Throws `RecordError` `unknownFile` naming a stray that refuses calls on `changeset`: one in its folder, or outside every folder.
	refuse(changeset: string): void {
		const stray = this.#strays[0] ?? this.#changesets.get(changeset)?.strays[0];
		if (stray !== undefined)
			throw new RecordError(
				"unknownFile",
				`${stray} on the record branch is no record or cell Melian wrote; a writer must remove it`,
				{ path: stray },
			);
	}

	records(changeset: string): SharedRecord[] {
		return [...(this.#changesets.get(changeset)?.records.values() ?? [])];
	}

	has(record: SharedRecord): boolean {
		return this.#changesets.get(record.changeset)?.records.has(record.path) === true;
	}

	cell(changeset: string): Cell | undefined {
		return this.#changesets.get(changeset)?.cell;
	}

	disposed(changeset: string): boolean {
		return this.cell(changeset)?.value === disposalMark;
	}
}
