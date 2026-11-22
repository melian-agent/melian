import { readFileSync } from "node:fs";
import {
	type Changeset,
	everyRecordCounts,
	type RecordEnvelope,
	RecordError,
	SharedRecord,
	SightingBudget,
} from "@melian-agent/core";
import { RecordedRound } from "@melian-agent/pipeline";
import { describe, expect, it } from "vitest";
import { ReviewRecords } from "../src/review-records.ts";

const recorded = JSON.parse(
	readFileSync(new URL("./fixtures/record-too-large-v1/recorded.json", import.meta.url), "utf8"),
) as { changeset: string; revision: Changeset["revision"]; records: RecordEnvelope[] };
const guardrails = (records: readonly RecordEnvelope[]) =>
	records.find(
		({ kind, payload }) => kind === "check" && (payload as { result: { name: string } }).result.name === "guardrails",
	)!.payload as { result: { status: string; reason: string } };

describe("a check that failed as too large to record", () => {
	it("shares its reason as recordTooLarge", () => {
		const error = (() => {
			try {
				new SightingBudget(0).fit([]);
			} catch (thrown) {
				return thrown as RecordError;
			}
		})()!;
		expect(error).toBeInstanceOf(RecordError);
		const record = ReviewRecords.of(recorded.changeset, {
			base: recorded.revision.base,
			head: recorded.revision.head,
		}).check("a".repeat(64), { name: "guardrails", status: "failed", reason: error.code, error: error.message }, []);
		expect(record.payload).toEqual({
			v: 1,
			result: {
				name: "guardrails",
				status: "failed",
				reason: "recordTooLarge",
				error: expect.stringContaining("Melian shares none of this text"),
			},
			sightings: [],
		});
	});

	it("reopens a round a build wrote before the code was shared, reading its reason as unexpected", () => {
		const round = SharedRecord.parseEnvelope(recorded.records.find(({ kind }) => kind === "round")!);
		expect(RecordedRound.of(recorded.records, round.id, everyRecordCounts).refusal()).toBeUndefined();
		expect(guardrails(recorded.records).result).toMatchObject({ status: "failed", reason: "unexpected" });
	});
});
