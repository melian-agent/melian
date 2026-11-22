import { readFileSync } from "node:fs";
import {
	everyRecordCounts,
	Finding,
	type RecordEnvelope,
	RecordError,
	RecordSet,
	reviewPayloads,
	SharedRecord,
	type StoredFinding,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import type { FindingsState } from "../src/findings.ts";
import { type DismissalFacts, ReviewRecords, withheld } from "../src/review-records.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const changeset = "c".repeat(64);
const request = "d".repeat(64);
const lensRun = { name: "security", version: "0123456789ab", level: "careful", request, probe: false } as const;

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
		const first = finding("lens.security", "0123456789ab@careful", "one");
		const second = finding("lens.security", "0123456789ab@careful", "two");
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
				v: 2,
				name: "security",
				version: "0123456789ab",
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

	it("writes the level a lineage's model answered at, and null where it names none", () => {
		const lineage = { model: "openai/terra", by: "melian.local.yaml", outside: true } as const;
		const check = (answeredAt?: "high") =>
			({
				name: "lens.security",
				status: "ran",
				version: "0123456789ab",
				level: "careful",
				lineage: { ...lineage, ...(answeredAt === undefined ? {} : { answeredAt }) },
			}) as const;
		const written = (answeredAt?: "high") => {
			const record = records().lens(lensRun, { status: "unanswered", reason: "no reply" }, [], check(answeredAt));
			expect(SharedRecord.parse(record.toJSON(), reviewPayloads).id).toBe(record.id);
			return (record.toJSON().payload as { check: { lineage: unknown } }).check.lineage;
		};
		const expected = { ...lineage, thinking: null, wanted: null, moved: null };
		expect(written("high")).toEqual({ ...expected, answeredAt: "high" });
		expect(written()).toEqual({ ...expected, answeredAt: null });
		const verification = records().verification(request, {
			claims: [],
			dismissals: [],
			outcomes: [],
			check: { name: "verifier", status: "ran", lineage: { ...lineage, answeredAt: "high" } },
		});
		expect(SharedRecord.parse(verification.toJSON(), reviewPayloads).id).toBe(verification.id);
		expect(verification.toJSON().payload).toMatchObject({
			v: 2,
			check: { lineage: { ...expected, answeredAt: "high" } },
		});
	});

	it("writes an account's lineage as version 1 did, and refuses one that names the level its model answered at", () => {
		const lineage = { model: "openai/terra", by: "melian.local.yaml", outside: true } as const;
		const filled = (answeredAt?: "high") => [
			{
				name: "lens.design",
				status: "failed",
				reason: "refused",
				lineage: { ...lineage, ...(answeredAt === undefined ? {} : { answeredAt }) },
			} as const,
		];
		const account = (answeredAt?: "high") =>
			records().account({
				checks: ["lens.design"],
				records: [],
				filled: filled(answeredAt),
				allowSkip: [],
				producers: [],
				resolutionPolicy: null,
			});
		const written = account();
		expect(SharedRecord.parse(written.toJSON(), reviewPayloads).id).toBe(written.id);
		expect(written.toJSON().payload).toMatchObject({
			filled: [{ lineage: { ...lineage, thinking: null, wanted: null, moved: null } }],
		});
		expect((written.toJSON().payload as { filled: { lineage: object }[] }).filled[0]?.lineage).not.toHaveProperty(
			"answeredAt",
		);
		expect(() => account("high")).toThrow(
			"lens.design's lineage names the level its model answered at, which an account cannot hold",
		);
	});

	it("reads the version-1 lens and verification records main wrote, whose lineage names no answeredAt", () => {
		const recorded = JSON.parse(
			readFileSync(new URL("./fixtures/lineage-v1-main/recorded.json", import.meta.url), "utf8"),
		) as { records: RecordEnvelope[] };
		const lineage = {
			model: "faux/backup",
			wanted: "faux/heavy",
			by: "melian.local.yaml",
			moved: null,
			outside: true,
		};
		const read = recorded.records
			.filter(({ kind }) => kind === "lens" || kind === "verification")
			.map((each) => SharedRecord.parse(each, reviewPayloads))
			.flatMap(({ kind, payload }) => {
				const { v, check } = payload as { v: number; check: { lineage: unknown } | null };
				return check === null ? [] : [{ kind, v, lineage: check.lineage }];
			});
		const lowered = { ...lineage, thinking: { level: "low", wanted: "high", by: "melian.yaml" } };
		expect(read).toEqual([
			{ kind: "lens", v: 1, lineage: lowered },
			{ kind: "lens", v: 1, lineage: lowered },
			{ kind: "verification", v: 1, lineage: { ...lineage, thinking: null } },
		]);
	});

	it("gives the same bytes and ID when a record is built twice", () => {
		const sighting = finding("lens.security", "0123456789ab@careful", "one");
		const build = () => records().lens(lensRun, { status: "unanswered", reason: "no reply" }, [sighting]);
		expect(build().bytes).toBe(build().bytes);
		expect(build().id).toBe(build().id);
	});

	it("refuses a lens record holding another producer's finding", () => {
		const other = finding("lens.design", "0123456789ab@careful", "one");
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
		const sighting = finding("lens.security", "0123456789ab@careful", "one");
		const rounds = ["2".repeat(64), "1".repeat(64), "2".repeat(64)];
		const record = records().made(
			{
				finding: sighting.properties.id,
				by: "maintainer",
				reason: "Accepted",
				at: "2026-11-15T00:00:00.000Z",
				severity: "P1",
				sighting: { revision: `${base}..${head}`, finding: sighting },
				rounds,
				trigger: { hash: "a".repeat(64), proof: [] },
			},
			[],
		);
		const json = record.toJSON();
		expect(json.revision).toBeUndefined();
		expect(json.key).toBe(sighting.properties.id);
		expect((json.payload as { rounds: string[] }).rounds).toEqual(["1".repeat(64), "2".repeat(64)]);
	});

	it("names as its frontier every round of its changeset the listing holds, in ID order, and no other record", () => {
		const sighting = finding("lens.security", "0123456789ab@careful", "one");
		const facts: DismissalFacts = {
			finding: sighting.properties.id,
			by: "maintainer",
			reason: "Accepted",
			at: "2026-11-15T00:00:00.000Z",
			severity: "P1",
			sighting: { revision: `${base}..${head}`, finding: sighting },
			rounds: [],
			trigger: { hash: "a".repeat(64), proof: [] },
		};
		const roundAt = (to: string, of = changeset) =>
			ReviewRecords.of(of, { base, head: to.repeat(40) }).round([], undefined, [], []);
		const later = roundAt("e");
		const earlier = roundAt("d");
		const elsewhere = roundAt("e", "f".repeat(64));
		const lens = records().lens(lensRun, { status: "unanswered", reason: "no reply" }, []);
		const listing = [later, elsewhere, lens, earlier].map((each) => each.toJSON());
		const frontierOf = (record: { toJSON(): RecordEnvelope }) =>
			(record.toJSON().payload as { frontier?: string[] }).frontier;
		expect(frontierOf(records().made(facts, listing))).toEqual([earlier.id, later.id].sort());
		expect(frontierOf(records().made(facts, []))).toEqual([]);
	});

	it("finds the record a store holds of a dismissal made again, whatever rounds its writer held", () => {
		const sighting = finding("lens.security", "0123456789ab@careful", "one");
		const facts: DismissalFacts = {
			finding: sighting.properties.id,
			by: "maintainer",
			reason: "Accepted",
			at: "2026-11-15T00:00:00.000Z",
			severity: "P1",
			sighting: { revision: `${base}..${head}`, finding: sighting },
			rounds: [],
			trigger: { hash: "a".repeat(64), proof: [] },
		};
		const held = records().made(facts, []);
		const round = ReviewRecords.of(changeset, { base, head: "e".repeat(40) }).round([], undefined, [], []);
		const listing = [held.toJSON(), round.toJSON()];
		expect(records().made(facts, listing).toJSON()).toEqual(held.toJSON());
		expect(records().dismissal(facts, listing).toJSON()).toEqual(held.toJSON());
	});

	it("gives no dismissal identity for a finding whose state froze no dismissed sighting", () => {
		const state = {
			items: { undismissed: { lifecycle: { status: "new" } } },
			revisions: [],
		} as unknown as FindingsState;
		expect(records().dismissalIdentity(state, "undismissed", [])).toBeUndefined();
	});

	it("makes and shares no dismissal record for a finding whose state froze no dismissed sighting", () => {
		const state = {
			items: { undismissed: { lifecycle: { status: "new" } } },
			revisions: [],
		} as unknown as FindingsState;
		expect(records().madeOf(state, "undismissed", [])).toBeUndefined();
		expect(records().dismissalOf(state, "undismissed", [])).toBeUndefined();
	});

	it("names the head of the dismissal's own sighting, not the head of the records that write it", () => {
		const sighting = finding("lens.security", "0123456789ab@careful", "one");
		const earlier = "e".repeat(40);
		const record = records().made(
			{
				finding: sighting.properties.id,
				by: "maintainer",
				reason: "Accepted",
				at: "2026-11-15T00:00:00.000Z",
				severity: "P1",
				sighting: { revision: `${base}..${earlier}`, finding: sighting },
				rounds: [],
				trigger: { hash: "a".repeat(64), proof: [] },
			},
			[],
		);
		expect((record.toJSON().payload as { head: string }).head).toBe(earlier);
	});

	describe("what a dismissal supersedes", () => {
		const sighting = finding("lens.security", "0123456789ab@careful", "one");
		const facts = (reason: string): DismissalFacts => ({
			finding: sighting.properties.id,
			by: "maintainer",
			reason,
			at: "2026-11-15T00:00:00.000Z",
			severity: "P1",
			sighting: { revision: `${base}..${head}`, finding: sighting },
			rounds: [],
			trigger: { hash: "a".repeat(64), proof: [] },
		});
		const other = finding("lens.security", "0123456789ab@careful", "two");
		// Built inside each test, so a mutant that throws while building it fails that test, never the file.
		const firstRecord = () => records().made(facts("Accepted once"), []);

		it("writes no record keyed by one finding whose sighting is of another", () => {
			expect(() => records().made({ ...facts("Accepted once"), finding: other.properties.id }, [])).toThrow(
				`a dismissal of ${other.properties.id} holds a sighting of ${sighting.properties.id}`,
			);
		});

		it("leaves another host's later dismissal standing when a host that kept the earlier one exports it again", () => {
			const kept = firstRecord();
			const replacing = records().made({ ...facts("Accepted by two"), at: "2026-11-15T00:00:01.000Z" }, [
				kept.toJSON(),
			]);
			const exportedAgain = records().dismissal(facts("Accepted once"), [kept.toJSON(), replacing.toJSON()]);
			const merged = RecordSet.of([kept, replacing, exportedAgain], {
				counts: everyRecordCounts,
				payloads: reviewPayloads,
			});
			expect(merged.unsuperseded().map(({ id }) => id)).toEqual([replacing.id]);
		});

		it("exports the record a dismissal was made with, what it supersedes included", () => {
			const earlier = firstRecord();
			const made = records().made({ ...facts("Accepted again"), at: "2026-11-15T00:00:01.000Z" }, [
				earlier.toJSON(),
			]);
			const exported = records().dismissal({ ...facts("Accepted again"), at: "2026-11-15T00:00:01.000Z" }, [
				earlier.toJSON(),
				made.toJSON(),
			]);
			expect(exported.toJSON()).toEqual(made.toJSON());
			expect(exported.toJSON().supersedes).toEqual([earlier.id]);
		});

		it("shares no dismissal the store holds no record of, whatever other dismissals of its finding stand", () => {
			const earlier = firstRecord();
			expect(() => records().dismissal(facts("Accepted again"), [earlier.toJSON()])).toThrow(
				expect.objectContaining({ code: "madeWithoutStore", finding: sighting.properties.id }),
			);
		});

		it("names every standing dismissal of its finding the listing holds, and changes its key with them", () => {
			const earlier = firstRecord();
			const alone = records().made(facts("Accepted again"), []);
			const second = records().made({ ...facts("Accepted twice"), at: "2026-11-15T00:00:01.000Z" }, []);
			// Descending, with a repeat, so only a sorted list of distinct IDs passes.
			const listing = [earlier, second].sort((a, b) => (a.id < b.id ? 1 : -1));
			const record = records().made(
				facts("Accepted again"),
				[...listing, listing[0]!].map((each) => each.toJSON()),
			);
			expect(record.toJSON()).toEqual({ ...alone.toJSON(), supersedes: [earlier.id, second.id].sort() });
			expect(record.id).not.toBe(alone.id);
			expect(SharedRecord.parse(record.toJSON(), reviewPayloads).id).toBe(record.id);
		});

		it("supersedes a standing dismissal that a record of another slot names as superseded", () => {
			const earlier = firstRecord();
			const elsewhere = records().made(
				{
					...facts("Accepted"),
					finding: other.properties.id,
					sighting: { revision: `${base}..${head}`, finding: other },
				},
				[],
			);
			// Core ignores a supersedes edge across slots, so `earlier` still stands beside this record.
			const naming = SharedRecord.parse({ ...elsewhere.toJSON(), supersedes: [earlier.id] }, reviewPayloads);
			const made = records().made({ ...facts("Accepted twice"), at: "2026-11-15T00:00:01.000Z" }, [
				earlier.toJSON(),
				naming.toJSON(),
			]);
			expect(made.toJSON().supersedes).toEqual([earlier.id]);
		});

		it("supersedes no dismissal the listing already holds as superseded", () => {
			const earlier = firstRecord();
			const second = records().made({ ...facts("Accepted twice"), at: "2026-11-15T00:00:01.000Z" }, [
				earlier.toJSON(),
			]);
			const third = records().made({ ...facts("Accepted thrice"), at: "2026-11-15T00:00:02.000Z" }, [
				earlier.toJSON(),
				second.toJSON(),
			]);
			expect(third.toJSON().supersedes).toEqual([second.id]);
		});

		it("supersedes nothing, and keeps its key, for a listing with no other dismissal of its finding", () => {
			const alone = records().made(facts("Accepted again"), []);
			const otherFinding = records().made(
				{
					...facts("Accepted"),
					finding: other.properties.id,
					sighting: { revision: `${base}..${head}`, finding: other },
				},
				[],
			);
			const otherChangeset = ReviewRecords.of("e".repeat(64), { base, head }).made(facts("Accepted once"), []);
			const lens = records().lens(lensRun, { status: "unanswered", reason: "no reply" }, []);
			// A store's listing is read by envelope alone, so it can hold a lens record under a finding's key.
			const keyed = { ...lens.toJSON(), key: sighting.properties.id };
			const record = records().made(facts("Accepted again"), [
				otherFinding.toJSON(),
				otherChangeset.toJSON(),
				keyed,
			]);
			expect(record.toJSON()).toEqual(alone.toJSON());
			expect(record.id).toBe(alone.id);
		});

		it("leaves one standing dismissal for each of two writers who each dismissed again from the same listing", () => {
			const earlier = firstRecord();
			const first = records().made(facts("Accepted by one"), [earlier.toJSON()]);
			const second = records().made(facts("Accepted by two"), [earlier.toJSON()]);
			const merged = RecordSet.of([earlier, first, second], { counts: everyRecordCounts, payloads: reviewPayloads });
			expect(merged.unsuperseded().map(({ id }) => id)).toEqual([first.id, second.id].sort());
		});

		it("never supersedes itself, nor rewrites its own record a listing already holds", () => {
			const earlier = firstRecord();
			const alone = records().made(facts("Accepted again"), []);
			const made = records().made(facts("Accepted again"), [earlier.toJSON()]);
			expect(records().made(facts("Accepted again"), [alone.toJSON()]).id).toBe(alone.id);
			const again = records().made(facts("Accepted again"), [made.toJSON(), earlier.toJSON()]);
			expect(again.id).toBe(made.id);
			expect(again.toJSON().supersedes).toEqual([earlier.id]);
		});
	});

	it("carries a writer's dismisser and reason as written, and nothing else a writer wrote", () => {
		// What each field of a dismissal is, by the outside-text decision's list: a new field fails to compile until decided.
		const classes: Record<keyof DismissalFacts, "id" | "time" | "code" | "content" | "writer"> = {
			finding: "id",
			by: "writer",
			reason: "writer",
			at: "time",
			severity: "code",
			sighting: "content",
			rounds: "id",
			frontier: "id",
			trigger: "id",
		};
		const sighting = finding("lens.security", "0123456789ab@careful", "one");
		const record = records().made(
			{
				finding: sighting.properties.id,
				by: "writer-name-7c1d",
				reason: "writer-reason-7c1d",
				at: "2026-11-15T00:00:00.000Z",
				severity: "P1",
				sighting: { revision: `${base}..${head}`, finding: sighting },
				rounds: [],
				trigger: { hash: "a".repeat(64), proof: [{ file: "src/a.ts", hash: "f".repeat(64) }] },
			},
			[],
		);
		const { by, reason, ...rest } = record.toJSON().payload as Record<string, unknown>;
		expect([by, reason]).toEqual(["writer-name-7c1d", "writer-reason-7c1d"]);
		expect(JSON.stringify(rest)).not.toContain("7c1d");
		expect(Object.keys(rest).sort()).toEqual(
			[
				"v",
				"head",
				...Object.keys(classes).filter((key) => key !== "finding" && key !== "by" && key !== "reason"),
			].sort(),
		);
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
				{ check: "lens.security", version: "0123456789ab@quick", ids: kept },
				{ check: "lens.security", version: "0123456789ab@careful" },
				{ check: "guardrails" },
				{ check: "static.biome", version: "2.0.0" },
			],
			resolutionPolicy: "2:0123456789abcdef",
		};
		const account = records().account(facts);
		expect(SharedRecord.parse(account.toJSON(), reviewPayloads).id).toBe(account.id);
		expect(account.revision).toBe(`${base}..${head}`);
		expect(account.toJSON().payload).toEqual({
			v: 2,
			checks: ["static.biome", "lens.security", "decisions.triage"],
			records: [check.id, lens.id].sort(),
			filled: [
				{
					name: "decisions.triage",
					status: "skipped",
					reason: withheld,
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
					reason: withheld,
					error: withheld,
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
				{ check: "lens.security", version: "0123456789ab@careful", ids: null },
				{ check: "lens.security", version: "0123456789ab@quick", ids: ["0123456789abcdef", "fedcba9876543210"] },
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
			stages: [
				{ name: "lens.security", models: ["openai/sol"], cost: 1.5, outcome: "done" },
				{ name: "lens.tests", models: [], outcome: "faulted" },
			],
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
					// A stored run's outcome is text, so one outside the set a record takes is withheld.
					outcome: withheld,
					tools: null,
					limits: null,
					ended: null,
					usageIncomplete: false,
				},
				{
					name: "lens.tests",
					level: null,
					models: [],
					durationMs: null,
					tokens: null,
					cacheRead: null,
					costMicros: null,
					outcome: "faulted",
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
