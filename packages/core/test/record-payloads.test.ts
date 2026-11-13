import { type RecordEnvelope, RecordError, RecordSet, SharedRecord } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const changeset = "pull-0123456789abcdef";
const revision = `${"a".repeat(40)}..${"b".repeat(40)}`;

function refusal(run: () => unknown): RecordError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(RecordError);
		return error as RecordError;
	}
	throw new Error("expected a refusal");
}

describe("the round 3 findings on pull request #399", () => {
	it("refuses a dismissal with an empty payload, so it cannot set aside a valid one (cb72ec6863468cbd)", () => {
		const target = {
			v: 1,
			changeset,
			kind: "dismissal",
			key: "finding-1",
			payload: { reason: "ok" },
		} as RecordEnvelope;
		expect(refusal(() => SharedRecord.parse(target)).code).toBe("unvalidatedKind");
	});

	it("refuses a round that names no manifest, so it cannot stand (689b374ee71f2b03)", () => {
		const round: RecordEnvelope = {
			v: 1,
			changeset,
			kind: "round",
			key: "round",
			revision,
			payload: { replaces: [] },
		};
		expect(refusal(() => SharedRecord.parse(round)).code).toBe("invalidRecord");
		expect(() => RecordSet.of([round])).toThrow(RecordError);
	});
});

const hex = (character: string) => character.repeat(64);
const manifest = { read: [], walkthrough: null, replaces: [], before: [] };

function envelope(fields: Partial<RecordEnvelope>): RecordEnvelope {
	return { v: 1, changeset, kind: "check", key: "static.biome", payload: {}, ...fields };
}

describe("payload checks", () => {
	it.each([
		"check",
		"lens",
		"verification",
		"walkthrough",
		"telemetry",
		"marker",
		"dismissal",
		"post",
		"status",
		"ledger-comment",
		"comparison",
	])("refuses a %s record when no check is registered for its kind", (kind) => {
		const error = refusal(() => SharedRecord.parse(envelope({ kind }), { other: () => undefined }));
		expect(error.code).toBe("unvalidatedKind");
		expect(error.message).toBe(`no payload check is registered for a ${kind} record`);
	});

	it("hands the check the payload, and takes the record when the check does", () => {
		const seen: unknown[] = [];
		const record = SharedRecord.parse(envelope({ kind: "dismissal", key: "f", payload: { reason: "ok" } }), {
			dismissal: (payload) => {
				seen.push(payload);
				return undefined;
			},
		});
		expect(seen).toEqual([{ reason: "ok" }]);
		expect(record.kind).toBe("dismissal");
	});

	it("refuses the record, with the check's reason, when the check refuses its payload", () => {
		const error = refusal(() =>
			SharedRecord.parse(envelope({ kind: "dismissal", key: "f" }), { dismissal: () => "names no dismisser" }),
		);
		expect(error.code).toBe("invalidRecord");
		expect(error.message).toBe("a dismissal record's payload names no dismisser");
	});

	it("checks a round itself, whatever check is registered for the kind", () => {
		const round = envelope({ kind: "round", key: "r", revision, payload: manifest });
		expect(SharedRecord.parse(round, {}).manifest()).toEqual(manifest);
		expect(SharedRecord.parse(round, { round: () => "refused" }).kind).toBe("round");
		expect(refusal(() => SharedRecord.parse({ ...round, payload: {} }, { round: () => undefined })).code).toBe(
			"invalidRecord",
		);
	});

	it("checks stored bytes the same way", () => {
		const record = SharedRecord.parse(envelope({}), { check: () => undefined });
		expect(refusal(() => SharedRecord.read(record.bytes, record.id)).code).toBe("unvalidatedKind");
		expect(refusal(() => SharedRecord.read(record.bytes, record.id, { check: () => "is stale" })).message).toBe(
			"a check record's payload is stale",
		);
	});

	it("is how a set reads envelopes", () => {
		expect(refusal(() => RecordSet.of([envelope({})])).code).toBe("unvalidatedKind");
		expect(RecordSet.of([envelope({})], { payloads: { check: () => undefined } }).records()).toHaveLength(1);
	});
});

describe("a round's manifest", () => {
	const named = { kind: "check", key: "static.biome", id: hex("1") };
	const round = (payload: unknown) => envelope({ kind: "round", key: "r", revision, payload: payload as never });

	it("takes every field filled", () => {
		const full = {
			read: [named, { kind: "lens", key: "l", id: hex("2") }],
			walkthrough: { key: "w", id: hex("3") },
			replaces: [hex("4")],
			before: [hex("5")],
		};
		expect(SharedRecord.parse(round(full)).manifest()).toEqual(full);
	});

	it.each([
		["a payload that is not an object", null],
		["a missing field", { read: [], walkthrough: null, replaces: [] }],
		["an extra field", { ...manifest, verdict: "passed" }],
		["read that is no list", { ...manifest, read: {} }],
		["a read entry missing its ID", { ...manifest, read: [{ kind: "check", key: "k" }] }],
		["a read entry with an extra field", { ...manifest, read: [{ ...named, at: 1 }] }],
		["a read entry naming a round", { ...manifest, read: [{ ...named, kind: "round" }] }],
		["a read entry naming an unknown kind", { ...manifest, read: [{ ...named, kind: "checks" }] }],
		["a read entry whose kind is no string", { ...manifest, read: [{ ...named, kind: 1 }] }],
		["a read entry with an empty key", { ...manifest, read: [{ ...named, key: "" }] }],
		["a read entry whose key is no string", { ...manifest, read: [{ ...named, key: 1 }] }],
		["a read entry with a bad ID", { ...manifest, read: [{ ...named, id: "x" }] }],
		["read out of ID order", { ...manifest, read: [{ ...named, id: hex("2") }, named] }],
		["read naming one ID twice", { ...manifest, read: [named, { ...named, kind: "lens" }] }],
		["a walkthrough missing its ID", { ...manifest, walkthrough: { key: "w" } }],
		[
			"a walkthrough with an extra field",
			{ ...manifest, walkthrough: { key: "w", id: hex("3"), kind: "walkthrough" } },
		],
		["a walkthrough with an empty key", { ...manifest, walkthrough: { key: "", id: hex("3") } }],
		["a walkthrough with a bad ID", { ...manifest, walkthrough: { key: "w", id: "x" } }],
		["a walkthrough left out rather than null", { read: [], replaces: [], before: [], walkthrough: undefined }],
		["before that is no list", { ...manifest, before: hex("1") }],
		["before out of order", { ...manifest, before: [hex("2"), hex("1")] }],
	])("refuses %s", (_name, payload) => {
		expect(refusal(() => SharedRecord.parse(round(payload))).code).toBe("invalidRecord");
	});

	it("says why it refuses", () => {
		const message = (payload: unknown) => refusal(() => SharedRecord.parse(round(payload))).message;
		expect(message({})).toBe("a round's payload holds read, walkthrough, replaces, before and nothing else");
		expect(message(null)).toBe("a round's payload is an object");
		expect(message(5)).toBe("a round's payload is an object");
		expect(message({ read: [], walkthrough: null, replaces: [], verdict: [] })).toBe(
			"a round's payload holds read, walkthrough, replaces, before and nothing else",
		);
		expect(message({ ...manifest, read: {} })).toBe("a round's read is a list");
		expect(message({ ...manifest, read: [{ ...named, kind: "round" }] })).toBe(
			"a record a round read has a kind no round reads",
		);
		expect(message({ ...manifest, read: [{ ...named, key: "" }] })).toBe(
			"a record a round read's key is a non-empty string",
		);
		expect(message({ ...manifest, read: [named, named] })).toBe("a round's read is sorted by ID, with no ID twice");
		expect(message({ ...manifest, walkthrough: { key: "", id: hex("3") } })).toBe(
			"a round's walkthrough's key is a non-empty string",
		);
		expect(message({ ...manifest, before: [hex("2"), hex("1")] })).toBe(
			"a round's before is sorted, with no ID twice",
		);
	});
});

describe("RecordSet.missing", () => {
	const payloads = {
		check: () => undefined,
		lens: () => undefined,
		walkthrough: () => undefined,
		post: () => undefined,
	};
	const parse = (fields: Partial<RecordEnvelope>) => SharedRecord.parse(envelope(fields), payloads);

	// Built inside each test, so a mutant that breaks parsing fails that test rather than the file's collection.
	function fixture() {
		const check = parse({ kind: "check", key: "static.biome" });
		const lens = parse({ kind: "lens", key: "correctness" });
		const walkthrough = parse({ kind: "walkthrough", key: "w" });
		const sorted = [check, lens].sort((a, b) => (a.id < b.id ? -1 : 1));
		const round = parse({
			kind: "round",
			key: "r",
			revision,
			payload: {
				read: sorted.map((record) => ({ kind: record.kind, key: record.key, id: record.id })),
				walkthrough: { key: "w", id: walkthrough.id },
				replaces: [],
				before: [],
			},
		});
		return { check, lens, walkthrough, round };
	}

	it("names nothing when the set holds every record the round names", () => {
		const { check, lens, walkthrough, round } = fixture();
		expect(RecordSet.of([round, check, lens, walkthrough]).missing(round)).toEqual([]);
	});

	it("names each record the set lacks, its walkthrough included", () => {
		const { check, lens, walkthrough, round } = fixture();
		expect(RecordSet.of([round, check]).missing(round)).toEqual([
			{ kind: "lens", key: "correctness", id: lens.id },
			{ kind: "walkthrough", key: "w", id: walkthrough.id },
		]);
	});

	it.each([
		["another kind", { kind: "check", key: "correctness" }],
		["another key", { kind: "lens", key: "design" }],
	])("counts a record with the ID but %s as missing", (_name, fields) => {
		const { lens } = fixture();
		const named = { ...fields, id: lens.id };
		const odd = parse({ kind: "round", key: "r2", revision, payload: { ...manifest, read: [named] } });
		expect(RecordSet.of([odd, lens]).missing(odd)).toEqual([named]);
	});

	it("counts a record of another changeset as missing", () => {
		const { lens } = fixture();
		const elsewhere = SharedRecord.parse({ ...lens.toJSON(), changeset: "pull-fedcba9876543210" }, payloads);
		const named = { kind: "lens", key: "correctness", id: elsewhere.id };
		const odd = parse({ kind: "round", key: "r3", revision, payload: { ...manifest, read: [named] } });
		expect(RecordSet.of([odd, elsewhere]).missing(odd)).toEqual([named]);
	});

	it("names nothing for a record that is no round", () => {
		const { check } = fixture();
		expect(RecordSet.of([check]).missing(check)).toEqual([]);
	});
});
