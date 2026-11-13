// Section 4 of the shared record decision, replacement and order, as it is worded, with a switch for each place the
// wording admits two readings. Scripts, not product code.
import { type Envelope, recordId } from "./envelope.ts";

export type Readings = {
	// Whose `supersedes` takes effect: any record's, even one itself superseded ("any"), or only a record that still
	// counts ("counting"). The decision says only "A superseded record no longer counts".
	supersededBy: "any" | "counting";
	// Whether a superseding record must share the target's kind, key and revision. The decision does not say.
	sameSlot: boolean;
	// Whether the lowest-ID rule applies to rounds too. The decision says it applies "Among records under one kind, key
	// and revision".
	lowestAmongRounds: boolean;
	// Whether a round that names an earlier round of its own revision replaces it.
	predecessorReplaces: boolean;
	// What a round does with a record it names that is superseded: treat it as missing ("absent"), or drop it and go on
	// ("dropped").
	supersededRest: "absent" | "dropped";
	// How a named record is found: by ID alone, as issue #373's spike does, or by kind, key and ID together.
	match: "id" | "kind-key-id";
};

export const literal: Readings = {
	supersededBy: "any",
	sameSlot: false,
	lowestAmongRounds: true,
	predecessorReplaces: false,
	supersededRest: "absent",
	match: "kind-key-id",
};

export type Rest = { kind: string; key: string; id: string };
export type ClosingPayload = { rests: Rest[]; rounds: string[]; [field: string]: unknown };

const slot = (record: Envelope) => JSON.stringify([record.kind, record.key, record.revision ?? null]);

export class RecordSet {
	readonly byId: Map<string, Envelope>;
	readonly readings: Readings;
	readonly superseded: Set<string>;
	readonly standing: Map<string, Envelope>;

	constructor(records: readonly Envelope[], readings: Readings = literal) {
		this.readings = readings;
		this.byId = new Map(records.map((record) => [recordId(record), record]));
		this.superseded = this.#supersede();
		this.standing = this.#lowest();
	}

	#supersede(): Set<string> {
		const effective = (by: Envelope, target: string) => {
			if (!this.readings.sameSlot) return true;
			const found = this.byId.get(target);
			return found !== undefined && slot(found) === slot(by);
		};
		if (this.readings.supersededBy === "any") {
			const dead = new Set<string>();
			for (const record of this.byId.values())
				for (const target of record.supersedes ?? []) if (effective(record, target)) dead.add(target);
			return dead;
		}
		// Only a counting record's supersedes counts: a record is dead when a live record names it. IDs are hashes, so the
		// graph has no cycle, and a fixed point from "all live" settles it.
		const dead = new Set<string>();
		for (let changed = true; changed; ) {
			changed = false;
			const next = new Set<string>();
			for (const [id, record] of this.byId)
				if (!dead.has(id))
					for (const target of record.supersedes ?? []) if (effective(record, target)) next.add(target);
			if ([...next].sort().join() !== [...dead].sort().join()) {
				dead.clear();
				for (const each of next) dead.add(each);
				changed = true;
			}
		}
		return dead;
	}

	// "Among records under one kind, key and revision that nothing supersedes, the lowest ID wins."
	#lowest(): Map<string, Envelope> {
		const winners = new Map<string, [string, Envelope]>();
		const standing = new Map<string, Envelope>();
		for (const [id, record] of this.byId) {
			if (this.superseded.has(id)) continue;
			if (record.kind === "round" && !this.readings.lowestAmongRounds) {
				standing.set(id, record);
				continue;
			}
			const held = winners.get(slot(record));
			if (held === undefined || id < held[0]) winners.set(slot(record), [id, record]);
		}
		for (const [id, record] of winners.values()) standing.set(id, record);
		return standing;
	}

	counts(id: string): boolean {
		return this.standing.has(id);
	}

	// The rounds of `revision` that stand: closing records nothing supersedes and, under `predecessorReplaces`, that no
	// later standing round of the same revision names.
	rounds(revision: string): string[] {
		const rounds = [...this.standing].filter(([, record]) => record.kind === "round" && record.revision === revision);
		if (!this.readings.predecessorReplaces) return rounds.map(([id]) => id);
		const named = new Set(rounds.flatMap(([, record]) => (record.payload as ClosingPayload).rounds ?? []));
		return rounds.filter(([id]) => !named.has(id)).map(([id]) => id);
	}

	// The records a closing record rests on, and the ones a reader "cannot find".
	rests(closingId: string): { found: Envelope[]; absent: Rest[] } {
		const closing = this.byId.get(closingId)!;
		const payload = closing.payload as ClosingPayload;
		const found: Envelope[] = [];
		const absent: Rest[] = [];
		for (const rest of payload.rests) {
			const record = this.byId.get(rest.id);
			const matches =
				record !== undefined &&
				(this.readings.match === "id" || (record.kind === rest.kind && record.key === rest.key));
			if (!matches) absent.push(rest);
			else if (this.superseded.has(rest.id)) {
				if (this.readings.supersededRest === "absent") absent.push(rest);
			} else found.push(record);
		}
		for (const round of payload.rounds ?? [])
			if (!this.byId.has(round)) absent.push({ kind: "round", key: "", id: round });
		return { found, absent };
	}

	// Dismissals are read beside the round, since one may arrive after it: those that count.
	dismissals(): Envelope[] {
		return [...this.standing.values()].filter((record) => record.kind === "dismissal");
	}
}

export type Status = "passed" | "findings" | "blocking" | "not-reviewed";
// The decision says "the worse verdict" and names no order; this one puts not reviewed last.
export const worse: Status[] = ["passed", "findings", "blocking", "not-reviewed"];

export function gate(statuses: Status[]): Status {
	if (statuses.length === 0) return "not-reviewed"; // "With no round for the revision ... the gate fails closed."
	return statuses.reduce((a, b) => (worse.indexOf(a) >= worse.indexOf(b) ? a : b));
}
