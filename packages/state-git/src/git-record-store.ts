import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	checkCellValue,
	checkChangeset,
	disposalMark,
	disposedError,
	type PayloadChecks,
	ProcessTable,
	type RecordCell,
	type RecordEnvelope,
	RecordError,
	type RecordStore,
	SharedRecord,
} from "@melian-agent/core";
import { type Clock, Deadline, systemClock } from "./deadline.ts";
import type { Processes } from "./owner.ts";
import { RecordRepository, type Sweep, type TreeChange } from "./repository.ts";
import { type Cell, cellBytes, cellPath, fileLimit, type Judged, StateTree } from "./state-tree.ts";

/** Where a {@link GitRecordStore} keeps its repository and which branch of which remote it holds. */
export type GitRecordStoreOptions = {
	/** The directory that holds the store's own bare repository, `records.git`: the clone's state directory. */
	readonly directory: string;
	/** The remote's URL, the clone's `origin`. */
	readonly remote: string;
	/** The branch, `melian/state` unless a test or a trial names another. */
	readonly branch?: string;
	/** The kinds `add` can check; a round needs none. */
	readonly payloads?: PayloadChecks;
	/** How long one call may take, two minutes unless given. */
	readonly deadlineMs?: number;
	readonly clock?: Clock;
	/** The process table the store reads to tell whose leftovers are stale, core's `ProcessTable` unless a test gives another. */
	readonly processes?: Processes;
};

// A lost race waits a random time below this bound, which doubles from the first to the last, past one push's time.
const firstBackoffMs = 50;
const defaultDeadlineMs = 120_000;
const lastBackoffMs = 8_000;

type Write<T> = { readonly changes: readonly TreeChange[]; readonly value: T };

/**
 * The record store of rule 12 of [the shared record
 * decision](../../../docs/decisions/2026-11-13-shared-record-behind-a-store-port.md), on a branch of a git remote. A
 * record is a plain JSON file at its `record.path` and a changeset's cell is `changesets/<changeset>/cell.json`. Every
 * call fetches the branch, its whole history, into the store's own repository, so it answers fresh or fails with
 * `RecordError` `unreachable`. A write builds one commit with git's plumbing and pushes it leased on the tip it fetched, retrying a
 * lost race until the deadline. A file the store did not write refuses every call on the changeset whose folder holds
 * it, or every call when it sits anywhere else, by [the amending decision](../../../docs/decisions/2026-11-14-git-record-store-refuses-by-location.md).
 */
export class GitRecordStore implements RecordStore {
	readonly #repository: RecordRepository;
	readonly #remote: string;
	readonly #branch: string;
	readonly #payloads: PayloadChecks;
	readonly #deadlineMs: number;
	readonly #clock: Clock;
	readonly #judged = new Map<string, Judged>();
	#closed = false;
	/** What opening the store swept from its directory, for `melian doctor` to report. */
	readonly sweep: Sweep;

	private constructor(repository: RecordRepository, sweep: Sweep, options: GitRecordStoreOptions) {
		this.#repository = repository;
		this.sweep = sweep;
		this.#remote = options.remote;
		this.#branch = options.branch ?? "melian/state";
		this.#payloads = options.payloads ?? {};
		this.#deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
		this.#clock = options.clock ?? systemClock;
	}

	/**
	 * Opens the store, creating its repository in `options.directory` when it is not there, and sweeps what calls whose
	 * process has gone left there. Reaches no remote.
	 */
	static async open(options: GitRecordStoreOptions): Promise<GitRecordStore> {
		const deadline = Deadline.after(options.clock ?? systemClock, options.deadlineMs ?? defaultDeadlineMs);
		const processes = options.processes ?? new ProcessTable();
		const repository = await RecordRepository.open(join(options.directory, "records.git"), deadline, processes);
		return new GitRecordStore(repository, await repository.sweep(deadline, processes), options);
	}

	#check(changeset: string): void {
		if (this.#closed) throw new RecordError("closed", "the record store is closed");
		checkChangeset(changeset);
	}

	#deadline(): Deadline {
		return Deadline.after(this.#clock, this.#deadlineMs);
	}

	async #tree(deadline: Deadline): Promise<{ tip: string | undefined; tree: StateTree }> {
		const tip = await this.#repository.fetch(this.#remote, this.#branch, deadline);
		return {
			tip,
			tree:
				tip === undefined
					? StateTree.empty()
					: await StateTree.read(this.#repository, this.#branch, tip, this.#judged, deadline),
		};
	}

	/**
	 * Every entry the branch holds that the store did not write, wherever it sits, for `melian doctor` to name. Reads
	 * and never pushes.
	 */
	async strays(): Promise<string[]> {
		if (this.#closed) throw new RecordError("closed", "the record store is closed");
		return (await this.#tree(this.#deadline())).tree.strays;
	}

	// Reads the tip, lets `decide` say what to change, and pushes one commit, until it lands or the deadline passes.
	async #write<T>(decide: (tree: StateTree) => Write<T>): Promise<T> {
		const deadline = this.#deadline();
		for (let bound = firstBackoffMs; ; bound = Math.min(bound * 2, lastBackoffMs)) {
			if (deadline.left() <= 0)
				throw new RecordError("unreachable", `no write to ${this.#branch} landed within its deadline`);
			const { tip, tree } = await this.#tree(deadline);
			const { changes, value } = decide(tree);
			if (changes.length === 0) return value;
			const commit = await this.#repository.commit(tip, changes, deadline);
			await StateTree.measure(this.#repository, this.#branch, commit, deadline);
			// A push ends by three quarters of what is left, inside the call's deadline, so the landed check keeps the rest.
			const push = deadline.within((deadline.left() * 3) / 4);
			const outcome = await this.#repository.push(this.#remote, this.#branch, commit, tip, push);
			if (outcome === "landed") return value;
			if (outcome === "stopped" && (await this.#landed(commit, tip, deadline))) return value;
			await deadline.sleep(Math.random() * bound);
		}
	}

	// Whether a push Melian stopped before git ended landed: its commit is the tip or an ancestor of it, in the whole
	// history the fetch brought. Only a tip that has moved without it proves it lost; an unmoved tip leaves it unsure.
	async #landed(commit: string, parent: string | undefined, deadline: Deadline): Promise<boolean> {
		try {
			const tip = await this.#repository.fetch(this.#remote, this.#branch, deadline);
			// The lease still holds, so a push whose transport outlived git, such as ssh, can land yet.
			if (tip === parent) throw new Error(`${this.#branch} has not moved since the push`);
			if (tip === undefined) return false;
			return await this.#repository.isAncestor(commit, tip, deadline);
		} catch (cause) {
			throw new RecordError(
				"unreachable",
				`a push to ${this.#branch} was stopped before git ended and may have landed; repeat the call`,
				{ cause },
			);
		}
	}

	async add(records: RecordEnvelope[]): Promise<void> {
		if (this.#closed) throw new RecordError("closed", "the record store is closed");
		const parsed = records.map((record) => SharedRecord.parse(record, this.#payloads));
		for (const record of parsed)
			if (Buffer.byteLength(record.bytes) > fileLimit)
				throw new RecordError("invalidRecord", `a record is at most ${fileLimit} bytes`);
		if (parsed.length === 0) return;
		await this.#write((tree) => {
			for (const changeset of new Set(parsed.map((record) => record.changeset))) {
				tree.refuse(changeset);
				if (tree.disposed(changeset)) throw disposedError(changeset);
			}
			const missing = new Map(
				parsed.filter((record) => !tree.has(record)).map((record) => [record.path, record.bytes]),
			);
			return { changes: [...missing].map(([path, bytes]) => ({ path, bytes })), value: undefined };
		});
	}

	async list(changeset: string): Promise<RecordEnvelope[]> {
		this.#check(changeset);
		const { tree } = await this.#tree(this.#deadline());
		tree.refuse(changeset);
		if (tree.disposed(changeset)) return [];
		return tree.records(changeset).map((record) => record.toJSON());
	}

	async readCell(changeset: string): Promise<RecordCell> {
		this.#check(changeset);
		const { tree } = await this.#tree(this.#deadline());
		tree.refuse(changeset);
		const cell = tree.cell(changeset);
		return cell === undefined ? {} : { value: cell.value, version: cell.version };
	}

	async writeCell(changeset: string, expectedVersion: string | undefined, value: string): Promise<boolean> {
		checkCellValue(value);
		if (Buffer.byteLength(cellBytes({ value, version: randomUUID() })) > fileLimit)
			throw new RecordError("invalidCell", `a cell is at most ${fileLimit} bytes`);
		this.#check(changeset);
		return this.#write((tree) => {
			tree.refuse(changeset);
			if (tree.disposed(changeset)) throw disposedError(changeset);
			if (tree.cell(changeset)?.version !== expectedVersion) return { changes: [], value: false };
			return { changes: [cellChange(changeset, { value, version: randomUUID() })], value: true };
		});
	}

	async dispose(changeset: string): Promise<void> {
		this.#check(changeset);
		await this.#write((tree) => {
			tree.refuse(changeset);
			const removals = tree.records(changeset).map((record) => ({ path: record.path, bytes: null }));
			const mark = tree.disposed(changeset)
				? []
				: [cellChange(changeset, { value: disposalMark, version: randomUUID() })];
			return { changes: [...mark, ...removals], value: undefined };
		});
	}

	async close(): Promise<void> {
		this.#closed = true;
	}
}

function cellChange(changeset: string, cell: Cell): TreeChange {
	return { path: cellPath(changeset), bytes: cellBytes(cell) };
}
