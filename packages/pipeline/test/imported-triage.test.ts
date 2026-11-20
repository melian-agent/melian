import { rmSync } from "node:fs";
import {
	Changeset,
	type CheckRecord,
	defaultConfig,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	reviewPayloads,
	type ScrutinyLevel,
	type TriagePayload,
} from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import { backgroundContext as context, type Review, ReviewHarness, reviewChangeset } from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../src/harness.ts";
import { ImportedRecords } from "../src/imported-records.ts";
import { gitIn, isolatedGitEnv } from "./fixtures/repo.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const done = fauxAssistantMessage("Done.");
const ran: CheckRecord[] = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
];

let repo: string;
let fake: FakeModels;
let lenses: Lens[];
let config: MelianConfig;
let opened: ReviewHarness[];

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = crashRepository();
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "light" }, { id: "medium" }, { id: "heavy" }] });
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	config = {
		...defaultConfig,
		tiers: { ...defaultConfig.tiers, full: ["standard"] },
		// Triage may skip the lens, so a record can choose skip.
		lenses: { correctness: { level: { floor: "skip" } } },
		models: { light: route("light"), medium: route("medium"), heavy: route("heavy") },
	};
	lenses = await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"]);
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

function choosing(level: "skip" | ScrutinyLevel): RecordedDecider {
	return new RecordedDecider(
		{ triage: { version: "1", answers: { correctness: { distribution: { [level]: 1 } } } } },
		{ name: "recorded" },
	);
}

// A host of its own, holding `decider`'s decision extension on a fresh store.
async function host(decider: RecordedDecider) {
	const harness = await ReviewHarness.open(createMemoryStorage(), fake.review, { retry: false, decider });
	opened.push(harness);
	await harness.harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	return harness;
}

async function review(
	harness: ReviewHarness,
	decider: RecordedDecider,
	options: { readonly store?: MemoryRecordStore; readonly imported?: readonly RecordEnvelope[] } = {},
) {
	scriptConversations(fake, [{ match: correctness, replies: [done, done, done] }]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const result = await reviewChangeset({
		harness: harness.harness,
		changeset,
		config,
		lenses,
		standards: [],
		models: fake.review,
		checks: ran,
		decider,
		...(options.store === undefined ? {} : { records: options.store }),
		...(options.imported === undefined ? {} : { imported: ImportedRecords.from(changeset.id, options.imported) }),
	});
	return { result, stored: (await options.store?.list(changeset.id)) ?? [] };
}

const level = (review: Review) =>
	[...(review.verdict.ran ?? []), ...review.verdict.notRun].find((check) => check.name === "lens.correctness")?.level;

const triageOf = (stored: readonly RecordEnvelope[]) => stored.filter(({ kind }) => kind === "triage");

// Another host's review at `chosen`, `quick` by default, and the records it exported.
async function exported(chosen: "skip" | ScrutinyLevel = "quick") {
	const decider = choosing(chosen);
	const store = new MemoryRecordStore({ payloads: reviewPayloads });
	const { result, stored } = await review(await host(decider), decider, { store });
	expect(level(result)).toBe(chosen === "skip" ? undefined : chosen);
	return stored;
}

describe("a review that names a record store and asks a decider", () => {
	it("exports triage's decision under the key of its request", async () => {
		const stored = await exported();
		const [triage] = triageOf(stored);
		expect(triageOf(stored)).toHaveLength(1);
		const payload = triage!.payload as unknown as TriagePayload;
		expect(payload).toMatchObject({ v: 1, failure: null, inputCut: false });
		expect(payload.decision!.answers).toEqual([
			{ question: "correctness", distribution: expect.objectContaining({ quick: 1_000_000 }), chosen: "quick" },
		]);
	});
});

describe("a review that imports a triage record", () => {
	it("asks no decider for the request the record answers, and runs each lens at the level it chose", async () => {
		const stored = await exported();
		const decider = choosing("deep");
		const { result } = await review(await host(decider), decider, { imported: stored });
		expect(decider.requests).toHaveLength(0);
		expect(level(result)).toBe("quick");
	});

	it("exports the record it imported, byte for byte", async () => {
		const stored = await exported();
		const decider = choosing("deep");
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const again = await review(await host(decider), decider, { store, imported: stored });
		expect(triageOf(again.stored)).toEqual(triageOf(stored));
	});

	it.each([
		[
			"chooses an option its distribution does not favour",
			(payload: TriagePayload): TriagePayload => ({
				...payload,
				decision: {
					...payload.decision!,
					answers: payload.decision!.answers.map((answer) => ({ ...answer, chosen: "skip" })),
				},
			}),
		],
		[
			"weighs an option the question does not offer",
			(payload: TriagePayload): TriagePayload => ({
				...payload,
				decision: {
					...payload.decision!,
					answers: payload.decision!.answers.map((answer) => ({
						...answer,
						distribution: { ...answer.distribution, never: 2_000_000 },
					})),
				},
			}),
		],
		[
			"records a decider that failed",
			(payload: TriagePayload): TriagePayload => ({ ...payload, decision: null, failure: "failed" }),
		],
		[
			"names another request",
			(payload: TriagePayload): TriagePayload => payload,
			(key: string) => `${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`,
		],
	] as const)(
		"asks the decider when the only triage record %s",
		async (_, plant, rekey: (key: string) => string = (key) => key) => {
			const stored = (await exported()).map((record) =>
				record.kind === "triage"
					? {
							...record,
							key: rekey(record.key),
							payload: plant(record.payload as unknown as TriagePayload) as unknown as RecordEnvelope["payload"],
						}
					: record,
			);
			const decider = choosing("deep");
			const { result } = await review(await host(decider), decider, { imported: stored });
			expect(decider.requests).toHaveLength(1);
			expect(level(result)).toBe("deep");
		},
	);

	it("runs no lens when the record it stands on chose skip, and this host made no decision", async () => {
		const stored = await exported("skip");
		const decider = choosing("deep");
		const { result } = await review(await host(decider), decider, { imported: stored });
		expect(decider.requests).toHaveLength(0);
		expect(level(result)).toBeUndefined();
	});

	it.each(["quick", "skip"] as const)(
		"keeps the decision this host already made over an imported %s",
		async (chosen) => {
			const stored = await exported(chosen);
			const decider = choosing("deep");
			const harness = await host(decider);
			expect(level((await review(harness, decider)).result)).toBe("deep");
			const { result } = await review(harness, decider, { imported: stored });
			expect(decider.requests).toHaveLength(1);
			expect(level(result)).toBe("deep");
		},
	);
});
