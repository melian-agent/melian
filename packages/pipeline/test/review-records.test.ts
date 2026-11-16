import { Finding, RecordError, reviewPayloads, SharedRecord, type StoredFinding } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { ReviewRecords } from "../src/review-records.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const changeset = "c".repeat(64);
const request = "d".repeat(64);
const lensRun = { name: "security", version: "abc", level: "careful", request, probe: false } as const;

function finding(check: string, version: string | undefined, rule: string): StoredFinding {
	return Finding.create({
		rule,
		message: "Unsafe input",
		file: "src/run.ts",
		startLine: 7,
		snippet: "run(input)",
		occurrence: 0,
		severity: "P1",
		cause: "introduced",
		source: { check, version },
		explanation: { what: "Unsafe input", whyHere: "New input", whatToDo: "Validate it" },
	}).toJSON();
}

const records = () => ReviewRecords.of(changeset, { base, head });

describe("ReviewRecords", () => {
	it("writes a lens run's record that its kind's check accepts, with its findings in ID order", () => {
		const first = finding("lens.security", "abc@careful", "one");
		const second = finding("lens.security", "abc@careful", "two");
		const [low, high] = first.properties.id < second.properties.id ? [first, second] : [second, first];
		const record = records().lens(
			lensRun,
			{ status: "done", model: "openai/sol", usage: { models: ["openai/sol"], tokens: 12, cost: 0.0123456 } },
			[high, low],
		);
		expect(SharedRecord.parse(record.toJSON(), reviewPayloads).id).toBe(record.id);
		expect(record.toJSON()).toEqual({
			v: 1,
			changeset,
			revision: `${base}..${head}`,
			kind: "lens",
			key: request,
			payload: {
				v: 1,
				name: "security",
				version: "abc",
				level: "careful",
				probe: false,
				outcome: {
					status: "done",
					model: "openai/sol",
					budgetEnded: null,
					capped: null,
					escalation: null,
					usage: { models: ["openai/sol"], tokens: 12, costMicros: 12346 },
				},
				sightings: [low, high],
				delivery: null,
				check: null,
			},
		});
	});

	it("gives the same bytes and ID when a record is built twice", () => {
		const sighting = finding("lens.security", "abc@careful", "one");
		const build = () => records().lens(lensRun, { status: "unanswered", reason: "no reply" }, [sighting]);
		expect(build().bytes).toBe(build().bytes);
		expect(build().id).toBe(build().id);
	});

	it("refuses a lens record holding another producer's finding", () => {
		const other = finding("lens.design", "abc@careful", "one");
		expect(() => records().lens(lensRun, { status: "unanswered", reason: "no reply" }, [other])).toThrow(RecordError);
	});

	it("keys a check record by the run, the revision and the check's name", () => {
		const result = { name: "static.biome", status: "ran" as const, version: "2.0.0", findings: 0, notes: [] };
		const one = records().check(request, result, []);
		const other = ReviewRecords.of(changeset, { base, head: "e".repeat(40) }).check(request, result, []);
		const renamed = records().check(request, { ...result, name: "static.tsc" }, []);
		expect(new Set([one.key, other.key, renamed.key]).size).toBe(3);
		expect(one.toJSON().payload).toEqual({
			v: 1,
			result: { name: "static.biome", status: "ran", version: "2.0.0", findings: 0, notes: [], snapshots: null },
			sightings: [],
		});
	});

	it("writes a dismissal with no revision, its rounds sorted once each", () => {
		const sighting = finding("lens.security", "abc@careful", "one");
		const rounds = ["2".repeat(64), "1".repeat(64), "2".repeat(64)];
		const record = records().dismissal({
			finding: sighting.properties.id,
			by: "maintainer",
			reason: "Accepted",
			at: "2026-11-15T00:00:00.000Z",
			severity: "P1",
			sighting: { revision: `${base}..${head}`, finding: sighting },
			rounds,
			trigger: { hash: "h", proof: [] },
		});
		const json = record.toJSON();
		expect(json.revision).toBeUndefined();
		expect(json.key).toBe(sighting.properties.id);
		expect((json.payload as { rounds: string[] }).rounds).toEqual(["1".repeat(64), "2".repeat(64)]);
	});

	it("names the head of the dismissal's own sighting, not the head of the records that write it", () => {
		const sighting = finding("lens.security", "abc@careful", "one");
		const earlier = "e".repeat(40);
		const record = records().dismissal({
			finding: sighting.properties.id,
			by: "maintainer",
			reason: "Accepted",
			at: "2026-11-15T00:00:00.000Z",
			severity: "P1",
			sighting: { revision: `${base}..${earlier}`, finding: sighting },
			rounds: [],
			trigger: { hash: "h", proof: [] },
		});
		expect((record.toJSON().payload as { head: string }).head).toBe(earlier);
	});

	it("names each record a round read once, in order, and keys the round by what it read", () => {
		const lens = records().lens(lensRun, { status: "unanswered", reason: "no reply" }, []);
		const check = records().check(
			request,
			{ name: "static.biome", status: "skipped", reason: "No lines", cause: "noProductionLines" },
			[],
		);
		const later = "9".repeat(64);
		const earlier = "1".repeat(64);
		const round = records().round([lens, check, lens], undefined, [later, earlier, later], [later]);
		const read = [
			{ kind: "check", key: check.key, id: check.id },
			{ kind: "lens", key: lens.key, id: lens.id },
		].sort((a, b) => (a.id < b.id ? -1 : 1));
		expect(round.toJSON().payload).toEqual({
			read,
			walkthrough: null,
			replaces: [earlier, later],
			before: [later],
		});
		expect(records().round([check, lens], undefined, [], []).key).toBe(round.key);
		expect(records().round([check], undefined, [], []).key).not.toBe(round.key);
	});

	it("writes an account in one form, keyed by the revision and the records it counts", () => {
		const lens = records().lens(lensRun, { status: "unanswered", reason: "no reply" }, []);
		const check = records().check(
			request,
			{ name: "static.biome", status: "skipped", reason: "No lines", cause: "noProductionLines" },
			[],
		);
		const kept = ["fedcba9876543210", "0123456789abcdef", "fedcba9876543210"];
		const facts = {
			checks: ["static.biome", "lens.security", "decisions.triage", "static.biome"],
			records: [lens, check, lens],
			filled: [
				{ name: "lens.design", status: "failed", reason: "refused", error: "no route", level: "careful" },
				{ name: "decisions.triage", status: "skipped", reason: "no decision provider is configured" },
				{ name: "lens.design", status: "failed", reason: "refused", error: "no route", level: "careful" },
			] as const,
			allowSkip: ["lens.design", "decisions.triage", "lens.design"],
			producers: [
				{ check: "static.biome", version: "2.0.0" },
				{ check: "lens.security", version: "abc@quick", ids: kept },
				{ check: "lens.security", version: "abc@careful" },
				{ check: "guardrails" },
				{ check: "static.biome", version: "2.0.0" },
			],
			resolutionPolicy: "2:0123456789abcdef",
		};
		const account = records().account(facts);
		expect(SharedRecord.parse(account.toJSON(), reviewPayloads).id).toBe(account.id);
		expect(account.revision).toBe(`${base}..${head}`);
		expect(account.toJSON().payload).toEqual({
			v: 1,
			checks: ["static.biome", "lens.security", "decisions.triage"],
			records: [check.id, lens.id].sort(),
			filled: [
				{
					name: "decisions.triage",
					status: "skipped",
					reason: "no decision provider is configured",
					error: null,
					version: null,
					level: null,
					budgetEnded: null,
					caveats: null,
					coverage: null,
					lineage: null,
				},
				{
					name: "lens.design",
					status: "failed",
					reason: "refused",
					error: "no route",
					version: null,
					level: "careful",
					budgetEnded: null,
					caveats: null,
					coverage: null,
					lineage: null,
				},
			],
			allowSkip: ["decisions.triage", "lens.design"],
			producers: [
				{ check: "guardrails", version: null, ids: null },
				{ check: "lens.security", version: "abc@careful", ids: null },
				{ check: "lens.security", version: "abc@quick", ids: ["0123456789abcdef", "fedcba9876543210"] },
				{ check: "static.biome", version: "2.0.0", ids: null },
			],
			resolutionPolicy: "2:0123456789abcdef",
		});
		const reordered = { ...facts, records: [check, lens], producers: [...facts.producers].reverse() };
		expect(records().account(reordered).bytes).toBe(account.bytes);
		expect(records().account({ ...facts, records: [check] }).key).not.toBe(account.key);
		expect(records().account({ ...facts, allowSkip: [] }).key).toBe(account.key);
		// Two reviews of one range under two policies count the same records, and must stay two accounts.
		const other = records().account({ ...facts, resolutionPolicy: "2:fedcba9876543210" });
		const none = records().account({ ...facts, resolutionPolicy: null });
		expect(new Set([account.key, other.key, none.key]).size).toBe(3);
		expect(none.toJSON().payload).toMatchObject({ resolutionPolicy: null });
		const round = records().round([account, lens, check], undefined, [], []);
		expect(round.manifest()?.read).toContainEqual({ kind: "account", key: account.key, id: account.id });
	});

	it("keys telemetry by its round's ID and writes cost in millionths", () => {
		const round = records().round([], undefined, [], []);
		const record = records().telemetry(round, {
			durationMs: 10,
			stages: [{ name: "lens.security", models: ["openai/sol"], cost: 1.5, outcome: "done" }],
		});
		expect(record.key).toBe(round.id);
		expect(record.toJSON().payload).toEqual({
			v: 1,
			durationMs: 10,
			stages: [
				{
					name: "lens.security",
					level: null,
					models: ["openai/sol"],
					durationMs: null,
					tokens: null,
					cacheRead: null,
					costMicros: 1_500_000,
					outcome: "done",
					tools: null,
					limits: null,
					ended: null,
					usageIncomplete: false,
				},
			],
		});
	});

	it("writes a triage distribution in millionths", () => {
		const record = records().triage(request, {
			decision: {
				questionSet: { name: "triage", version: "1" },
				decider: "model",
				calibrated: false,
				answers: [{ question: "risk", distribution: { low: 0.25, high: 0.75 }, chosen: "high" }],
			},
		});
		expect(record.toJSON().payload).toEqual({
			v: 1,
			decision: {
				questionSet: { name: "triage", version: "1" },
				decider: "model",
				calibrated: false,
				model: null,
				answers: [{ question: "risk", distribution: { low: 250_000, high: 750_000 }, chosen: "high" }],
			},
			failure: null,
			inputCut: false,
		});
	});
});
