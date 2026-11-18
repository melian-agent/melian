import { readFileSync } from "node:fs";
import { type RecordEnvelope, reviewPayloads, SharedRecord } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

// Records main's build wrote at e6ed960bd, one of each shape, captured from its own tests that build records. Captures
// from tests that handed `ReviewRecords` a lens version of their own, `1`, `abc`, `a` or `b`, were left out, since no
// lens Melian loads has one. So were a telemetry stage's outcome `done` and a claim's verification version `1`, which
// tests handed it: main's telemetry projection writes only the outcomes core lists, as its types now prove, and a
// claim's verification carries the verifier's version, as the one claim kept here does. So were two verifications whose
// candidates were model names that tests handed it: the verifier keys each candidate by its finding's ID, as
// `review.ts` does. The payload version stays 1 only if the schema still reads every one of these.
const { writtenBy, records } = JSON.parse(
	readFileSync(new URL("./fixtures/records-main/records.json", import.meta.url), "utf8"),
) as { writtenBy: string; records: RecordEnvelope[] };

describe("a record main's build wrote", () => {
	it("covers every kind a review writes but telemetry, from the build before the classes were checked on read", () => {
		expect(writtenBy).toBe("e6ed960bd");
		expect([...new Set(records.map(({ kind }) => kind))].sort()).toEqual(
			["account", "check", "lens", "round", "triage", "verification", "walkthrough"].sort(),
		);
	});

	it("reads each verification main's build wrote by its candidates, finding IDs, here and at 4d08b08c", () => {
		const candidates = (record: RecordEnvelope) =>
			(record.payload as { outcomes: { candidate: string }[] }).outcomes.map(({ candidate }) => candidate);
		const verifications = records.filter(({ kind }) => kind === "verification");
		expect(verifications.map(candidates)).toEqual([["8f3f919a7c886b44"], ["8f3f919a7c886b44"]]);
		for (const record of verifications) expect(() => SharedRecord.parse(record, reviewPayloads)).not.toThrow();
		// The amendment of 2026-11-18 refuses this record for its outcome's provider text; its candidate still reads.
		const [atAccount] = (
			JSON.parse(readFileSync(new URL("./fixtures/account-v1/recorded.json", import.meta.url), "utf8")) as {
				records: RecordEnvelope[];
			}
		).records.filter(({ kind }) => kind === "verification");
		expect(candidates(atAccount!)).toEqual(["8f3f919a7c886b44"]);
		expect(() => SharedRecord.parse(atAccount!, reviewPayloads)).toThrow(
			"a verification record's payload does not match its schema at /outcomes/0/outcome: must have required properties model",
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
