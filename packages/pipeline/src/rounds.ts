import { createHash } from "node:crypto";
import { type StoredVerdict, Verdict } from "@melian-agent/core";
import { VerdictDocument } from "./adjudication.ts";
import { ComparisonDocument } from "./compare.ts";
import {
	backgroundContext,
	type Context,
	type ConversationId,
	defineDoc,
	type JsonObject,
	ROOT_CONVERSATION_ID,
	type Storage,
	type Tx,
} from "./harness.ts";

type Provenance = NonNullable<ReturnType<typeof VerdictDocument.definition.initial>["provenance"]>[string];
type StoredRound = {
	base: string;
	head: string;
	mintedAt?: string;
	checkRun?: string;
	tasks: number[];
	verdict?: StoredVerdict;
	provenance?: Provenance;
};
type RoundState = {
	sequence: number;
	current: Record<string, string>;
	items: Record<string, StoredRound>;
	recorded: Record<string, boolean>;
};

/** A round document cannot be read by this version of Melian. */
export class RoundError extends Error {
	readonly code = "unreadable";

	constructor(message: string) {
		super(message);
		this.name = "RoundError";
	}
}

// Keys are local to this storage; the public ID prefixes them with the changeset ID of its SQLite file.
export const RoundsDocument = defineDoc<RoundState>({
	kind: "melian.rounds",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ sequence: 0, current: {}, items: {}, recorded: {} }),
});

export function legacyKey(revision: string): string {
	return `k${createHash("sha256").update(revision).digest("hex").slice(0, 16)}`;
}

function legacyRound(key: string, verdict?: StoredVerdict, provenance?: Provenance): StoredRound {
	const [base, head] = key.split("..");
	return {
		base: base!,
		head: head!,
		tasks: [],
		...(verdict === undefined ? {} : { verdict }),
		...(provenance === undefined ? {} : { provenance }),
	};
}

// Every writer reads the legacy-first marker and the old verdict through its own transaction.
export class RoundWriter {
	readonly tx: Tx;
	readonly root: ConversationId;

	constructor(tx: Tx, root: ConversationId) {
		this.tx = tx;
		this.root = root;
	}

	async preserve(revision: string): Promise<RoundState> {
		const state = await this.tx.doc(RoundsDocument, this.root);
		if (state.recorded[revision]) return state;
		const live = await this.tx.doc(VerdictDocument, this.root);
		const comparisons = await this.tx.doc(ComparisonDocument, this.root);
		if (Object.hasOwn(live.verdicts, revision) || Object.hasOwn(comparisons.comparisons, revision)) {
			const key = legacyKey(revision);
			state.items[key] = legacyRound(revision, live.verdicts[revision], live.provenance?.[revision]);
			state.current[revision] = key;
		}
		state.recorded[revision] = true;
		return state;
	}

	async checkRun(task: number, legacyCheckRun?: string): Promise<string | undefined> {
		const state = await this.tx.doc(RoundsDocument, this.root);
		const round = Object.values(state.items).find((round) => round.tasks.includes(task));
		return round?.mintedAt === undefined ? (round?.checkRun ?? legacyCheckRun) : round.checkRun;
	}

	async mint(revision: string, task: number, at: string, checkRun?: string): Promise<void> {
		const state = await this.preserve(revision);
		const key = `r${++state.sequence}`;
		state.items[key] = {
			...legacyRound(revision),
			mintedAt: at,
			tasks: [task],
			...(checkRun === undefined ? {} : { checkRun }),
		};
		state.current[revision] = key;
		const live = await this.tx.doc(VerdictDocument, this.root);
		delete live.verdicts[revision];
		if (live.provenance !== undefined) delete live.provenance[revision];
		if (live.decisions !== undefined) delete live.decisions[revision];
	}

	async keep(revision: string, task: number, checkRun?: string): Promise<StoredRound> {
		const state = await this.preserve(revision);
		const key = state.current[revision] ?? legacyKey(revision);
		state.current[revision] = key;
		state.items[key] ??= legacyRound(revision);
		const round = state.items[key];
		round.checkRun ??= checkRun;
		if (!round.tasks.includes(task)) round.tasks.push(task);
		return round;
	}

	async record(revision: string, task: number, verdict: StoredVerdict, provenance: Provenance): Promise<void> {
		const owned = await this.keep(revision, task);
		owned.verdict = verdict;
		owned.provenance = provenance;
	}
}

/** One stored review round, including an undecided round with no verdict. */
export class Round {
	readonly id: string;
	readonly stored: StoredRound;

	constructor(id: string, stored: StoredRound) {
		this.id = id;
		this.stored = structuredClone(stored);
	}

	/** The frozen verdict, absent until this round decides. */
	verdict(): Verdict | undefined {
		return this.stored.verdict === undefined ? undefined : Verdict.from(structuredClone(this.stored.verdict));
	}

	/** Orders dated legacy rounds before minted rounds, with unknown dates last and IDs breaking ties. */
	compare(other: Round, headDates: ReadonlyMap<string, number>): number {
		const left = this.stored.mintedAt;
		const right = other.stored.mintedAt;
		const leftDate = left === undefined ? headDates.get(this.stored.head) : Date.parse(left);
		const rightDate = right === undefined ? headDates.get(other.stored.head) : Date.parse(right);
		if (leftDate === undefined) return rightDate === undefined ? this.id.localeCompare(other.id) : 1;
		if (rightDate === undefined) return -1;
		if (left === undefined && right !== undefined) return -1;
		if (left !== undefined && right === undefined) return 1;
		return leftDate - rightDate || this.id.localeCompare(other.id);
	}
}

/** Reads rounds through detached storage reads, without opening a harness or writing legacy records. */
export class RoundReader {
	readonly storage: Storage;

	constructor(storage: Storage) {
		this.storage = storage;
	}

	/** Reads every round in this storage, synthesising legacy verdict and comparison keys. The caller owns storage. */
	async read(changeset: string, context: Context = backgroundContext): Promise<Round[]> {
		const scope = { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } as const;
		const read = async <T>(definition: {
			kind: string;
			version: number;
			migrate?: (value: JsonObject, from: number) => T;
		}): Promise<T | undefined> => {
			const record = await this.storage.findDocument({ kind: definition.kind, scope }, "current", context);
			if (record === undefined) return undefined;
			const document = await this.storage.document(record.id, "current", context);
			if (document === undefined) return undefined;
			if (document.version > definition.version)
				throw new RoundError(`${definition.kind} has newer version ${document.version}`);
			return document.version === definition.version
				? (document.value as T)
				: definition.migrate!(document.value, document.version);
		};
		const state = (await read<RoundState>(RoundsDocument.definition)) ?? RoundsDocument.definition.initial();
		const live = await read<ReturnType<typeof VerdictDocument.definition.initial>>(VerdictDocument.definition);
		const comparisons = await read<ReturnType<typeof ComparisonDocument.definition.initial>>(
			ComparisonDocument.definition,
		);
		const items = structuredClone(state.items);
		for (const key of new Set([
			...Object.keys(live?.verdicts ?? {}),
			...Object.keys(comparisons?.comparisons ?? {}),
		])) {
			if (state.recorded[key]) continue;
			items[legacyKey(key)] = legacyRound(key, live?.verdicts[key], live?.provenance?.[key]);
		}
		return Object.entries(items).map(([key, stored]) => new Round(`${changeset}.${key}`, stored));
	}
}
