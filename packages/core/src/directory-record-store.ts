import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RecordError } from "./errors.ts";
import { type RecordEnvelope, SharedRecord } from "./record.ts";
import { checkChangeset, disposalMark, disposedError, type RecordCell, type RecordStore } from "./record-store.ts";

const recordFile = /^([0-9a-f]{64})\.json$/;
const cellFile = /^([1-9][0-9]*)\.json$/;
const cellDirectory = ".cell";
const utf8 = new TextDecoder("utf-8", { fatal: true });

type Cell = { sequence: number; value: string; version: string };

function code(error: unknown): unknown {
	return (error as { code?: unknown }).code;
}

function absent(error: unknown): boolean {
	return code(error) === "ENOENT";
}

function unknownFile(path: string, cause?: unknown): RecordError {
	return new RecordError("unknownFile", `${path} is no record or cell the store wrote`, { path, cause });
}

function unreadable(path: string, cause: unknown): RecordError {
	return new RecordError("unreachable", `${path} could not be read`, { path, cause });
}

/**
 * A record store in a plain directory, which proves the port leaks nothing of git. A record is a file at its
 * `record.path`, written under a temporary name and renamed. The cell is a directory of numbered versions, each
 * linked into place from a complete temporary file, so a write wins only by creating the next number, and a writer
 * that dies leaves at most a temporary file nothing reads. Every call reads the directory itself, so `list` and
 * `readCell` are fresh, and a store whose directory has gone fails every call with `RecordError` `unreachable`. A file
 * whose path its own bytes do not give fails `list` with `unknownFile`.
 */
export class DirectoryRecordStore implements RecordStore {
	readonly #root: string;
	#closed = false;

	private constructor(root: string) {
		this.#root = root;
	}

	/** Opens the store at `root`, creating it when it is not there. */
	static async open(root: string): Promise<DirectoryRecordStore> {
		const absolute = resolve(root);
		await mkdir(join(absolute, "changesets"), { recursive: true });
		await mkdir(join(absolute, "tmp"), { recursive: true });
		return new DirectoryRecordStore(absolute);
	}

	async #reach(changeset: string): Promise<string> {
		if (this.#closed) throw new RecordError("closed", "the record store is closed");
		checkChangeset(changeset);
		const changesets = join(this.#root, "changesets");
		const found = await stat(changesets).catch((cause: unknown) => {
			throw new RecordError("unreachable", `${changesets} cannot be reached`, { path: changesets, cause });
		});
		if (!found.isDirectory())
			throw new RecordError("unreachable", `${changesets} is no directory`, { path: changesets });
		return join(changesets, changeset);
	}

	async #temporary(bytes: string): Promise<string> {
		const path = join(this.#root, "tmp", randomUUID());
		await writeFile(path, bytes, { flag: "wx" });
		return path;
	}

	async #entries(directory: string): Promise<Dirent[]> {
		try {
			return await readdir(directory, { withFileTypes: true });
		} catch (cause) {
			if (absent(cause)) return [];
			if (code(cause) === "ENOTDIR") throw unknownFile(directory, cause);
			throw unreadable(directory, cause);
		}
	}

	async #cell(directory: string): Promise<Cell | undefined> {
		const path = join(directory, cellDirectory);
		let latest = 0;
		for (const entry of await this.#entries(path)) {
			const sequence = cellFile.exec(entry.name)?.[1];
			if (sequence === undefined || !entry.isFile()) throw unknownFile(join(path, entry.name));
			latest = Math.max(latest, Number(sequence));
		}
		if (latest === 0) return undefined;
		const file = join(path, `${latest}.json`);
		const stored = await readFile(file).catch((cause: unknown) => {
			throw unreadable(file, cause);
		});
		try {
			const { value, version, ...rest } = JSON.parse(utf8.decode(stored)) as Record<string, unknown>;
			if (typeof value === "string" && typeof version === "string" && Object.keys(rest).length === 0) {
				return { sequence: latest, value, version };
			}
		} catch (cause) {
			throw unknownFile(file, cause);
		}
		throw unknownFile(file);
	}

	async add(records: RecordEnvelope[]): Promise<void> {
		for (const record of records.map((envelope) => SharedRecord.parse(envelope))) {
			const directory = await this.#reach(record.changeset);
			const path = join(this.#root, record.path);
			await mkdir(join(path, ".."), { recursive: true });
			await rename(await this.#temporary(record.bytes), path);
			if ((await this.#cell(directory))?.value === disposalMark) {
				await rm(path, { force: true });
				throw disposedError(record.changeset);
			}
		}
	}

	async list(changeset: string): Promise<RecordEnvelope[]> {
		const directory = await this.#reach(changeset);
		const records: RecordEnvelope[] = [];
		const kinds = await lstat(directory).then(
			(found) => (found.isDirectory() ? this.#entries(directory) : Promise.reject(unknownFile(directory))),
			(cause: unknown) => (absent(cause) ? [] : Promise.reject(unreadable(directory, cause))),
		);
		for (const kind of kinds) {
			const kindPath = join(directory, kind.name);
			if (!kind.isDirectory()) throw unknownFile(kindPath);
			if (kind.name === cellDirectory) {
				await this.#cell(directory);
				continue;
			}
			for (const slot of await this.#entries(kindPath)) {
				const slotPath = join(kindPath, slot.name);
				if (!slot.isDirectory()) throw unknownFile(slotPath);
				for (const file of await this.#entries(slotPath)) {
					records.push(await this.#record(join(slotPath, file.name), file));
				}
			}
		}
		return records;
	}

	async #record(path: string, file: Dirent): Promise<RecordEnvelope> {
		const id = recordFile.exec(file.name)?.[1];
		if (id === undefined || !file.isFile()) throw unknownFile(path);
		const stored = await readFile(path).catch((cause: unknown) => {
			throw unreadable(path, cause);
		});
		let record: SharedRecord;
		try {
			record = SharedRecord.read(utf8.decode(stored), id);
		} catch (cause) {
			throw unknownFile(path, cause);
		}
		if (join(this.#root, record.path) !== path) throw unknownFile(path);
		return record.toJSON();
	}

	async readCell(changeset: string): Promise<RecordCell> {
		const cell = await this.#cell(await this.#reach(changeset));
		return cell === undefined ? {} : { value: cell.value, version: cell.version };
	}

	async writeCell(changeset: string, expectedVersion: string | undefined, value: string): Promise<boolean> {
		const directory = await this.#reach(changeset);
		const cell = await this.#cell(directory);
		if (cell?.value === disposalMark) throw disposedError(changeset);
		if (cell?.version !== expectedVersion) return false;
		await mkdir(join(directory, cellDirectory), { recursive: true });
		const temporary = await this.#temporary(JSON.stringify({ value, version: randomUUID() }));
		try {
			await link(temporary, join(directory, cellDirectory, `${(cell?.sequence ?? 0) + 1}.json`));
			return true;
		} catch (cause) {
			if (code(cause) === "EEXIST") return false;
			throw new RecordError("unreachable", `the cell of ${changeset} could not be written`, { cause });
		} finally {
			await unlink(temporary);
		}
	}

	async dispose(changeset: string): Promise<void> {
		const directory = await this.#reach(changeset);
		for (;;) {
			const cell = await this.#cell(directory);
			if (cell?.value === disposalMark || (await this.#mark(changeset, cell?.version))) break;
		}
		for (const entry of await this.#entries(directory)) {
			if (entry.name !== cellDirectory) await rm(join(directory, entry.name), { recursive: true, force: true });
		}
	}

	async #mark(changeset: string, version: string | undefined): Promise<boolean> {
		try {
			return await this.writeCell(changeset, version, disposalMark);
		} catch (cause) {
			if (cause instanceof RecordError && cause.code === "disposed") return true;
			throw cause;
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
	}
}
