import { randomUUID } from "node:crypto";
import { RecordError } from "./errors.ts";
import { type RecordEnvelope, SharedRecord } from "./record.ts";

/** A changeset's cell as `readCell` returns it: both fields, or neither when nothing was ever written. */
export type RecordCell = { value?: string; version?: string };

/**
 * The record store port of rule 3 of [the shared record
 * decision](../../../docs/decisions/2026-11-13-shared-record-behind-a-store-port.md). It promises this much and no
 * more: `add` can be repeated, and a batch that landed in part is completed by a repeat; `list` and `readCell` are
 * fresh, or fail; `writeCell` succeeds only while the cell's version is still the expected one, and every successful
 * write changes the version; `dispose` first marks the cell, after which `add` and `writeCell` refuse the changeset for
 * good. No ordering of records, no history, no transaction across records, no secrecy, and no identity for a writer.
 * Every adapter passes the conformance suite in `@melian-agent/core/testing`.
 */
export interface RecordStore {
	add(records: RecordEnvelope[]): Promise<void>;
	list(changeset: string): Promise<RecordEnvelope[]>;
	readCell(changeset: string): Promise<RecordCell>;
	writeCell(changeset: string, expectedVersion: string | undefined, value: string): Promise<boolean>;
	dispose(changeset: string): Promise<void>;
	close(): Promise<void>;
}

/** The value `dispose` leaves in a changeset's cell. A cell that holds it refuses every later `add` and `writeCell`. */
export const disposalMark = '{"disposed":true}';

const changesetName = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

export function checkChangeset(changeset: string): void {
	if (!changesetName.test(changeset)) {
		throw new RecordError("invalidChangeset", `"${changeset}" is not a changeset name`);
	}
}

export function disposedError(changeset: string): RecordError {
	return new RecordError("disposed", `changeset ${changeset} is disposed`);
}

type MemoryChangeset = { records: Map<string, string>; cell: { value: string; version: string } | undefined };

/**
 * The records behind any number of `MemoryRecordStore` handles, as one remote is behind every host's clone. Tests open
 * a handle per host on one space, and `disconnect()` cuts every handle off, as an unreachable remote would.
 */
export class MemoryRecordSpace {
	readonly #changesets = new Map<string, MemoryChangeset>();
	#connected = true;

	/** Makes every call on every handle fail with `RecordError` `unreachable`. */
	disconnect(): void {
		this.#connected = false;
	}

	changeset(name: string): MemoryChangeset {
		if (!this.#connected) throw new RecordError("unreachable", "the memory record space is disconnected");
		let changeset = this.#changesets.get(name);
		if (changeset === undefined) {
			changeset = { records: new Map(), cell: undefined };
			this.#changesets.set(name, changeset);
		}
		return changeset;
	}
}

/** A record store in memory, for tests. Each handle on one `MemoryRecordSpace` sees every other handle's writes at once. */
export class MemoryRecordStore implements RecordStore {
	readonly #space: MemoryRecordSpace;
	#closed = false;

	constructor(space = new MemoryRecordSpace()) {
		this.#space = space;
	}

	#changeset(name: string): MemoryChangeset {
		if (this.#closed) throw new RecordError("closed", "the record store is closed");
		checkChangeset(name);
		return this.#space.changeset(name);
	}

	async add(records: RecordEnvelope[]): Promise<void> {
		const parsed = records.map((record) => SharedRecord.parse(record));
		for (const record of parsed) {
			const changeset = this.#changeset(record.changeset);
			if (changeset.cell?.value === disposalMark) throw disposedError(record.changeset);
			changeset.records.set(record.id, record.bytes);
		}
	}

	async list(changeset: string): Promise<RecordEnvelope[]> {
		return [...this.#changeset(changeset).records.values()].map((bytes) => JSON.parse(bytes) as RecordEnvelope);
	}

	async readCell(changeset: string): Promise<RecordCell> {
		const cell = this.#changeset(changeset).cell;
		return cell === undefined ? {} : { ...cell };
	}

	async writeCell(changeset: string, expectedVersion: string | undefined, value: string): Promise<boolean> {
		const entry = this.#changeset(changeset);
		if (entry.cell?.value === disposalMark) throw disposedError(changeset);
		if (entry.cell?.version !== expectedVersion) return false;
		entry.cell = { value, version: randomUUID() };
		return true;
	}

	async dispose(changeset: string): Promise<void> {
		const entry = this.#changeset(changeset);
		entry.cell = { value: disposalMark, version: randomUUID() };
		entry.records.clear();
	}

	async close(): Promise<void> {
		this.#closed = true;
	}
}
