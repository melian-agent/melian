import { rmSync } from "node:fs";
import {
	type AccountPayload,
	Changeset,
	type CheckRecord,
	defaultConfig,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	reviewPayloads,
	SharedRecord,
	TierAccount,
	type TriagePayload,
} from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import {
	ChangeLenses,
	backgroundContext as context,
	createMemoryStorage,
	ReviewHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv } from "./fixtures/repo.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

// A round exports its triage record and names it, so a reader of the shared records can check a skip triage allowed.

const correctness = "You are the correctness reviewer";
const ran: CheckRecord[] = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
];

let repo: string;
let reviewHarness: ReviewHarness | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = crashRepository();
});

afterEach(async () => {
	await reviewHarness?.close(context);
	reviewHarness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

async function exported(chosen: "skip" | "quick") {
	const fake = createFakeModels({
		models: [{ id: "orchestrator" }, { id: "light" }, { id: "medium" }, { id: "heavy" }],
	});
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	const config: MelianConfig = {
		...defaultConfig,
		tiers: { ...defaultConfig.tiers, full: ["guardrails", "static", "lens.correctness"] },
		models: { light: route("light"), medium: route("medium"), heavy: route("heavy") },
		lenses: { correctness: { level: { floor: "skip" } } },
	};
	const decider = new RecordedDecider(
		{ triage: { version: "1", answers: { correctness: { distribution: { [chosen]: 1 } } } } },
		{ name: "recorded", calibrated: true },
	);
	reviewHarness = await ReviewHarness.open(createMemoryStorage(), fake.review, { retry: false, decider });
	const { harness } = reviewHarness;
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	scriptConversations(fake, [{ match: correctness, replies: [fauxAssistantMessage("Done.")] }]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const lenses = await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, [
		"src/user.ts",
	]);
	const store = new MemoryRecordStore({ payloads: reviewPayloads });
	await reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: [],
		models: fake.review,
		checks: ran,
		decider,
		records: store,
	});
	const records = (await store.list(changeset.id)).map((each) => SharedRecord.parse(each, reviewPayloads));
	const round = records.find(({ kind }) => kind === "round")!;
	const read = new Set((round.payload as { read: { id: string }[] }).read.map(({ id }) => id));
	const named = records.filter(({ id }) => read.has(id));
	const coverage = await ChangeLenses.read({ changeset, lenses, config, tier: "full", floor: "quick" });
	return { named, account: TierAccount.of(config, "full", coverage.tierLenses()) };
}

// What a reader takes from the round's records: the account's claim, every check record it holds, and triage's decision.
function facts(named: readonly SharedRecord[]) {
	const account = named.find(({ kind }) => kind === "account")!.payload as AccountPayload;
	const triage = named.find(({ kind }) => kind === "triage")?.payload as TriagePayload | undefined;
	const lens = named
		.filter(({ kind }) => kind === "lens")
		.flatMap(({ payload }) => {
			const { check } = payload as { check: CheckRecord | null };
			return check === null ? [] : [check];
		});
	const checks = named
		.filter(({ kind }) => kind === "check")
		.map(({ payload }) => (payload as unknown as { result: CheckRecord }).result);
	return {
		claim: { checks: account.checks, allowSkip: account.allowSkip },
		facts: {
			records: [...checks, ...lens, ...(account.filled as CheckRecord[])],
			...(triage?.decision == null
				? {}
				: {
						triage: {
							answers: triage.decision.answers.map(({ question, chosen }) => ({ question, chosen })),
							inputCut: triage.inputCut,
						},
					}),
		},
	};
}

describe("a round's triage record", () => {
	it("is named by the round, with triage's choice and whether its input was cut", async () => {
		const { named } = await exported("skip");

		const triage = named.filter(({ kind }) => kind === "triage");
		expect(triage).toHaveLength(1);
		expect(triage[0]!.payload).toMatchObject({
			decision: { decider: "recorded", answers: [{ question: "correctness", chosen: "skip" }] },
			failure: null,
			inputCut: false,
		});
		const account = named.find(({ kind }) => kind === "account")!.payload as AccountPayload;
		expect(account.records).toContain(triage[0]!.id);
	});

	it("lets a reader check an account that allows a triage skip", async () => {
		const { named, account } = await exported("skip");
		const { claim, facts: read } = facts(named);

		expect(claim.allowSkip).toEqual(["lens.correctness"]);
		expect(account.refusal(claim, read)).toBeUndefined();
	});

	it("is what makes that account match: without it the reader refuses the skip", async () => {
		const { named, account } = await exported("skip");
		const { claim, facts: read } = facts(named.filter(({ kind }) => kind !== "triage"));

		expect(account.refusal(claim, read)).toBe("otherSkips");
	});

	it("is named when triage chose a level, and the account then allows no skip", async () => {
		const { named, account } = await exported("quick");
		const { claim, facts: read } = facts(named);

		expect(named.filter(({ kind }) => kind === "triage")).toHaveLength(1);
		expect(claim.allowSkip).toEqual([]);
		expect(account.refusal(claim, read)).toBeUndefined();
	});
});
