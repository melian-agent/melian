import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RecordError, type RecordStore, reviewPayloads, SharedRecord } from "@melian-agent/core";

/** The most a relay reads from the head's job: files, bytes in one file, and bytes in all. */
export const relayLimits = { files: 4096, fileBytes: 4 * 1024 * 1024, bytes: 64 * 1024 * 1024 } as const;

/** Why a relay refused its whole batch. */
export type RelayRefusalCode =
	| "strayEntry"
	| "otherChangeset"
	| "tooManyFiles"
	| "fileTooLarge"
	| "batchTooLarge"
	| "unreadable"
	| "invalidRecord"
	| "misplaced"
	| "refusedKind"
	| "otherRevision"
	| "signed"
	| "unresolvedRead";

const says: Record<RelayRefusalCode, string> = {
	strayEntry: "is no record file a review's directory store writes",
	otherChangeset: "belongs to another changeset than the run's",
	tooManyFiles: `passes the relay's bound of ${relayLimits.files} files`,
	fileTooLarge: `is larger than the relay's bound of ${relayLimits.fileBytes} bytes`,
	batchTooLarge: `takes the batch past the relay's bound of ${relayLimits.bytes} bytes`,
	unreadable: "cannot be read",
	invalidRecord: "is not a record Melian's reader accepts",
	misplaced: "is filed at a path its own bytes do not give",
	refusedKind: "is a kind of record the head's job may not hand over",
	otherRevision: "names another revision than the run's",
	signed: "carries a signature, and no repository key exists to check one",
	unresolvedRead: "is a round that reads a record in neither the batch nor the store",
};

/**
 * The relay refused the whole batch, and added nothing. `file` is the artefact path the refusal is about, and the
 * message names it and the code, never anything a record holds, since the head's code may have written it.
 */
export class RelayRefusal extends Error {
	readonly code: RelayRefusalCode;
	readonly file: string;
	readonly recordCode?: string;

	constructor(code: RelayRefusalCode, file: string, recordCode?: string) {
		super(`melian records relay refused the batch: ${file} ${says[code]}${recordCode ? ` (${recordCode})` : ""}`);
		this.name = "RelayRefusal";
		this.code = code;
		this.file = file;
		if (recordCode !== undefined) this.recordCode = recordCode;
	}
}

/** The run a batch came from, as Melian's own code worked it out from the pull request, never from the batch. */
export type RelayRun = { readonly changeset: string; readonly revision: string; readonly fork: boolean };

const hex64 = /^[0-9a-f]{64}$/;
const recordFile = /^([0-9a-f]{64})\.json$/;

// Lists a directory without following a link. A link, even to a directory, is no entry a directory store writes.
async function entries(root: string, path: string): Promise<Dirent[]> {
	try {
		return await readdir(join(root, path), { withFileTypes: true });
	} catch {
		throw new RelayRefusal("unreadable", path);
	}
}

/**
 * The records the job that ran a pull request's head left in a directory store, checked whole by rule 6 of [the shared
 * record decision](../../../docs/decisions/2026-11-13-shared-record-behind-a-store-port.md) before any reaches a store.
 */
export class RelayBatch {
	readonly run: RelayRun;
	readonly records: readonly SharedRecord[];

	private constructor(run: RelayRun, records: readonly SharedRecord[]) {
		this.run = run;
		this.records = records;
	}

	/**
	 * Reads the directory store at `root` for `run`, measuring every file before it reads one, and throws `RelayRefusal`
	 * at the first file it refuses.
	 */
	static async read(root: string, run: RelayRun): Promise<RelayBatch> {
		const files = await RelayBatch.#files(root, run.changeset);
		let total = 0;
		for (const file of files) {
			let size: number;
			try {
				size = (await lstat(join(root, file))).size;
			} catch {
				throw new RelayRefusal("unreadable", file);
			}
			if (size > relayLimits.fileBytes) throw new RelayRefusal("fileTooLarge", file);
			total += size;
			if (total > relayLimits.bytes) throw new RelayRefusal("batchTooLarge", file);
		}
		const records: SharedRecord[] = [];
		for (const file of files) records.push(await RelayBatch.#record(root, file, run));
		return new RelayBatch(run, records);
	}

	// Every record file under the run's changeset, by path relative to `root`, refusing anything else the tree holds.
	static async #files(root: string, changeset: string): Promise<string[]> {
		const files: string[] = [];
		for (const top of await entries(root, ".")) {
			if (top.name === "tmp" && top.isDirectory() && (await entries(root, "tmp")).length === 0) continue;
			if (top.name !== "changesets" || !top.isDirectory()) throw new RelayRefusal("strayEntry", top.name);
		}
		for (const folder of await entries(root, "changesets")) {
			const path = `changesets/${folder.name}`;
			if (!folder.isDirectory()) throw new RelayRefusal("strayEntry", path);
			if (folder.name !== changeset) throw new RelayRefusal("otherChangeset", path);
			for (const kind of await entries(root, path)) {
				const kindPath = `${path}/${kind.name}`;
				if (!kind.isDirectory() || kind.name.startsWith(".")) throw new RelayRefusal("strayEntry", kindPath);
				for (const slot of await entries(root, kindPath)) {
					const slotPath = `${kindPath}/${slot.name}`;
					if (!slot.isDirectory() || !hex64.test(slot.name)) throw new RelayRefusal("strayEntry", slotPath);
					for (const file of await entries(root, slotPath)) {
						const filePath = `${slotPath}/${file.name}`;
						if (!file.isFile() || !recordFile.test(file.name)) throw new RelayRefusal("strayEntry", filePath);
						files.push(filePath);
						if (files.length > relayLimits.files) throw new RelayRefusal("tooManyFiles", filePath);
					}
				}
			}
		}
		return files;
	}

	static async #record(root: string, file: string, run: RelayRun): Promise<SharedRecord> {
		let bytes: string;
		try {
			bytes = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(join(root, file)));
		} catch {
			throw new RelayRefusal("invalidRecord", file);
		}
		const id = (recordFile.exec(file.slice(file.lastIndexOf("/") + 1)) as RegExpExecArray)[1] as string;
		let record: SharedRecord;
		try {
			record = SharedRecord.readEnvelope(bytes, id);
		} catch (error) {
			throw new RelayRefusal("invalidRecord", file, error instanceof RecordError ? error.code : undefined);
		}
		if (record.path !== file) throw new RelayRefusal("misplaced", file);
		// The kind is refused before the payload is read, so no check of the head's choosing runs on a kind it may not send.
		const own = { ...run, changeset: record.changeset, revision: record.revision ?? "" };
		if (record.refusedFromHeadCode(own) !== undefined) throw new RelayRefusal("refusedKind", file);
		if (record.refusedFromHeadCode(run) !== undefined) throw new RelayRefusal("otherRevision", file);
		if (record.signer !== undefined) throw new RelayRefusal("signed", file);
		try {
			return record.checked(reviewPayloads);
		} catch (error) {
			throw new RelayRefusal("invalidRecord", file, error instanceof RecordError ? error.code : undefined);
		}
	}

	/**
	 * Adds the batch to `store` in one call, after checking that every record a round reads is in the batch or the
	 * store. A refusal adds nothing; a failure of `add` lands nothing, or a part a repeat completes, by the port's
	 * contract.
	 */
	async into(store: RecordStore): Promise<void> {
		const held = new Set(this.records.map((record) => record.id));
		const stored = new Set((await store.list(this.run.changeset)).map((each) => SharedRecord.parseEnvelope(each).id));
		for (const record of this.records) {
			const manifest = record.manifest();
			if (manifest === undefined) continue;
			const named = [
				...manifest.read.map((each) => each.id),
				...(manifest.walkthrough ? [manifest.walkthrough.id] : []),
			];
			if (named.some((id) => !held.has(id) && !stored.has(id)))
				throw new RelayRefusal("unresolvedRead", record.path);
		}
		await store.add(this.records.map((record) => record.toJSON()));
	}
}
