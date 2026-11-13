import { type RecordEnvelope, type RecordJson, RecordSet, SharedRecord } from "@melian-agent/core";
import { testPayloads } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";

const changeset = "pull-0123456789abcdef";
const revision = `${"a".repeat(40)}..${"b".repeat(40)}`;
const later = `${"a".repeat(40)}..${"c".repeat(40)}`;

function record(fields: Partial<RecordEnvelope>): SharedRecord {
	return SharedRecord.parse({ v: 1, changeset, kind: "post", key: "review", payload: {}, ...fields }, testPayloads);
}

function post(payload: RecordJson, supersedes?: SharedRecord[], fields: Partial<RecordEnvelope> = {}): SharedRecord {
	const ids = supersedes?.map((target) => target.id).sort();
	return record({ payload, ...(ids === undefined ? {} : { supersedes: ids }), ...fields });
}

function round(name: string, replaces: SharedRecord[] = [], at = revision, fields: Partial<RecordEnvelope> = {}) {
	const ids = replaces.map((target) => target.id).sort();
	return record({
		kind: "round",
		key: name,
		revision: at,
		payload: { read: [], walkthrough: null, replaces: ids, before: [] },
		...fields,
	});
}

const ids = (records: readonly SharedRecord[]) => records.map((each) => each.id);
const sorted = (records: readonly SharedRecord[]) => ids(records).sort();

describe("RecordSet", () => {
	it("holds each record once, in ID order, whatever order and repeats it was given", () => {
		const a = post({ n: 1 });
		const b = post({ n: 2 });
		expect(ids(RecordSet.of([b, a, b, a]).records())).toEqual(sorted([a, b]));
	});

	it("reads envelopes as well as records", () => {
		const a = post({ n: 1 });
		expect(ids(RecordSet.of([a.toJSON()], { payloads: testPayloads }).records())).toEqual([a.id]);
	});

	describe("supersession", () => {
		it("sets aside a record another in its slot supersedes", () => {
			const first = post({ n: 1 });
			const second = post({ n: 2 }, [first]);
			const set = RecordSet.of([second, first]);
			expect(set.superseded(first)).toBe(true);
			expect(set.superseded(second)).toBe(false);
			expect(ids(set.unsuperseded())).toEqual([second.id]);
		});

		it("has no effect while its target is not in the set, and applies once it lands", () => {
			const first = post({ n: 1 });
			const second = post({ n: 2 }, [first]);
			expect(ids(RecordSet.of([second]).unsuperseded())).toEqual([second.id]);
			expect(ids(RecordSet.of([second, first]).unsuperseded())).toEqual([second.id]);
		});

		it.each([
			["kind", { kind: "status" }],
			["key", { key: "other" }],
			["changeset", { changeset: "pull-fedcba9876543210" }],
		])("does not reach a record of another %s", (_name, fields) => {
			const target = post({ n: 1 }, undefined, fields);
			const superseding = post({ n: 2 }, [target]);
			expect(sorted(RecordSet.of([target, superseding]).unsuperseded())).toEqual(sorted([target, superseding]));
		});

		it("reaches a record of another revision in its slot", () => {
			const target = post({ n: 1 }, undefined, { revision });
			const superseding = post({ n: 2 }, [target], { revision: later });
			expect(ids(RecordSet.of([target, superseding]).unsuperseded())).toEqual([superseding.id]);
		});

		it("keeps applying a superseded record's own supersedes", () => {
			const first = post({ n: 1 });
			const second = post({ n: 2 }, [first]);
			const third = post({ n: 3 }, [second]);
			expect(ids(RecordSet.of([first, third, second]).unsuperseded())).toEqual([third.id]);
			expect(sorted(RecordSet.of([first, third]).unsuperseded())).toEqual(sorted([first, third]));
		});

		it("lets two records stand when each supersedes only an earlier one", () => {
			const first = post({ n: 1 });
			const left = post({ n: 2 }, [first]);
			const right = post({ n: 3 }, [first]);
			expect(sorted(RecordSet.of([first, left, right]).unsuperseded())).toEqual(sorted([left, right]));
		});

		it("lets a record that does not count supersede nothing", () => {
			const first = post({ n: 1 });
			const forged = post({ n: 2 }, [first]);
			const set = RecordSet.of([first, forged], { counts: (each) => each.id !== forged.id });
			expect(ids(set.unsuperseded())).toEqual([first.id]);
			expect(ids(set.records())).toEqual([first.id]);
		});
	});

	describe("standing rounds", () => {
		it("takes a round no other names as replaced", () => {
			const only = round("1");
			expect(ids(RecordSet.of([only]).standingRounds(changeset, revision))).toEqual([only.id]);
		});

		it("drops a round a later round of its revision replaces", () => {
			const first = round("1");
			const second = round("2", [first]);
			expect(ids(RecordSet.of([second, first]).standingRounds(changeset, revision))).toEqual([second.id]);
		});

		it("keeps two rounds that stand together, in ID order", () => {
			const a = round("a");
			const b = round("b");
			expect(ids(RecordSet.of([b, a]).standingRounds(changeset, revision))).toEqual(sorted([a, b]));
		});

		it("answers for the revision asked about only", () => {
			const here = round("1");
			const there = round("2", [], later);
			const set = RecordSet.of([here, there]);
			expect(ids(set.standingRounds(changeset, revision))).toEqual([here.id]);
			expect(ids(set.standingRounds(changeset, later))).toEqual([there.id]);
			expect(set.standingRounds(changeset, `${"d".repeat(40)}..${"e".repeat(40)}`)).toEqual([]);
		});

		it("ignores a replacement named by a round of another revision", () => {
			const first = round("1");
			const elsewhere = round("2", [first], later);
			expect(ids(RecordSet.of([first, elsewhere]).standingRounds(changeset, revision))).toEqual([first.id]);
		});

		it("answers for the changeset asked about only, and ignores another changeset's replacement", () => {
			const first = round("1");
			const elsewhere = round("2", [first], revision, { changeset: "pull-fedcba9876543210" });
			const set = RecordSet.of([first, elsewhere]);
			expect(ids(set.standingRounds(changeset, revision))).toEqual([first.id]);
			expect(ids(set.standingRounds("pull-fedcba9876543210", revision))).toEqual([elsewhere.id]);
		});

		it("keeps applying a replaced round's own replacements", () => {
			const first = round("1");
			const second = round("2", [first]);
			const third = round("3", [second]);
			expect(ids(RecordSet.of([third, first, second]).standingRounds(changeset, revision))).toEqual([third.id]);
		});

		it("lets only a round that counts replace another", () => {
			const trusted = round("trusted");
			const forged = round("forged", [trusted]);
			const set = RecordSet.of([trusted, forged], { counts: (each) => each.id !== forged.id });
			expect(ids(set.standingRounds(changeset, revision))).toEqual([trusted.id]);
		});

		it("never counts a record of another kind at the revision as a round", () => {
			const only = round("1");
			const status = post({ n: 1 }, undefined, { kind: "status", revision });
			expect(ids(RecordSet.of([only, status]).standingRounds(changeset, revision))).toEqual([only.id]);
		});

		it("is not changed by a record of another kind that names a round", () => {
			const first = round("1");
			const pointer = post({ replaces: [first.id] });
			expect(ids(RecordSet.of([first, pointer]).standingRounds(changeset, revision))).toEqual([first.id]);
		});
	});

	describe("as a function of the set alone", () => {
		function random(seed: number): () => number {
			let state = seed >>> 0;
			return () => {
				state = (state + 0x6d2b79f5) >>> 0;
				let t = state;
				t = Math.imul(t ^ (t >>> 15), t | 1);
				t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
				return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
			};
		}

		function shuffled<T>(items: readonly T[], next: () => number): T[] {
			const copy = [...items];
			for (let index = copy.length - 1; index > 0; index--) {
				const other = Math.floor(next() * (index + 1));
				[copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
			}
			return copy;
		}

		const r1 = round("1");
		const r2 = round("2", [r1]);
		const r3 = round("3");
		const r4 = round("4", [r2, r3]);
		const r5 = round("5", [], later);
		const r6 = round("6", [r5], later);
		const p1 = post({ n: 1 });
		const p2 = post({ n: 2 }, [p1]);
		const p3 = post({ n: 3 }, [p2]);
		const p4 = post({ n: 4 }, [p1]);
		const s1 = post({ n: 5 }, undefined, { kind: "status" });
		const s2 = post({ n: 6 }, [s1, p1], { kind: "status" });
		const all = [r1, r2, r3, r4, r5, r6, p1, p2, p3, p4, s1, s2];

		function answers(records: SharedRecord[]) {
			const set = RecordSet.of(records);
			return {
				standing: ids(set.standingRounds(changeset, revision)),
				later: ids(set.standingRounds(changeset, later)),
				unsuperseded: ids(set.unsuperseded()),
			};
		}

		it("gives the same answers in every arrival order, with repeats", () => {
			const expected = answers(all);
			expect(expected).toEqual({
				standing: [r4.id],
				later: [r6.id],
				unsuperseded: sorted([r1, r2, r3, r4, r5, r6, p3, p4, s2]),
			});
			const next = random(392);
			for (let trial = 0; trial < 500; trial++) {
				const arrival = shuffled([...all, ...all.filter(() => next() < 0.3)], next);
				expect(answers(arrival)).toEqual(expected);
			}
		});

		it("gives the same answers for every subset, whatever its order", () => {
			const next = random(46);
			for (let trial = 0; trial < 300; trial++) {
				const subset = all.filter(() => next() < 0.6);
				expect(answers(shuffled(subset, next))).toEqual(answers(subset));
			}
		});
	});
});
