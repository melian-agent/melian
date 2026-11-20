import { findingId, type RecordEnvelope, RecordError, SharedRecord } from "@melian-agent/core";
import { testPayloads } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";

// A review record's key is its request's key, and a dismissal's its finding's ID, so a key holds no other text.
const token = "ghp_token";
const hash = (digit: string) => digit.repeat(64);
const revision = `${"a".repeat(40)}..${"b".repeat(40)}`;
const envelope = (fields: Partial<RecordEnvelope>): RecordEnvelope => ({
	v: 1,
	changeset: "pull-0123456789abcdef",
	kind: "check",
	key: hash("c"),
	payload: {},
	...fields,
});
const round = (manifest: { read?: unknown[]; walkthrough?: unknown }) =>
	envelope({
		kind: "round",
		revision,
		payload: { read: [], walkthrough: null, replaces: [], before: [], ...manifest } as RecordEnvelope["payload"],
	});
const refusal = (value: RecordEnvelope): string => {
	try {
		SharedRecord.parse(value, testPayloads);
	} catch (error) {
		expect(error).toBeInstanceOf(RecordError);
		return (error as RecordError).message;
	}
	throw new Error("expected the record to be refused");
};

describe("a shared record's key", () => {
	it.each(["check", "lens", "verification", "walkthrough", "triage", "round", "account", "telemetry"])(
		"is a request's key for a %s record",
		(kind) => {
			const keyed = (key: string) =>
				kind === "round"
					? { ...round({}), key }
					: envelope({ kind, key, ...(kind === "account" ? { revision } : {}) });
			expect(SharedRecord.parse(keyed(hash("c")), testPayloads).key).toBe(hash("c"));
			for (const key of [token, hash("c").slice(1), hash("C"), "f".repeat(16)])
				expect(refusal(keyed(key))).toBe(`a record's key is not a key Melian writes for a ${kind} record`);
		},
	);

	it("is a finding's ID for a dismissal", () => {
		expect(SharedRecord.parse(envelope({ kind: "dismissal", key: "f".repeat(16) }), testPayloads).key).toBe(
			"f".repeat(16),
		);
		for (const key of [token, "f".repeat(15), "f".repeat(17), hash("f")])
			expect(refusal(envelope({ kind: "dismissal", key }))).toBe(
				"a record's key is not a key Melian writes for a dismissal record",
			);
	});

	it("takes the ID a finding is given as a dismissal's key", () => {
		const id = findingId({ file: "src/a.ts", rule: "no-eval", snippet: "eval(input)", occurrence: 0 });
		expect(SharedRecord.parse(envelope({ kind: "dismissal", key: id }), testPayloads).key).toBe(id);
	});

	it.each(["marker", "post", "status", "ledger-comment", "comparison"])(
		"keeps any text for a %s record, which no review writes",
		(kind) => {
			expect(SharedRecord.parse(envelope({ kind, key: token }), testPayloads).key).toBe(token);
		},
	);

	it("is a request's key, or a finding's ID, wherever a round names one", () => {
		const id = hash("9");
		expect(
			SharedRecord.parse(round({ walkthrough: { key: hash("1"), id } }), testPayloads).manifest()?.walkthrough,
		).toEqual({
			key: hash("1"),
			id,
		});
		expect(refusal(round({ walkthrough: { key: token, id } }))).toBe(
			"a round's walkthrough's key is not a key Melian writes for a walkthrough record",
		);
		const read = (kind: string, key: string) => round({ read: [{ kind, key, id }] });
		expect(SharedRecord.parse(read("check", hash("1")), testPayloads).manifest()?.read).toHaveLength(1);
		expect(SharedRecord.parse(read("dismissal", "f".repeat(16)), testPayloads).manifest()?.read).toHaveLength(1);
		const named = (kind: string) => `a record a round read's key is not a key Melian writes for a ${kind} record`;
		expect(refusal(read("check", token))).toBe(named("check"));
		expect(refusal(read("check", "f".repeat(16)))).toBe(named("check"));
		expect(refusal(read("dismissal", hash("1")))).toBe(named("dismissal"));
		expect(SharedRecord.parse(read("post", token), testPayloads).manifest()?.read).toHaveLength(1);
	});

	it("names a field it does not know without repeating it", () => {
		expect(refusal({ ...envelope({}), [token]: 1 } as RecordEnvelope)).not.toContain(token);
	});
});
