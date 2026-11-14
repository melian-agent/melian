import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { RecordError } from "./errors.ts";
import { type PayloadChecks, type RecordEnvelope, SharedRecord } from "./record.ts";
import {
	checkCellValue,
	checkChangeset,
	disposalMark,
	disposedError,
	type RecordCell,
	type RecordStore,
} from "./record-store.ts";

const cellDirectory = ".cell";
const cellFile = /^[1-9][0-9]*$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Cell = { sequence: number; value: string };

function failure(code: "unknownFile" | "unreachable", path: string, cause?: unknown): RecordError {
	const says = code === "unknownFile" ? "is no record or cell this store wrote" : "cannot be read or written";
	return new RecordError(code, `${path} ${says}`, { path, cause });
}

function errorCode(error: unknown): unknown {
	return (error as { code?: unknown }).code;
}

/**
 * A record store in a plain directory, which proves the port leaks nothing of git. A record is a file at its
 * `record.path`, written under a temporary name and renamed. The cell is `changesets/<changeset>/.cell/<n>`, holding
 * the value, and its version is `n`: a write wins only by linking the next number from a complete temporary file, so a
 * writer that dies leaves at most a temporary file nothing reads, and the cell's directory is never removed, so no
 * number is used twice. Every call reads the directory itself, so `list` and `readCell` are fresh, and a store whose
 * `changesets` directory has gone fails every call with `RecordError` `unreachable`. A file whose path its own bytes do
 * not give fails `list` with `unknownFile`.
 */
export class DirectoryRecordStore implements RecordStore {
	readonly #root: string;
	readonly #payloads: PayloadChecks;
	#closed = false;

	private constructor(root: string, payloads: PayloadChecks) {
		this.#root = root;
		this.#payloads = payloads;
	}

	/** Opens the store at `root`, creating it when it is not there, to take the kinds `payloads` can check and a round. */
	static async open(root: string, payloads: PayloadChecks = {}): Promise<DirectoryRecordStore> {
		const absolute = resolve(root);
		try {
			await mkdir(join(absolute, "changesets"), { recursive: true });
			await mkdir(join(absolute, "tmp"), { recursive: true });
		} catch (cause) {
			throw failure("unreachable", absolute, cause);
		}
		return new DirectoryRecordStore(absolute, payloads);
	}

	async #reach(changeset: string): Promise<string> {
		if (this.#closed) throw new RecordError("closed", "the record store is closed");
		checkChangeset(changeset);
		const changesets = join(this.#root, "changesets");
		if (!(await lstat(changesets).catch(() => undefined))?.isDirectory()) throw failure("unreachable", changesets);
		const directory = join(changesets, changeset);
		await this.#directory(directory);
		return directory;
	}

	// Whether a real directory is at `path`. A link, even to a directory, or a file there is no directory this store made.
	async #directory(path: string): Promise<boolean> {
		const found = await lstat(path).catch((cause: unknown) => {
			if (errorCode(cause) !== "ENOENT") throw failure("unreachable", path, cause);
		});
		if (found !== undefined && !found.isDirectory()) throw failure("unknownFile", path);
		return found !== undefined;
	}

	async #make(path: string): Promise<void> {
		if (await this.#directory(path)) return;
		await mkdir(path).catch((cause: unknown) => {
			if (errorCode(cause) !== "EEXIST") throw failure("unreachable", path, cause);
		});
		await this.#directory(path);
	}

	async #entries(directory: string): Promise<Dirent[]> {
		try {
			return await readdir(directory, { withFileTypes: true });
		} catch (cause) {
			if (errorCode(cause) === "ENOENT") return [];
			throw failure("unreachable", directory, cause);
		}
	}

	async #text(path: string): Promise<string> {
		const bytes = await readFile(path).catch((cause: unknown) => {
			throw failure("unreachable", path, cause);
		});
		try {
			return utf8.decode(bytes);
		} catch (cause) {
			throw failure("unknownFile", path, cause);
		}
	}

	async #cell(directory: string): Promise<Cell | undefined> {
		const path = join(directory, cellDirectory);
		if (!(await this.#directory(path))) return undefined;
		let sequence = 0;
		for (const entry of await this.#entries(path)) {
			if (!cellFile.test(entry.name) || !Number.isSafeInteger(Number(entry.name)) || !entry.isFile())
				throw failure("unknownFile", join(path, entry.name));
			sequence = Math.max(sequence, Number(entry.name));
		}
		if (sequence === 0) return undefined;
		return { sequence, value: await this.#text(join(path, String(sequence))) };
	}

	async #temporary(bytes: string): Promise<string> {
		const directory = join(this.#root, "tmp");
		if (!(await lstat(directory).catch(() => undefined))?.isDirectory()) throw failure("unreachable", directory);
		const path = join(directory, randomUUID());
		await writeFile(path, bytes, { flag: "wx" }).catch((cause: unknown) => {
			throw failure("unreachable", path, cause);
		});
		return path;
	}

	async #swap(directory: string, cell: Cell | undefined, value: string): Promise<boolean> {
		await this.#make(directory);
		await this.#make(join(directory, cellDirectory));
		const next = (cell?.sequence ?? 0) + 1;
		if (!Number.isSafeInteger(next)) throw failure("unreachable", join(directory, cellDirectory));
		const temporary = await this.#temporary(value);
		try {
			await link(temporary, join(directory, cellDirectory, String(next)));
			return true;
		} catch (cause) {
			if (errorCode(cause) === "EEXIST") return false;
			throw failure("unreachable", join(directory, cellDirectory), cause);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	async add(records: RecordEnvelope[]): Promise<void> {
		for (const record of records.map((envelope) => SharedRecord.parse(envelope, this.#payloads))) {
			const directory = await this.#reach(record.changeset);
			if ((await this.#cell(directory))?.value === disposalMark) throw disposedError(record.changeset);
			const path = join(this.#root, record.path);
			const slot = join(path, "..");
			for (const each of [directory, join(slot, ".."), slot]) await this.#make(each);
			const temporary = await this.#temporary(record.bytes);
			try {
				await rename(temporary, path);
			} catch (cause) {
				await rm(temporary, { force: true });
				if ((await this.#cell(directory))?.value === disposalMark) throw disposedError(record.changeset);
				throw failure("unreachable", path, cause);
			}
			if ((await this.#cell(directory))?.value === disposalMark) {
				await rm(path, { force: true });
				throw disposedError(record.changeset);
			}
		}
	}

	async list(changeset: string): Promise<RecordEnvelope[]> {
		const directory = await this.#reach(changeset);
		const records: RecordEnvelope[] = [];
		for (const kind of await this.#entries(directory)) {
			if (kind.name === cellDirectory) continue;
			const kindPath = join(directory, kind.name);
			if (!kind.isDirectory()) throw failure("unknownFile", kindPath);
			for (const slot of await this.#entries(kindPath)) {
				const slotPath = join(kindPath, slot.name);
				if (!slot.isDirectory()) throw failure("unknownFile", slotPath);
				for (const file of await this.#entries(slotPath))
					records.push(await this.#record(join(slotPath, file.name), file));
			}
		}
		// A directory that vanished mid-walk read as empty, so the walk counts only if the store is still there after it,
		// and a disposed changeset lists nothing, though a dying add left a record after the mark.
		if ((await this.#cell(await this.#reach(changeset)))?.value === disposalMark) return [];
		return records;
	}

	async #record(path: string, file: Dirent): Promise<RecordEnvelope> {
		if (!file.isFile()) throw failure("unknownFile", path);
		const text = await this.#text(path);
		let record: SharedRecord;
		try {
			record = SharedRecord.read(text, basename(path, ".json"), this.#payloads);
		} catch (cause) {
			throw failure("unknownFile", path, cause);
		}
		if (join(this.#root, record.path) !== path) throw failure("unknownFile", path);
		return record.toJSON();
	}

	async readCell(changeset: string): Promise<RecordCell> {
		const cell = await this.#cell(await this.#reach(changeset));
		await this.#reach(changeset);
		return cell === undefined ? {} : { value: cell.value, version: String(cell.sequence) };
	}

	async writeCell(changeset: string, expectedVersion: string | undefined, value: string): Promise<boolean> {
		checkCellValue(value);
		const directory = await this.#reach(changeset);
		const cell = await this.#cell(directory);
		if (cell?.value === disposalMark) throw disposedError(changeset);
		if (cell?.sequence.toString() !== expectedVersion) return false;
		return this.#swap(directory, cell, value);
	}

	async dispose(changeset: string): Promise<void> {
		const directory = await this.#reach(changeset);
		for (;;) {
			const cell = await this.#cell(directory);
			if (cell?.value === disposalMark || (await this.#swap(directory, cell, disposalMark))) break;
		}
		for (const entry of await this.#entries(directory))
			if (entry.name !== cellDirectory) await rm(join(directory, entry.name), { recursive: true, force: true });
	}

	async close(): Promise<void> {
		this.#closed = true;
	}
}
