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

	it("answers no producer's request with a reused kind written under a round's or an account's key", () => {
		const records = ReviewRecords.of(changeset, { base, head });
		const run = records.lens(lensRun, done, []);
		const account = records.account({
			checks: ["lens.security"],
			records: [run],
			filled: [],
			allowSkip: [],
			producers: [],
			resolutionPolicy: null,
		});
		const round = records.round([run, account], undefined, [], []);
		const check = records
			.check(request, { name: "static.biome", status: "ran", findings: 0, notes: [] }, [])
			.toJSON();
		const imported = ImportedRecords.from(
			changeset,
			[account.key, round.key].flatMap((key) => [
				{ ...run.toJSON(), key },
				{ ...check, key },
			]),
		);
		expect(imported.records()).toHaveLength(4);
		expect(imported.match("lens", revision, request)).toBeUndefined();
		expect(imported.check(request, { base, head }, "static.biome")).toBeUndefined();
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
		expect((imported.match("lens", revision, request)!.payload as { sightings: unknown[] }).sightings).toHaveLength(
			1,
		);
	});
});

describe("ImportedRecords.verification", () => {
	const id = "0123456789abcdef";
	const verdict = {
		verdict: "confirmed",
		reason: "It is.",
		executor: "llm",
		model: "openai/sol",
		version: "v1",
	} as const;
	const claim = { id, source: { check: "lens.security", version: "abc@careful" }, verification: verdict };
	const claimKey = `${id} lens.security@abc@careful`;
	const verification = (
		outcomes: {
			candidate: string;
			outcome: { status: "done"; model: string } | { status: "unanswered"; reason: string };
		}[],
		claims: (
			| typeof claim
			| { id: string; source: { check: string; version?: string }; verification: typeof verdict }
		)[] = [claim],
	) =>
		ReviewRecords.of(changeset, { base, head })
			.verification(request, { claims, dismissals: [], outcomes, check: undefined })
			.toJSON();
	const one = [{ key: "k1", claims: [claimKey] }];

	it("answers every candidate the record says is done, with the verdicts of their claims", () => {
		const imported = ImportedRecords.from(changeset, [verification([{ candidate: "k1", outcome: done }])]);
		expect(imported.verification(request, revision, one, () => false)).toEqual({
			outcomes: { k1: done },
			claims: [claim],
		});
	});

	it("names no version on a claim whose source the record holds with none", () => {
		const bare = { id, source: { check: "static.biome" }, verification: verdict };
		const imported = ImportedRecords.from(changeset, [verification([{ candidate: "k1", outcome: done }], [bare])]);
		expect(
			imported.verification(request, revision, [{ key: "k1", claims: [`${id} static.biome@`] }], () => false),
		).toEqual({ outcomes: { k1: done }, claims: [bare] });
	});

	it("answers nothing under another request or revision", () => {
		const imported = ImportedRecords.from(changeset, [verification([{ candidate: "k1", outcome: done }])]);
		expect(imported.verification("f".repeat(64), revision, one, () => false)).toBeUndefined();
		expect(imported.verification(request, `${other}..${head}`, one, () => false)).toBeUndefined();
	});

	it("answers nothing when one candidate of two is not done, so the verifier asks for both", () => {
		const imported = ImportedRecords.from(changeset, [
			verification([
				{ candidate: "k1", outcome: done },
				{ candidate: "k2", outcome: { status: "unanswered", reason: "superseded" } },
			]),
		]);
		const both = [...one, { key: "k2", claims: [claimKey] }];
		expect(imported.verification(request, revision, both, () => false)).toBeUndefined();
		expect(imported.verification(request, revision, [{ key: "k3", claims: [] }], () => false)).toBeUndefined();
	});

	it("answers nothing when this host refuses the model that judged a candidate", () => {
		const imported = ImportedRecords.from(changeset, [verification([{ candidate: "k1", outcome: done }])]);
		expect(imported.verification(request, revision, one, (model) => model === "openai/sol")).toBeUndefined();
		expect(imported.verification(request, revision, one, (model) => model === "openai/terra")).toBeDefined();
	});

	it("answers nothing when the record judged none of a candidate's claims", () => {
		const imported = ImportedRecords.from(changeset, [verification([{ candidate: "k1", outcome: done }], [])]);
		expect(imported.verification(request, revision, one, () => false)).toBeUndefined();
	});
});
