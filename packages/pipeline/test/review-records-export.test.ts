import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
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
	await reviewChangeset({
		harness,
		changeset,
		config,
		lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts"),
		standards: [],
		models: fake.review,
		checks: given,
		records: store,
	});
	return { changeset, stored: await store.list(changeset.id) };
}

describe("a review that names a record store", () => {
	it("exports each check and lens run, the account, and a round that names them all", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { changeset, stored } = await review(store);

		const kinds = stored.map(({ kind }) => kind).sort();
		expect(kinds).toEqual(["account", "check", "check", "check", "lens", "lens", "round"]);
		const round = stored.find(({ kind }) => kind === "round")!;
		const read = (round.payload as { read: { kind: string; key: string }[] }).read;
		expect(read.map(({ kind }) => kind).sort()).toEqual(["account", "check", "check", "check", "lens", "lens"]);
		const account = stored.find(({ kind }) => kind === "account")!.payload as {
			checks: string[];
			filled: { name: string; status: string }[];
		};
		expect(account.checks).toEqual([
			"guardrails",
			"static.biome",
			"static.tsc",
			"decisions.fast",
			"lens.correctness",
			"lens.contracts",
		]);
		expect(account.filled.map(({ name }) => name)).toEqual(["decisions.fast"]);
		const contractsRun = stored.find(
			({ kind, payload }) => kind === "lens" && (payload as { name: string }).name === "contracts",
		)!.payload as { sightings: { ruleId: string }[] };
		expect(contractsRun.sightings.map(({ ruleId }) => ruleId)).toEqual(["changed-return"]);
		expect(stored.every((record) => record.changeset === changeset.id)).toBe(true);
	});

	it("exports each lens run as its lens ends, with the bytes the round's export adds again", async () => {
		const adds: RecordEnvelope[][] = [];
		const store = new (class extends MemoryRecordStore {
			override async add(records: RecordEnvelope[]) {
				adds.push(structuredClone(records));
				return super.add(records);
			}
		})({ payloads: reviewPayloads });
		const { stored } = await review(store);

		const last = adds.findIndex((records) => records.some(({ kind }) => kind === "round"));
		expect(last).toBe(adds.length - 1);
		const early = adds.slice(0, last).flat();
		expect(early.map(({ kind }) => kind)).toEqual(["lens", "lens"]);
		const final = adds[last]!.filter(({ kind }) => kind === "lens");
		expect([...early].sort((a, b) => a.key.localeCompare(b.key))).toEqual(
			[...final].sort((a, b) => a.key.localeCompare(b.key)),
		);
		expect(stored.filter(({ kind }) => kind === "lens")).toHaveLength(2);
	});

	it("exports a host's record that names an absent field as undefined", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const given = checks.map((check) =>
			check.name === "static.biome" ? { ...check, notes: undefined as never, error: undefined } : check,
		);
		const { stored } = await review(store, given);
		const biome = stored.find(
			({ kind, payload }) =>
				kind === "check" && (payload as { result: { name: string } }).result.name === "static.biome",
		)!.payload as { result: { notes: string[] } };
		expect(biome.result.notes).toEqual([]);
	});

	it("adds the same bytes when the same head is reviewed again", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = (await review(store)).stored;
		const second = (await review(store)).stored;
		expect(second).toEqual(first);
	});
});
