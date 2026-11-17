import { readFileSync } from "node:fs";
import { type RecordEnvelope, reviewPayloads, SharedRecord } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

// Records main's build wrote at e6ed960bd, one of each shape, captured from its own tests that build records. Captures
// from tests that handed `ReviewRecords` a lens version of their own, `1`, `abc`, `a` or `b`, were left out, since no
// lens Melian loads has one. The payload version stays 1 only if the schema still reads every one of these.
const { writtenBy, records } = JSON.parse(
	readFileSync(new URL("./fixtures/records-main/records.json", import.meta.url), "utf8"),
) as { writtenBy: string; records: RecordEnvelope[] };

describe("a record main's build wrote", () => {
	it("covers every kind a review writes, from the build before the classes were checked on read", () => {
		expect(writtenBy).toBe("e6ed960bd");
		expect([...new Set(records.map(({ kind }) => kind))].sort()).toEqual(
			["account", "check", "lens", "round", "telemetry", "triage", "verification", "walkthrough"].sort(),
		);
	});

	it.each(records.map((record, index) => [index, record.kind, record] as const))(
		"reads record %i, a %s record, under the payload version it was written with",
		(_index, _kind, record) => {
			// A round's manifest has no payload version; core checks its shape apart from the payload checks.
			if (record.kind !== "round") expect(record.payload).toMatchObject({ v: 1 });
			expect(() => SharedRecord.parse(record, reviewPayloads)).not.toThrow();
		},
	);
});
