import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	everyRecordCounts,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	reviewPayloads,
	SharedRecord,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	type Message,
	openHarness,
	RecordedRound,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const checks = [
	{ name: "guardrails", status: "ran" as const, findings: 0, notes: [] },
	{ name: "static.biome", status: "ran" as const, version: "2.5.0", findings: 0, notes: [] },
	{ name: "static.tsc", status: "skipped" as const, reason: "no TypeScript project" },
	{ name: "decisions.fast", status: "skipped" as const, reason: "no decision provider is configured" },
];

let repo: string;
let harness: Harness | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

async function review(store: MemoryRecordStore, given: typeof checks = checks) {
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	const config: MelianConfig = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
	};
	harness ??= await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	const answer = (messages: readonly Message[]) =>
		systemPromptOf(messages).includes(contracts) && !messages.some((message) => message.role === "toolResult")
			? fauxAssistantMessage(fauxToolCall("report_finding", changedReturn), { stopReason: "toolUse" })
			: fauxAssistantMessage("No findings.");
	scriptConversations(fake, [
		{ match: correctness, replies: [answer, answer] },
		{ match: contracts, replies: [answer, answer, answer] },
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const result = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts"),
		standards: [],
		models: fake.review,
		checks: given,
		records: store,
	});
	return { changeset, config, verdict: result.verdict, stored: await store.list(changeset.id) };
}

// The round the review exported last: the one no other round of its revision names as replaced.
function roundOf(stored: readonly { kind: string }[]) {
	const rounds = stored.filter(({ kind }) => kind === "round") as Parameters<typeof SharedRecord.parseEnvelope>[0][];
	return SharedRecord.parseEnvelope(rounds.at(-1)!).id;
}

async function read(reviewed: Awaited<ReturnType<typeof review>>) {
	const round = RecordedRound.of(reviewed.stored, roundOf(reviewed.stored), everyRecordCounts);
	return round.verdict({ revision: reviewed.changeset.revision, config: reviewed.config });
}

describe("a round read back from its records", () => {
	it("decides the verdict the review decided", async () => {
		const reviewed = await review(new MemoryRecordStore({ payloads: reviewPayloads }));
		expect((await read(reviewed)).toJSON()).toEqual(reviewed.verdict.toJSON());
	});
});
