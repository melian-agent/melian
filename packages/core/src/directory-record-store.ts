import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { RecordError } from "./errors.ts";
import { type RecordEnvelope, SharedRecord } from "./record.ts";
import { checkChangeset, disposalMark, disposedError, type RecordCell, type RecordStore } from "./record-store.ts";

const cellDirectory = ".cell";
const cellFile = /^[1-9][0-9]*$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

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
		if (!(await stat(changesets).catch(() => undefined))?.isDirectory()) throw failure("unreachable", changesets);
		const directory = join(changesets, changeset);
		const found = await lstat(directory).catch((cause: unknown) => {
			if (errorCode(cause) !== "ENOENT") throw failure("unreachable", directory, cause);
		});
		if (found !== undefined && !found.isDirectory()) throw failure("unknownFile", directory);
		return directory;
	}

	async #entries(directory: string): Promise<Dirent[]> {
		try {
			return await readdir(directory, { withFileTypes: true });
		} catch (cause) {
			if (errorCode(cause) === "ENOENT") return [];
			throw failure(errorCode(cause) === "ENOTDIR" ? "unknownFile" : "unreachable", directory, cause);
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
		let sequence = 0;
		for (const entry of await this.#entries(path)) {
			if (!cellFile.test(entry.name) || !entry.isFile()) throw failure("unknownFile", join(path, entry.name));
			sequence = Math.max(sequence, Number(entry.name));
		}
		if (sequence === 0) return undefined;
		return { sequence, value: await this.#text(join(path, String(sequence))) };
	}

	async #temporary(bytes: string): Promise<string> {
		const path = join(this.#root, "tmp", randomUUID());
		await writeFile(path, bytes, { flag: "wx" }).catch((cause: unknown) => {
			throw failure("unreachable", path, cause);
		});
		return path;
	}

	async #swap(directory: string, cell: Cell | undefined, value: string): Promise<boolean> {
		await mkdir(join(directory, cellDirectory), { recursive: true });
		const temporary = await this.#temporary(value);
		try {
			await link(temporary, join(directory, cellDirectory, String((cell?.sequence ?? 0) + 1)));
			return true;
		} catch (cause) {
			if (errorCode(cause) === "EEXIST") return false;
			throw failure("unreachable", join(directory, cellDirectory), cause);
		} finally {
			await unlink(temporary);
		}
	}

	async add(records: RecordEnvelope[]): Promise<void> {
		for (const record of records.map((envelope) => SharedRecord.parse(envelope))) {
			const directory = await this.#reach(record.changeset);
			if ((await this.#cell(directory))?.value === disposalMark) throw disposedError(record.changeset);
			const path = join(this.#root, record.path);
			const temporary = await this.#temporary(record.bytes);
			try {
				await mkdir(join(path, ".."), { recursive: true });
				await rename(temporary, path);
			} catch (cause) {
				await rm(temporary, { force: true });
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
		if ((await this.#cell(directory))?.value === disposalMark) return [];
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
		return records;
	}

	async #record(path: string, file: Dirent): Promise<RecordEnvelope> {
		if (!file.isFile()) throw failure("unknownFile", path);
		const text = await this.#text(path);
		let record: SharedRecord;
		try {
			record = SharedRecord.read(text, basename(path, ".json"));
		} catch (cause) {
			throw failure("unknownFile", path, cause);
		}
		if (join(this.#root, record.path) !== path) throw failure("unknownFile", path);
		return record.toJSON();
	}

	async readCell(changeset: string): Promise<RecordCell> {
		const cell = await this.#cell(await this.#reach(changeset));
		return cell === undefined ? {} : { value: cell.value, version: String(cell.sequence) };
	}

	async writeCell(changeset: string, expectedVersion: string | undefined, value: string): Promise<boolean> {
		if (value === disposalMark) throw new RecordError("invalidCell", "only dispose writes the disposal mark");
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
