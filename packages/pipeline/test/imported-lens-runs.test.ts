import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	Lens,
	type LensPayload,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	reviewPayloads,
	SharedRecord,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "@melian-agent/pipeline/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ImportableRun, ImportedRecords } from "../src/imported-records.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

let repo: string;
let changeset: string;
let exported: readonly RecordEnvelope[];

// One review's lens records, which every test plants a variant of.
beforeAll(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const harness: Harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	try {
		await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
		const done = fauxAssistantMessage("No findings.");
		scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [done] },
			{ match: "You are the contracts reviewer", replies: [done] },
		]);
		const config: MelianConfig = {
			...defaultConfig,
			tiers: twoLensTiers,
			models: { heavy: { model: `${fake.ref("heavy").provider}/heavy` } },
		};
		const resolved = await Changeset.resolve(repo, "main...feature");
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await reviewChangeset({
			harness,
			changeset: resolved,
			config,
			lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts"),
			standards: [],
			models: fake.review,
			checks: [{ name: "guardrails", status: "ran" }],
			records: store,
		});
		changeset = resolved.id;
		exported = (await store.list(resolved.id)).filter(({ kind }) => kind === "lens");
	} finally {
		await harness.close(context);
	}
});

afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

const payloadOf = (record: RecordEnvelope) => record.payload as unknown as LensPayload;
const recordsOf = (name: string) => exported.filter((record) => payloadOf(record).name === name);
const revisionOf = () => recordsOf("correctness")[0]!.revision!;

// Every record of lens `name`, each changed by `change`, so the records under its key still agree.
function planted(name: string, change: (payload: LensPayload) => LensPayload, key?: string): RecordEnvelope[] {
	return recordsOf(name).map((record) => ({
		...record,
		...(key === undefined ? {} : { key }),
		payload: change(payloadOf(record)) as unknown as RecordEnvelope["payload"],
	}));
}

function runOf(name: string, change: Partial<ImportableRun> = {}): ImportableRun {
	const [record] = recordsOf(name);
	const { version, level } = payloadOf(record!);
	return { key: `${name}@${version}@${level}`, name, version, level, request: record!.key, ...change };
}

const doneWith = (change: Partial<Extract<LensPayload["outcome"], { status: "done" }>>) => (payload: LensPayload) => ({
	...payload,
	outcome: { ...(payload.outcome as Extract<LensPayload["outcome"], { status: "done" }>), ...change },
});

const firstId = (records: readonly RecordEnvelope[]) =>
	records.map((record) => SharedRecord.parseEnvelope(record).id).sort()[0]!;

const never = () => false;

describe("the lens runs an import answers", () => {
	it("rebuilds the run's outcome from its record, spend in dollars, naming the record it stood on", () => {
		const records = planted(
			"correctness",
			doneWith({ model: "faux/heavy", usage: { models: ["faux/heavy"], tokens: 12, costMicros: 2_500_000 } }),
		);
		const run = runOf("correctness");
		const id = firstId(records);
		expect(ImportedRecords.from(changeset, records).lens(revisionOf(), run, never)).toEqual({
			record: id,
			outcomes: {
				[run.key]: {
					status: "done",
					model: "faux/heavy",
					usage: { models: ["faux/heavy"], tokens: 12, cost: 2.5 },
					imported: id,
				},
			},
			sightings: { [run.key]: [] },
		});
	});

	it("leaves out a model and a spend the record does not hold", () => {
		const records = planted("correctness", doneWith({ model: null, usage: null }));
		const run = runOf("correctness");
		const refused = vi.fn(() => true);
		const id = firstId(records);
		expect(ImportedRecords.from(changeset, records).lens(revisionOf(), run, refused)).toEqual({
			record: id,
			outcomes: { [run.key]: { status: "done", imported: id } },
			sightings: { [run.key]: [] },
		});
		expect(refused).not.toHaveBeenCalled();
	});

	it("answers nothing for a run on a model this host refuses, asking about that run's key", () => {
		const records = planted("correctness", doneWith({ model: "faux/heavy" }));
		const run = runOf("correctness");
		const refused = vi.fn((key: string, model: string) => key === run.key && model === "faux/heavy");
		expect(ImportedRecords.from(changeset, records).lens(revisionOf(), run, refused)).toBeUndefined();
		expect(refused).toHaveBeenCalledWith(run.key, "faux/heavy");
	});

	it.each([
		["another lens", { name: "contracts" }],
		["another version", { version: "000000000000" }],
		["another level", { level: "deep" }],
		["a probe", { probe: {} }],
		["no request", { request: undefined }],
	] as const)("answers nothing when the run names %s than its record", (_, change) => {
		const imported = ImportedRecords.from(changeset, recordsOf("correctness"));
		expect(imported.lens(revisionOf(), runOf("correctness"), never)).toBeDefined();
		expect(imported.lens(revisionOf(), runOf("correctness", change), never)).toBeUndefined();
	});
});

describe("an escalated lens an import answers", () => {
	const carried = ["0123456789abcdef"];
	const kept = ["1123456789abcdef"];
	const refuted = ["2123456789abcdef"];
	const deepKey = () => `correctness@${payloadOf(recordsOf("correctness")[0]!).version}@deep`;
	// The quick run escalates to a deep one, whose records are contracts's records renamed, under a request of their own.
	const quick = (to: string | null) =>
		planted(
			"correctness",
			doneWith({ escalation: { trigger: { kind: "severity", severity: "P1" }, to, carried, kept, refuted } }),
		);
	const deep = () =>
		planted("contracts", (payload) => ({
			...payload,
			name: "correctness",
			version: payloadOf(recordsOf("correctness")[0]!).version,
			level: "deep",
			sightings: [],
			check: null,
		}));
	const escalating = (next?: ImportableRun) =>
		runOf("correctness", next === undefined ? {} : { escalation: { next } });
	const nextRun = (change: Partial<ImportableRun> = {}) =>
		runOf("correctness", { key: deepKey(), level: "deep", request: recordsOf("contracts")[0]!.key, ...change });

	it("answers both runs when a record answers the run it escalated to, keeping the escalation whole", () => {
		const records = [...quick(deepKey()), ...deep()];
		const answered = ImportedRecords.from(changeset, records).lens(revisionOf(), escalating(nextRun()), never);
		const first = firstId(quick(deepKey()));
		const second = firstId(deep());
		expect(answered).toEqual({
			record: first,
			outcomes: {
				[runOf("correctness").key]: expect.objectContaining({
					escalation: { trigger: { kind: "severity", severity: "P1" }, to: deepKey(), carried, kept, refuted },
					imported: first,
				}),
				[deepKey()]: expect.objectContaining({ status: "done", imported: second }),
			},
			sightings: { [runOf("correctness").key]: [], [deepKey()]: [] },
		});
	});

	it("keeps an escalation that went nowhere without a run to stand on", () => {
		const answered = ImportedRecords.from(changeset, quick(null)).lens(revisionOf(), escalating(), never);
		expect(Object.keys(answered!.outcomes)).toEqual([runOf("correctness").key]);
		expect(answered!.outcomes[runOf("correctness").key]!.escalation).toEqual({
			trigger: { kind: "severity", severity: "P1" },
			carried,
			kept,
			refuted,
		});
	});

	it.each([
		["the lens has no next run", () => escalating(), () => [...quick(deepKey()), ...deep()]],
		[
			"the next run has another key",
			() => escalating(nextRun({ key: "other" })),
			() => [...quick(deepKey()), ...deep()],
		],
		["no record answers the next run", () => escalating(nextRun()), () => quick(deepKey())],
	] as const)("answers nothing when %s", (_, run, records) => {
		expect(ImportedRecords.from(changeset, records()).lens(revisionOf(), run(), never)).toBeUndefined();
	});
});
