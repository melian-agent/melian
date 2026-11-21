import type { Dirent } from "node:fs";
import { lstat, opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AccountPayload,
	type CheckPayload,
	type LegacyAccountPayload,
	type LensPayload,
	RecordError,
	type RecordStore,
	type RoundManifest,
	recordLimit,
	reviewPayloads,
	SharedRecord,
	type TierAccount,
	type TriagePayload,
	type VerificationPayload,
} from "@melian-agent/core";
import { roundFacts } from "./review-records.ts";

/**
 * The most a relay reads from the head's job: files, bytes in one file, bytes in all, and triage and telemetry records
 * beside the round. A file may be as large as the store's record limit itself, so the relay hands over any record a
 * store keeps. The batch is two such records, one full record and as much again for the rest, which is 1/32 of the git
 * store's 256 MiB tip, so a few rounds cannot fill the branch.
 */
export const relayLimits = {
	entries: 2048,
	files: 512,
	fileBytes: recordLimit,
	bytes: 2 * recordLimit,
	extras: 64,
} as const;

/** Why a relay refused its whole batch. */
export type RelayRefusalCode =
	| "strayEntry"
	| "otherChangeset"
	| "tooManyEntries"
	| "tooManyFiles"
	| "fileTooLarge"
	| "batchTooLarge"
	| "unreadable"
	| "invalidRecord"
	| "misplaced"
	| "refusedKind"
	| "otherRevision"
	| "signed"
	| "unresolvedRead"
	| "roundCount"
	| "roundShape"
	| "unnamedRecord"
	| "tooManyExtras"
	| "triageCount"
	| "otherTelemetry"
	| "accountCount"
	| "tierAccount"
	| "otherCheck"
	| "notHeadCode";

const says: Record<RelayRefusalCode, string> = {
	strayEntry: "is no record file a review's directory store writes",
	otherChangeset: "belongs to another changeset than the run's",
	tooManyEntries: `passes the relay's bound of ${relayLimits.entries} entries`,
	tooManyFiles: `passes the relay's bound of ${relayLimits.files} files`,
	fileTooLarge: `is larger than the relay's bound of ${relayLimits.fileBytes} bytes`,
	batchTooLarge: `takes the batch past the relay's bound of ${relayLimits.bytes} bytes`,
	unreadable: "cannot be read",
	invalidRecord: "is not a record Melian's reader accepts",
	misplaced: "is filed at a path its own bytes do not give",
	refusedKind: "is a kind of record the head's job may not hand over",
	otherRevision: "names another revision than the run's",
	signed: "carries a signature, and no repository key exists to check one",
	unresolvedRead: "is a round that reads a record the batch does not hold",
	roundCount: "leaves a writer's batch with no round, or more than one",
	roundShape: "is a round that names a walkthrough, or rounds it replaces or follows",
	unnamedRecord: "is a record the batch's round does not name, and no triage, telemetry or early lens copy of it",
	tooManyExtras: `takes the batch past the relay's bound of ${relayLimits.extras} triage, telemetry and early lens records`,
	triageCount: "is a second triage decision, and a review decides triage once a round",
	otherTelemetry: "is another round's telemetry, and a round names no telemetry",
	accountCount: "is a round that reads no account, or more than one",
	tierAccount: "is a round whose account differs from what the base's tier and the round's own records give",
	otherCheck: "names a check the base's tier does not give",
	notHeadCode: "is a check the job that holds the keys runs itself, so a fork's job may not hand it over",
};

const hex64 = /^[0-9a-f]{64}$/;
const recordFile = /^([0-9a-f]{64})\.json$/;

// The head's code names the artefact's files, so a refusal names one only by a record ID, which holds nothing it chose.
function printable(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return recordFile.test(name) ? name : "an entry not named for a record ID";
}

/**
 * The relay refused the whole batch, and added nothing. `file` names the entry the refusal is about by its record ID,
 * or says it has none; neither it nor the message carries anything a record or a file name holds.
 */
export class RelayRefusal extends Error {
	readonly code: RelayRefusalCode;
	readonly file: string;
	readonly recordCode?: string;

	constructor(code: RelayRefusalCode, file: string, recordCode?: string) {
		const named = printable(file);
		super(`melian records relay refused the batch: ${named} ${says[code]}${recordCode ? ` (${recordCode})` : ""}`);
		this.name = "RelayRefusal";
		this.code = code;
		this.file = named;
		if (recordCode !== undefined) this.recordCode = recordCode;
	}
}

/**
 * The run a batch came from, as Melian's own code worked it out from the pull request, never from the batch: its
 * changeset, its revision, whether its head is a fork's, and the account of the tier the base's policy names.
 */
export type RelayRun = {
	readonly changeset: string;
	readonly revision: string;
	readonly fork: boolean;
	readonly tier: TierAccount;
	/** The checks whose records a fork's job may hand over: those that run the head's code, as `headCodeChecks` names. */
	readonly handedOver: readonly string[];
};

// Lists a store's directories without following a link, which is no entry a directory store writes. It reads one entry
// at a time and counts every entry of the walk, so a folder of a million entries costs no more than the bound.
class TreeWalk {
	readonly root: string;
	#walked = 0;

	constructor(root: string) {
		this.root = root;
	}

	async entries(path: string): Promise<Dirent[]> {
		const listed: Dirent[] = [];
		try {
			for await (const entry of await opendir(join(this.root, path))) {
				this.#walked += 1;
				if (this.#walked > relayLimits.entries) throw new RelayRefusal("tooManyEntries", `${path}/${entry.name}`);
				listed.push(entry);
			}
		} catch (error) {
			if (error instanceof RelayRefusal) throw error;
			throw new RelayRefusal("unreadable", path);
		}
		return listed;
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
		if (!run.fork) RelayBatch.#rests(records, run.tier);
		return new RelayBatch(run, records);
	}

	// A writer's batch is one round and what it rests on: every record the round reads, held here at the run's revision,
	// and a bounded number of triage records, the round's telemetry, and early copies of the lens runs it reads. The
	// round sets no other round aside, and its account is the one the base's tier gives for the records it counts.
	static #rests(records: readonly SharedRecord[], tier: TierAccount): void {
		const rounds = records.filter((record) => record.kind === "round");
		const round = rounds[0];
		if (round === undefined || rounds.length > 1)
			throw new RelayRefusal("roundCount", (rounds[1] ?? records[0])?.path ?? "");
		const manifest = round.manifest() as RoundManifest;
		if (manifest.walkthrough !== null || manifest.replaces.length > 0 || manifest.before.length > 0)
			throw new RelayRefusal("roundShape", round.path);
		const held = new Map(records.map((record) => [record.id, record]));
		for (const named of manifest.read) {
			const record = held.get(named.id);
			if (record === undefined || record.kind !== named.kind || record.key !== named.key)
				throw new RelayRefusal("unresolvedRead", round.path);
		}
		const read = new Set(manifest.read.map((named) => named.id));
		const lensKeys = new Set(manifest.read.filter((named) => named.kind === "lens").map((named) => named.key));
		// A lens run's copy exported as the lens ended, with no check, under the key of the run the round reads.
		const early = (record: SharedRecord) =>
			record.kind === "lens" && (record.payload as LensPayload).check === null && lensKeys.has(record.key);
		// Triage, the round's telemetry and early lens copies count against the bound whether or not the round names them.
		const extra = (record: SharedRecord) =>
			record.kind === "triage" || (record.kind === "telemetry" && record.key === round.id) || early(record);
		let extras = 0;
		for (const record of records) {
			if (record === round) continue;
			if (!extra(record)) {
				if (!read.has(record.id)) throw new RelayRefusal("unnamedRecord", record.path);
				// Telemetry is written after its round, so a round that names some names another round's, uncounted.
				if (record.kind === "telemetry") throw new RelayRefusal("otherTelemetry", record.path);
				continue;
			}
			if (++extras > relayLimits.extras) throw new RelayRefusal("tooManyExtras", record.path);
		}
		// A review decides triage once a round, so a second decision could only choose which one the account's facts read.
		const decided = records.filter(
			(record) => record.kind === "triage" && (record.payload as TriagePayload).decision !== null,
		);
		if (decided.length > 1) throw new RelayRefusal("triageCount", decided[1]!.path);
		const accounts = manifest.read.filter((named) => named.kind === "account");
		const account = accounts.length === 1 ? held.get(accounts[0]!.id) : undefined;
		if (account === undefined) throw new RelayRefusal("accountCount", round.path);
		const claim = account.payload as AccountPayload | LegacyAccountPayload;
		const counted = claim.records.map((id) => (read.has(id) ? held.get(id) : undefined));
		if (counted.some((record) => record === undefined)) throw new RelayRefusal("unresolvedRead", account.path);
		const refusal = tier.refusal(claim, roundFacts(counted as SharedRecord[], claim));
		if (refusal !== undefined) throw new RelayRefusal("tierAccount", round.path, refusal);
	}

	// Every record file under the run's changeset, by path relative to `root`, refusing anything else the tree holds.
	static async #files(root: string, changeset: string): Promise<string[]> {
		const files: string[] = [];
		const walk = new TreeWalk(root);
		for (const top of await walk.entries(".")) {
			if (top.name === "tmp" && top.isDirectory() && (await walk.entries("tmp")).length === 0) continue;
			if (top.name !== "changesets" || !top.isDirectory()) throw new RelayRefusal("strayEntry", top.name);
		}
		for (const folder of await walk.entries("changesets")) {
			const path = `changesets/${folder.name}`;
			if (!folder.isDirectory()) throw new RelayRefusal("strayEntry", path);
			if (folder.name !== changeset) throw new RelayRefusal("otherChangeset", path);
			for (const kind of await walk.entries(path)) {
				const kindPath = `${path}/${kind.name}`;
				if (!kind.isDirectory() || kind.name.startsWith(".")) throw new RelayRefusal("strayEntry", kindPath);
				// The store makes a folder only for a record it adds, and an empty one counts against no bound.
				const slots = await walk.entries(kindPath);
				if (slots.length === 0) throw new RelayRefusal("strayEntry", kindPath);
				for (const slot of slots) {
					const slotPath = `${kindPath}/${slot.name}`;
					if (!slot.isDirectory() || !hex64.test(slot.name)) throw new RelayRefusal("strayEntry", slotPath);
					const held = await walk.entries(slotPath);
					if (held.length === 0) throw new RelayRefusal("strayEntry", slotPath);
					for (const file of held) {
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
		let checked: SharedRecord;
		try {
			checked = record.checked(reviewPayloads);
		} catch (error) {
			throw new RelayRefusal("invalidRecord", file, error instanceof RecordError ? error.code : undefined);
		}
		// The payload schema takes a check's name as free text, since the names come from a configuration it does not
		// hold. The relay holds the base's, so this is where a check name is closed.
		if (RelayBatch.#checkNames(checked).some((name) => !run.tier.checks.includes(name)))
			throw new RelayRefusal("otherCheck", file);
		if (run.fork && RelayBatch.#checkNames(checked).some((name) => !run.handedOver.includes(name)))
			throw new RelayRefusal("notHeadCode", file);
		return checked;
	}

	// Every check a record names beyond what its schema ties to its kind: a check record's own, a lens record's lens, whose
	// check the schema names for it, each producer a verification holds claims of, and each check an account filled or
	// counts findings from.
	static #checkNames(record: SharedRecord): string[] {
		switch (record.kind) {
			case "check":
				return [(record.payload as CheckPayload).result.name];
			case "lens":
				return [`lens.${(record.payload as LensPayload).name}`];
			case "verification":
				return (record.payload as VerificationPayload).claims.map((claim) => claim.source.check);
			// The account's `checks` are the tier's by `TierAccount.refusal`, which reads them; its filled records and producers
			// are not, and a filled record is the verifier's when it failed or was skipped before any verification record.
			case "account": {
				const { filled, producers } = record.payload as AccountPayload | LegacyAccountPayload;
				return [
					...filled.map((each) => each.name).filter((name) => name !== "verifier"),
					...producers.map((each) => each.check),
				];
			}
			default:
				return [];
		}
	}

	/**
	 * Adds the batch to `store` in one call. A failure of `add` lands nothing, or a part a repeat completes, by the port's
	 * contract.
	 */
	async into(store: RecordStore): Promise<void> {
		await store.add(this.records.map((record) => record.toJSON()));
	}
}
