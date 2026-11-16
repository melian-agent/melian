import { Finding, type RecordEnvelope, RecordError, type StoredFinding } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { ImportedRecords } from "../src/imported-records.ts";
import { ReviewRecords } from "../src/review-records.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const other = "e".repeat(40);
const changeset = "c".repeat(64);
const request = "d".repeat(64);
const revision = `${base}..${head}`;
const lensRun = { name: "security", version: "abc", level: "careful", request, probe: false } as const;
const done = { status: "done", model: "openai/sol" } as const;

function finding(rule: string): StoredFinding {
	return Finding.create({
		rule,
		message: "Unsafe input",
		file: "src/run.ts",
		startLine: 7,
		snippet: "run(input)",
		occurrence: 0,
		severity: "P1",
		cause: "introduced",
		source: { check: "lens.security", version: "abc@careful" },
		explanation: { what: "Unsafe input", whyHere: "New input", whatToDo: "Validate it" },
	}).toJSON();
}

const lens = (sightings: StoredFinding[] = [], sides = { base, head }, id = changeset) =>
	ReviewRecords.of(id, sides).lens(lensRun, done, sightings).toJSON();

// A record whose payload claims `v`, as a build with another payload version would write it.
const withPayloadVersion = (envelope: RecordEnvelope, v: unknown): RecordEnvelope => ({
	...envelope,
	payload: { ...(envelope.payload as object), v } as RecordEnvelope["payload"],
});

describe("ImportedRecords", () => {
	it("matches a record by its kind, revision and key", () => {
		const record = lens();
		const imported = ImportedRecords.from(changeset, [record]);
		expect(imported.match("lens", revision, request)?.toJSON()).toEqual(record);
		expect(imported.match("check", revision, request)).toBeUndefined();
		expect(imported.match("lens", revision, "f".repeat(64))).toBeUndefined();
	});

	it("sets aside a record whose envelope names another changeset, whatever its payload holds", () => {
		const elsewhere = withPayloadVersion(lens([], { base, head }, "f".repeat(64)), "broken");
		const imported = ImportedRecords.from(changeset, [elsewhere]);
		expect(imported.records()).toEqual([]);
		expect(imported.match("lens", revision, request)).toBeUndefined();
	});

	it("answers no request of this revision with a record of another base or head under the same key", () => {
		const imported = ImportedRecords.from(changeset, [lens([], { base: other, head })]);
		expect(imported.records()).toHaveLength(1);
		expect(imported.match("lens", revision, request)).toBeUndefined();
	});

	it("sets aside a record a newer build wrote in a payload version this build does not read, and keeps the rest", () => {
		const record = lens();
		const newer = withPayloadVersion(lens([finding("one")]), 2);
		const imported = ImportedRecords.from(changeset, [newer, record]);
		expect(imported.records().map((each) => each.toJSON())).toEqual([record]);
		expect(imported.match("lens", revision, request)?.toJSON()).toEqual(record);
	});

	it("fails the set on a counted record of a known payload version that its check refuses", () => {
		expect(() => ImportedRecords.from(changeset, [withPayloadVersion(lens(), 0)])).toThrow(RecordError);
		expect(() => ImportedRecords.from(changeset, [withPayloadVersion(lens(), "2")])).toThrow(RecordError);
		const { sightings: _, ...short } = lens().payload as { [field: string]: unknown };
		expect(() =>
			ImportedRecords.from(changeset, [{ ...lens(), payload: short as RecordEnvelope["payload"] }]),
		).toThrow(RecordError);
	});

	it("sets aside a record of a kind no producer asks, before its payload is read", () => {
		const round: RecordEnvelope = { v: 1, changeset, revision, kind: "account", key: request, payload: { v: 9 } };
		const dismissal: RecordEnvelope = { v: 1, changeset, kind: "dismissal", key: request, payload: null };
		const imported = ImportedRecords.from(changeset, [round, dismissal]);
		expect(imported.records()).toEqual([]);
	});

	it("answers nothing when two records under one key disagree, so a clean one never hides one with findings", () => {
		const imported = ImportedRecords.from(changeset, [lens(), lens([finding("one")])]);
		expect(imported.records()).toHaveLength(2);
		expect(imported.match("lens", revision, request)).toBeUndefined();
	});

	it("answers with either of two records that differ only in the check a review decided for them", () => {
		const early = lens([finding("one")]);
		const decided = ReviewRecords.of(changeset, { base, head })
			.lens(lensRun, done, [finding("one")], {
				name: "lens.security",
				status: "ran",
				version: "abc",
				level: "careful",
			})
			.toJSON();
		const imported = ImportedRecords.from(changeset, [early, decided]);
		expect(imported.records()).toHaveLength(2);
		expect((imported.match("lens", revision, request)?.payload as { sightings: unknown[] }).sightings).toHaveLength(
			1,
		);
	});
});
