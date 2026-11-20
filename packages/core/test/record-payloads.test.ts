import {
	everyRecordCounts,
	type RecordEnvelope,
	RecordError,
	type RecordJson,
	RecordSet,
	SharedRecord,
} from "@melian-agent/core";
import { findingKey, recordKey, testPayloads } from "@melian-agent/core/testing";
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
			key: findingKey("finding-1"),
			payload: { reason: "ok" },
		} as RecordEnvelope;
		expect(refusal(() => SharedRecord.parse(target)).code).toBe("unvalidatedKind");
	});

	it("checks a record it is handed parsed under the set's own payload checks (e38e73c0c0a263dc)", () => {
		const strict = {
			dismissal: (payload: RecordJson) => ("by" in (payload as object) ? undefined : "names no dismisser"),
		};
		const good = SharedRecord.parse(
			{ v: 1, changeset, kind: "dismissal", key: findingKey("finding-1"), payload: { by: "maintainer" } },
			strict,
		);
		const bad = SharedRecord.parse(
			{ v: 1, changeset, kind: "dismissal", key: findingKey("finding-1"), supersedes: [good.id], payload: {} },
			{ dismissal: () => undefined },
		);
		const error = refusal(() => RecordSet.of([good, bad], { counts: everyRecordCounts, payloads: strict }));
		expect(error.message).toBe("a dismissal record's payload names no dismisser");
	});

	it("refuses a round that names no manifest, so it cannot stand (689b374ee71f2b03)", () => {
		const round: RecordEnvelope = {
			v: 1,
			changeset,
			kind: "round",
			key: recordKey("round"),
			revision,
			payload: { replaces: [] },
		};
		expect(refusal(() => SharedRecord.parse(round)).code).toBe("invalidRecord");
		expect(() => RecordSet.of([round], { counts: everyRecordCounts, payloads: testPayloads })).toThrow(RecordError);
	});
});

const hex = (character: string) => character.repeat(64);
const manifest = { read: [], walkthrough: null, replaces: [], before: [] };

function envelope(fields: Partial<RecordEnvelope>): RecordEnvelope {
	const key = fields.kind === "dismissal" ? findingKey("static.biome") : recordKey("static.biome");
	return { v: 1, changeset, kind: "check", key, payload: {}, ...fields };
}

describe("payload checks", () => {
	it.each([
		"check",
		"lens",
		"verification",
		"walkthrough",
		"triage",
		"account",
		"telemetry",
		"marker",
		"dismissal",
		"post",
		"status",
		"ledger-comment",
		"comparison",
	])("refuses a %s record when no check is registered for its kind", (kind) => {
		const revisioned = kind === "account" ? { revision } : {};
		const error = refusal(() => SharedRecord.parse(envelope({ kind, ...revisioned }), { other: () => undefined }));
		expect(error.code).toBe("unvalidatedKind");
		expect(error.message).toBe(`no payload check is registered for a ${kind} record`);
	});

	it("hands the check the payload, and takes the record when the check does", () => {
		const seen: unknown[] = [];
		const record = SharedRecord.parse(
			envelope({ kind: "dismissal", key: findingKey("f"), payload: { reason: "ok" } }),
			{
				dismissal: (payload) => {
					seen.push(payload);
					return undefined;
				},
			},
		);
		expect(seen).toEqual([{ reason: "ok" }]);
		expect(record.kind).toBe("dismissal");
	});

	it("hands the check a frozen payload, so a check cannot change what the ID names", () => {
		const parsing = () =>
			SharedRecord.parse(envelope({ kind: "check", payload: { status: "blocked" } }), {
				check: (payload) => {
					(payload as { status: string }).status = "passed";
					return undefined;
				},
			});
		expect(parsing).toThrow(TypeError);
	});

	it("refuses the record, with the check's reason, when the check refuses its payload", () => {
		const error = refusal(() =>
			SharedRecord.parse(envelope({ kind: "dismissal", key: findingKey("f") }), {
				dismissal: () => "names no dismisser",
			}),
		);
		expect(error.code).toBe("invalidRecord");
		expect(error.message).toBe("a dismissal record's payload names no dismisser");
	});

	it("checks a round itself, whatever check is registered for the kind", () => {
		const round = envelope({ kind: "round", key: recordKey("r"), revision, payload: manifest });
		expect(SharedRecord.parse(round, {}).manifest()).toEqual(manifest);
		expect(SharedRecord.parse(round, { round: () => "refused" }).kind).toBe("round");
		expect(refusal(() => SharedRecord.parse({ ...round, payload: {} }, { round: () => undefined })).code).toBe(
			"invalidRecord",
		);
	});

	it("lets tests parse a record of every kind core lists but a round", () => {
		for (const kind of ["check", "lens", "verification", "walkthrough", "triage", "telemetry", "marker"])
			expect(SharedRecord.parse(envelope({ kind }), testPayloads).kind).toBe(kind);
		expect(SharedRecord.parse(envelope({ kind: "account", revision }), testPayloads).kind).toBe("account");
	});

	it("checks stored bytes the same way", () => {
		const record = SharedRecord.parse(envelope({}), { check: () => undefined });
		expect(refusal(() => SharedRecord.read(record.bytes, record.id)).code).toBe("unvalidatedKind");
		expect(refusal(() => SharedRecord.read(record.bytes, record.id, { check: () => "is stale" })).message).toBe(
			"a check record's payload is stale",
		);
	});

	it("is how a set reads envelopes", () => {
		expect(refusal(() => RecordSet.of([envelope({})], { counts: everyRecordCounts })).code).toBe("unvalidatedKind");
		expect(
			RecordSet.of([envelope({})], { counts: everyRecordCounts, payloads: { check: () => undefined } }).records(),
		).toHaveLength(1);
	});
});

describe("a round's manifest", () => {
	const named = { kind: "check", key: recordKey("static.biome"), id: hex("1") };
	const round = (payload: unknown) =>
		envelope({ kind: "round", key: recordKey("r"), revision, payload: payload as never });

	it("takes every field filled", () => {
		const full = {
			read: [named, { kind: "lens", key: recordKey("l"), id: hex("2") }],
			walkthrough: { key: recordKey("w"), id: hex("3") },
			replaces: [hex("4")],
			before: [hex("5")],
		};
		expect(SharedRecord.parse(round(full)).manifest()).toEqual(full);
	});

	it.each(["dismissal", "post", "status", "ledger-comment", "comparison"])(
		"takes a read entry naming a %s, a kind that supersedes",
		(kind) => {
			const key = kind === "dismissal" ? findingKey("static.biome") : named.key;
			const read = { ...manifest, read: [{ ...named, kind, key }] };
			expect(SharedRecord.parse(round(read)).manifest()).toEqual(read);
		},
	);

	it.each([
		["a payload that is not an object", null],
		["a missing field", { read: [], walkthrough: null, replaces: [] }],
		["an extra field", { ...manifest, verdict: "passed" }],
		["read that is no list", { ...manifest, read: {} }],
		["a read entry missing its ID", { ...manifest, read: [{ kind: "check", key: recordKey("k") }] }],
		["a read entry with an extra field", { ...manifest, read: [{ ...named, at: 1 }] }],
		["a read entry naming a round", { ...manifest, read: [{ ...named, kind: "round" }] }],
		["a read entry naming an unknown kind", { ...manifest, read: [{ ...named, kind: "checks" }] }],
		["a read entry whose kind is no string", { ...manifest, read: [{ ...named, kind: 1 }] }],
		["a read entry with an empty key", { ...manifest, read: [{ ...named, key: "" }] }],
		["a read entry whose key is no string", { ...manifest, read: [{ ...named, key: 1 }] }],
		["a read entry with a bad ID", { ...manifest, read: [{ ...named, id: "x" }] }],
		["read out of ID order", { ...manifest, read: [{ ...named, id: hex("2") }, named] }],
		["read naming one ID twice", { ...manifest, read: [named, { ...named, kind: "lens" }] }],
		["a walkthrough missing its ID", { ...manifest, walkthrough: { key: recordKey("w") } }],
		[
			"a walkthrough with an extra field",
			{ ...manifest, walkthrough: { key: recordKey("w"), id: hex("3"), kind: "walkthrough" } },
		],
		["a walkthrough with an empty key", { ...manifest, walkthrough: { key: "", id: hex("3") } }],
		["a walkthrough with a bad ID", { ...manifest, walkthrough: { key: recordKey("w"), id: "x" } }],
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
		const check = parse({ kind: "check", key: recordKey("static.biome") });
		const lens = parse({ kind: "lens", key: recordKey("correctness") });
		const walkthrough = parse({ kind: "walkthrough", key: recordKey("w") });
		const sorted = [check, lens].sort((a, b) => (a.id < b.id ? -1 : 1));
		const round = parse({
			kind: "round",
			key: recordKey("r"),
			revision,
			payload: {
				read: sorted.map((record) => ({ kind: record.kind, key: record.key, id: record.id })),
				walkthrough: { key: recordKey("w"), id: walkthrough.id },
				replaces: [],
				before: [],
			},
		});
		return { check, lens, walkthrough, round };
	}

	it("names nothing when the set holds every record the round names", () => {
		const { check, lens, walkthrough, round } = fixture();
		expect(
			RecordSet.of([round, check, lens, walkthrough], { counts: everyRecordCounts, payloads: testPayloads }).missing(
				round,
			),
		).toEqual([]);
	});

	it("names each record the set lacks, its walkthrough included", () => {
		const { check, lens, walkthrough, round } = fixture();
		expect(
			RecordSet.of([round, check], { counts: everyRecordCounts, payloads: testPayloads }).missing(round),
		).toEqual([
			{ kind: "lens", key: recordKey("correctness"), id: lens.id },
			{ kind: "walkthrough", key: recordKey("w"), id: walkthrough.id },
		]);
	});

	it.each([
		["another kind", { kind: "check", key: recordKey("correctness") }],
		["another key", { kind: "lens", key: recordKey("design") }],
	])("counts a record with the ID but %s as missing", (_name, fields) => {
		const { lens } = fixture();
		const named = { ...fields, id: lens.id };
		const odd = parse({ kind: "round", key: recordKey("r2"), revision, payload: { ...manifest, read: [named] } });
		expect(RecordSet.of([odd, lens], { counts: everyRecordCounts, payloads: testPayloads }).missing(odd)).toEqual([
			named,
		]);
	});

	it("counts a record of the same kind and key but another ID as missing", () => {
		const { check, lens, walkthrough, round } = fixture();
		const rerun = parse({ kind: "lens", key: recordKey("correctness"), payload: { again: true } });
		expect(
			RecordSet.of([round, check, rerun, walkthrough], {
				counts: everyRecordCounts,
				payloads: testPayloads,
			}).missing(round),
		).toEqual([{ kind: "lens", key: recordKey("correctness"), id: lens.id }]);
	});

	it("counts a record of another changeset as missing", () => {
		const { lens } = fixture();
		const elsewhere = SharedRecord.parse({ ...lens.toJSON(), changeset: "pull-fedcba9876543210" }, payloads);
		const named = { kind: "lens", key: recordKey("correctness"), id: elsewhere.id };
		const odd = parse({ kind: "round", key: recordKey("r3"), revision, payload: { ...manifest, read: [named] } });
		expect(
			RecordSet.of([odd, elsewhere], { counts: everyRecordCounts, payloads: testPayloads }).missing(odd),
		).toEqual([named]);
	});

	it("names nothing for a record that is no round", () => {
		const { check } = fixture();
		expect(RecordSet.of([check], { counts: everyRecordCounts, payloads: testPayloads }).missing(check)).toEqual([]);
	});
});

describe("RecordSet.account", () => {
	const parse = (fields: Partial<RecordEnvelope>) => SharedRecord.parse(envelope(fields), testPayloads);
	const account = (fields: Partial<RecordEnvelope> = {}) =>
		parse({ kind: "account", key: recordKey("a"), revision, ...fields });
	const roundOf = (...named: SharedRecord[]) =>
		parse({
			kind: "round",
			key: recordKey("r"),
			revision,
			payload: {
				...manifest,
				read: named
					.map((record) => ({ kind: record.kind, key: record.key, id: record.id }))
					.sort((a, b) => (a.id < b.id ? -1 : 1)),
			},
		});
	const set = (records: SharedRecord[], counts = everyRecordCounts) =>
		RecordSet.of(records, { counts, payloads: testPayloads });

	it("is the one account the round names", () => {
		const own = account();
		const check = parse({ kind: "check", key: recordKey("static.biome") });
		const round = roundOf(own, check);
		expect(set([round, own, check]).account(round)?.id).toBe(own.id);
	});

	it("is none for a round that names no account, so the round is not reviewed", () => {
		const check = parse({ kind: "check", key: recordKey("static.biome") });
		const round = roundOf(check);
		expect(set([round, check, account()]).account(round)).toBeUndefined();
	});

	it("is none for a round that names two", () => {
		const one = account();
		const two = account({ key: recordKey("b") });
		const round = roundOf(one, two);
		expect(set([round, one, two]).account(round)).toBeUndefined();
	});

	it("is none when the set lacks the account the round names", () => {
		const own = account();
		const round = roundOf(own);
		expect(set([round]).account(round)).toBeUndefined();
	});

	it("is none when the account is from a writer whose records do not count", () => {
		const own = account();
		const round = roundOf(own);
		const counted = (record: SharedRecord) => record.id !== own.id;
		expect(set([round, own], counted).account(round)).toBeUndefined();
		expect(set([round, own], counted).missing(round)).toEqual([{ kind: "account", key: recordKey("a"), id: own.id }]);
	});

	it.each([
		["another changeset", { changeset: "pull-fedcba9876543210" }],
		["another revision", { revision: `${"c".repeat(40)}..${"d".repeat(40)}` }],
	])("is none for an account of %s", (_name, fields) => {
		const elsewhere = account(fields);
		const round = roundOf(elsewhere);
		expect(set([round, elsewhere]).account(round)).toBeUndefined();
	});

	it.each([
		["another key", { key: recordKey("b") }],
		["another kind", { kind: "check" }],
	])("is none for a record with the ID the round names but %s", (_name, fields) => {
		const own = account();
		const named = { kind: "account", key: recordKey("a"), id: own.id, ...fields };
		const round = parse({ kind: "round", key: recordKey("r"), revision, payload: { ...manifest, read: [named] } });
		expect(set([round, own]).account(round)).toBeUndefined();
	});

	it("is the account the round names by ID, of two that share its key", () => {
		// The set holds records in ID order, so the named account takes the later ID and a lookup that ignores the ID finds the other.
		const [other, named] = [account({ payload: { n: 1 } }), account()].sort((a, b) => (a.id < b.id ? -1 : 1));
		const round = roundOf(named);
		expect(named.key).toBe(other.key);
		expect(set([round, named, other]).account(round)?.id).toBe(named.id);
	});

	it("is none for a record of another kind that the round names as its account", () => {
		const check = parse({ kind: "check", key: recordKey("static.biome"), revision });
		const named = { kind: "account", key: check.key, id: check.id };
		const round = parse({ kind: "round", key: recordKey("r"), revision, payload: { ...manifest, read: [named] } });
		expect(set([round, check]).account(round)).toBeUndefined();
	});

	it("is none for a record that is no round", () => {
		const own = account();
		expect(set([own]).account(own)).toBeUndefined();
	});
});

describe("a record from the job that ran a head's code", () => {
	const run = { changeset, revision, fork: false };
	const parse = (fields: Partial<RecordEnvelope>) =>
		SharedRecord.parse(envelope({ revision, ...fields }), testPayloads);
	const round = () => parse({ kind: "round", key: recordKey("r"), payload: manifest });

	it.each(["check", "lens", "verification", "walkthrough", "triage", "account", "telemetry"])(
		"takes a %s record from a writer's head",
		(kind) => {
			expect(parse({ kind, key: recordKey("k") }).refusedFromHeadCode(run)).toBeUndefined();
		},
	);

	it("takes a round from a writer's head", () => {
		expect(round().refusedFromHeadCode(run)).toBeUndefined();
	});

	it.each(["marker", "post", "status", "ledger-comment", "comparison"])(
		"refuses a %s record from a writer's head",
		(kind) => {
			expect(parse({ kind, key: recordKey("k") }).refusedFromHeadCode(run)).toBe(
				`the job that runs a writer's head hands over no ${kind} record`,
			);
		},
	);

	it("refuses a dismissal from a writer's head", () => {
		const dismissal = SharedRecord.parse(envelope({ kind: "dismissal", key: findingKey("k") }), testPayloads);
		expect(dismissal.refusedFromHeadCode(run)).toBe(
			"the job that runs a writer's head hands over no dismissal record",
		);
	});

	it("takes only a check record from a fork's head", () => {
		const fork = { ...run, fork: true };
		expect(parse({ kind: "check", key: recordKey("k") }).refusedFromHeadCode(fork)).toBeUndefined();
		for (const kind of ["lens", "verification", "walkthrough", "triage", "account", "telemetry"])
			expect(parse({ kind, key: recordKey("k") }).refusedFromHeadCode(fork)).toBe(
				`the job that runs a fork's head hands over no ${kind} record`,
			);
		expect(round().refusedFromHeadCode(fork)).toBe("the job that runs a fork's head hands over no round record");
	});

	it.each([
		["changeset", { changeset: "pull-fedcba9876543210" }],
		["revision", { revision: `${"c".repeat(40)}..${"d".repeat(40)}` }],
	])("refuses an account of another %s than the run's", (_name, fields) => {
		expect(parse({ kind: "account", key: recordKey("k"), ...fields }).refusedFromHeadCode(run)).toBe(
			"a record from the head's job names another changeset or revision than its run's",
		);
	});

	it("refuses a check record with no revision", () => {
		const bare = SharedRecord.parse(envelope({ kind: "check", key: recordKey("k") }), testPayloads);
		expect(bare.refusedFromHeadCode(run)).toBe(
			"a record from the head's job names another changeset or revision than its run's",
		);
	});
});
