import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	Revision,
	reviewPayloads,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	type Message,
	openHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
	type VerifierScript,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsDocument } from "../src/findings.ts";
import { ImportedRecords } from "../src/imported-records.ts";
import { verifierMarker } from "../src/verification-instructions.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";
const changedReturn = {
	file: "src/a.ts",
	line: 1,
	rule: "changed-return",
	severity: "P2",
	explanation: { what: "a is 2 now.", why: "This change rewrote it.", fix: "Restore 1." },
	failureScenario: "A caller that reads a expects 1 and gets 2.",
	evidence: [{ file: "src/a.ts", line: 1, role: "cause" }],
};
// What this host's verifier answers for finding `id`: a refutation, which a review that asks it records.
const refuting = (id: string): VerifierScript => ({
	[id]: {
		verdict: "refuted",
		reason: "a is meant to be 2.",
		evidence: [{ file: "src/a.ts", line: 1, role: "cause" }],
	},
});
const checks = [
	{ name: "guardrails", status: "ran" as const, findings: 0, notes: [] },
	{ name: "static.biome", status: "ran" as const, version: "2.5.0", findings: 0, notes: [] },
];

let repo: string;
let opened: Harness[];

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

// One host's review, on a store of its own, so nothing it reads was left by another host's run.
async function review(options: {
	readonly store?: MemoryRecordStore;
	readonly imported?: (changeset: string) => ImportedRecords;
	readonly verdicts?: VerifierScript;
}) {
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }, { id: "light" }] });
	const heavy = fake.ref("heavy");
	const light = fake.ref("light");
	const config: MelianConfig = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: {
			heavy: { model: `${heavy.provider}/${heavy.modelId}` },
			light: { model: `${light.provider}/${light.modelId}` },
		},
	};
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	opened.push(harness);
	const answer = (messages: readonly Message[]) =>
		systemPromptOf(messages).includes(contracts) && !messages.some((message) => message.role === "toolResult")
			? fauxAssistantMessage(fauxToolCall("report_finding", changedReturn), { stopReason: "toolUse" })
			: fauxAssistantMessage("No findings.");
	const requests = scriptConversations(
		fake,
		[
			{ match: correctness, replies: [answer, answer] },
			{ match: contracts, replies: [answer, answer, answer, answer, answer, answer] },
		],
		options.verdicts,
	);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const imported = options.imported?.(changeset.id);
	const { verdict } = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts"),
		standards: [],
		models: fake.review,
		checks,
		...(options.store === undefined ? {} : { records: options.store }),
		...(imported === undefined ? {} : { imported }),
	});
	const root = (await harness.root(context)).id;
	const findings = await harness.snapshot(FindingsDocument, root, context);
	const verifications = findings?.items[verdict.all()[0]!.id]?.verifications?.[Revision.key(changeset.revision)];
	return {
		changeset,
		verdict,
		verifications,
		asked: requests[verifierMarker]?.length ?? 0,
		stored: (await options.store?.list(changeset.id)) ?? [],
	};
}

const readOf = (stored: readonly RecordEnvelope[]) =>
	(stored.find(({ kind }) => kind === "round")!.payload as { read: { kind: string; key: string; id: string }[] }).read;

describe("a review that imports a verification record", () => {
	it("asks no verifier for a request the record answers, and stands on the verdicts it holds", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review({ store });
		expect(first.asked).toBeGreaterThan(0);
		const id = first.verdict.all()[0]!.id;

		// This host's verifier would refute the finding, so a verdict that still confirms it came from the record.
		const second = await review({
			store: new MemoryRecordStore({ payloads: reviewPayloads }),
			imported: (changeset) => ImportedRecords.from(changeset, first.stored),
			verdicts: refuting(id),
		});
		expect(second.asked).toBe(0);
		// The record it stood on is the one it exports, so its round reads the same verification as the first host's.
		const verificationOf = (stored: readonly RecordEnvelope[]) =>
			stored.filter(({ kind }) => kind === "verification");
		expect(verificationOf(second.stored)).toEqual(verificationOf(first.stored));
		expect(readOf(second.stored).filter(({ kind }) => kind === "verification")).toEqual(
			readOf(first.stored).filter(({ kind }) => kind === "verification"),
		);
		expect(second.verifications).toEqual(first.verifications);
		expect(second.verdict.all().map((finding) => finding.toJSON())).toEqual(
			first.verdict.all().map((finding) => finding.toJSON()),
		);
		expect(second.verdict.blocking).toBe(first.verdict.blocking);
	});

	it.each([
		[
			"names another request",
			(record: RecordEnvelope): RecordEnvelope => ({ ...record, key: `${record.key.slice(0, -1)}0` }),
		],
		[
			"left its candidate unanswered",
			(record: RecordEnvelope): RecordEnvelope => {
				const payload = record.payload as { outcomes: { candidate: string }[] };
				return {
					...record,
					payload: {
						...payload,
						outcomes: payload.outcomes.map(({ candidate }) => ({
							candidate,
							outcome: { status: "unanswered", reason: "superseded" },
						})),
					} as unknown as RecordEnvelope["payload"],
				};
			},
		],
	] as const)("asks the verifier when the only verification record %s", async (_, plant) => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review({ store });
		const id = first.verdict.all()[0]!.id;
		const records = first.stored.map((record) => (record.kind === "verification" ? plant(record) : record));

		const second = await review({
			imported: (changeset) => ImportedRecords.from(changeset, records),
			verdicts: refuting(id),
		});
		expect(second.asked).toBeGreaterThan(0);
		expect(Object.values(Object.values(second.verifications ?? {})[0] ?? {})[0]).toMatchObject({
			verdict: "refuted",
		});
	});
});
