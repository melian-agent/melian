import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	Lens,
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
	type Message,
	openHarness,
	reviewChangeset,
	summarizeReview,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRecords } from "../src/review-records.ts";
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

const walkthroughPrompt = "You write Melian's walkthrough";
const recorded = fauxAssistantMessage(
	[
		fauxToolCall("record_walkthrough", {
			summary: "Changes a.",
			files: [{ path: "src/a.ts", summary: "Sets a to 2." }],
		}),
	],
	{ stopReason: "toolUse" },
);

type Walkthrough = {
	// What the review's `lensesStarted` returns, given a call that writes the walkthrough on the given origin.
	readonly started: (summarize: (origin: "pull-request" | "range") => Promise<void>) => unknown;
	readonly reply?: ReturnType<typeof fauxAssistantMessage>;
	readonly wait?: number;
};

async function review(store: MemoryRecordStore | undefined, given: typeof checks = checks, walkthrough?: Walkthrough) {
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
		...(walkthrough === undefined ? [] : [{ match: walkthroughPrompt, replies: [walkthrough.reply ?? recorded] }]),
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const open = harness;
	const summarize = (origin: "pull-request" | "range") =>
		summarizeReview({
			harness: open,
			changeset,
			config,
			models: fake.review,
			origin:
				origin === "range"
					? { kind: "range" }
					: {
							kind: "pull-request",
							repository: { owner: "melian-agent", name: "example" },
							pullRequest: 7,
							base: changeset.revision.base,
							head: changeset.revision.head,
						},
		});
	const result = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts"),
		standards: [],
		models: fake.review,
		checks: given,
		...(store === undefined ? {} : { records: store }),
		...(walkthrough === undefined ? {} : { lensesStarted: () => walkthrough.started(summarize) }),
		...(walkthrough?.wait === undefined ? {} : { walkthroughWait: walkthrough.wait }),
	});
	return { changeset, verdict: result.verdict, stored: (await store?.list(changeset.id)) ?? [] };
}

const roundOf = (stored: RecordEnvelope[]) =>
	stored.find(({ kind }) => kind === "round")!.payload as { walkthrough: { key: string; id: string } | null };

describe("a review that names a record store", () => {
	it("exports each check, lens run and verification, the account, and a round that names them all", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { changeset, stored } = await review(store);

		// Each lens run's early copy, with no check, stays beside the final one the round names.
		const kinds = stored.map(({ kind }) => kind).sort();
		expect(kinds).toEqual([
			"account",
			"check",
			"check",
			"check",
			"lens",
			"lens",
			"lens",
			"lens",
			"round",
			"verification",
		]);
		const round = stored.find(({ kind }) => kind === "round")!;
		const read = (round.payload as { read: { kind: string; key: string; id: string }[] }).read;
		expect(read.map(({ kind }) => kind).sort()).toEqual([
			"account",
			"check",
			"check",
			"check",
			"lens",
			"lens",
			"verification",
		]);
		const named = new Set(read.map(({ id }) => id));
		const lensChecks = stored
			.filter(({ kind }) => kind === "lens")
			.filter((record) => named.has(SharedRecord.parseEnvelope(record).id))
			.map(({ payload }) => (payload as { check: { name: string; status: string } | null }).check);
		expect(lensChecks.map((check) => [check?.name, check?.status]).sort()).toEqual([
			["lens.contracts", "ran"],
			["lens.correctness", "ran"],
		]);
		const verification = stored.find(({ kind }) => kind === "verification")!.payload as {
			claims: { id: string; verification: { verdict: string; matches?: unknown } }[];
			dismissals: unknown[];
			check: { name: string; status: string } | null;
		};
		expect(verification.check).toMatchObject({ name: "verifier", status: "ran" });
		expect(verification.claims).toHaveLength(1);
		expect(verification.claims[0]!.verification.matches).toBeUndefined();
		expect(verification.dismissals).toEqual([]);
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
			"verifier",
		]);
		expect(account.filled.map(({ name }) => name)).toEqual(["decisions.fast"]);
		const contractsRun = stored.find(
			({ kind, payload }) => kind === "lens" && (payload as { name: string }).name === "contracts",
		)!.payload as { sightings: { ruleId: string }[] };
		expect(contractsRun.sightings.map(({ ruleId }) => ruleId)).toEqual(["changed-return"]);
		expect(stored.every((record) => record.changeset === changeset.id)).toBe(true);
	});

	it("exports each lens run as its lens ends, with no check, which the round's export adds", async () => {
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
		const unchecked = (records: RecordEnvelope[]) =>
			[...records]
				.sort((a, b) => a.key.localeCompare(b.key))
				.map((record) => ({ ...record, payload: { ...(record.payload as object), check: null } }));
		expect(early.every(({ payload }) => (payload as { check: unknown }).check === null)).toBe(true);
		expect(final.every(({ payload }) => (payload as { check: unknown }).check !== null)).toBe(true);
		expect(unchecked(early)).toEqual(unchecked(final));
		expect(stored.filter(({ kind }) => kind === "lens")).toHaveLength(4);
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

	it("names another host's blocking round as replaced, which leaves what blocks unchanged", async () => {
		const plain = await review(new MemoryRecordStore({ payloads: reviewPayloads }));
		await harness?.close(context);
		harness = undefined;

		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const records = ReviewRecords.of(plain.changeset.id, plain.changeset.revision);
		const failed = records.check(
			"another host's run",
			{ name: "guardrails", status: "failed", reason: "toolFailed", error: "guardrails could not run" },
			[],
		);
		const foreign = records.round([failed], undefined, [], []);
		await store.add([failed.toJSON(), foreign.toJSON()]);
		const { verdict, stored } = await review(store);

		const own = stored.filter(({ kind }) => kind === "round").find(({ key }) => key !== foreign.key)!;
		expect((own.payload as { replaces: string[] }).replaces).toEqual([foreign.id]);
		expect(verdict.status).toBe(plain.verdict.status);
		expect(verdict.blocking).toBe(plain.verdict.blocking);
		expect(verdict.all().map(({ id }) => id)).toEqual(plain.verdict.all().map(({ id }) => id));
		expect(verdict.findings.block.map(({ id }) => id)).toEqual(plain.verdict.findings.block.map(({ id }) => id));
	});

	it("adds the same bytes when the same head is reviewed again", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = (await review(store)).stored;
		const second = (await review(store)).stored;
		expect(second).toEqual(first);
	});
});

describe("a review that names a record store and writes a walkthrough", () => {
	it("exports the walkthrough publication would post, and the round names it", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { stored } = await review(store, checks, { started: (summarize) => summarize("pull-request") });

		const walkthroughs = stored.filter(({ kind }) => kind === "walkthrough");
		expect(walkthroughs).toHaveLength(1);
		const [written] = walkthroughs;
		expect(written!.payload).toEqual({
			v: 1,
			route: "faux/light@",
			summary: "Changes a.",
			files: [{ path: "src/a.ts", summary: "Sets a to 2." }],
			diagram: null,
			note: null,
		});
		expect(roundOf(stored).walkthrough).toEqual({ key: written!.key, id: SharedRecord.parseEnvelope(written!).id });
	});

	it.each([
		[
			"the summariser records nothing",
			{ started: (summarize) => summarize("pull-request"), reply: fauxAssistantMessage("No summary.") },
		],
		["the walkthrough's promise rejects", { started: () => Promise.reject(new Error("the summariser failed")) }],
		["the review is of a range", { started: (summarize) => summarize("range") }],
	] satisfies [string, Walkthrough][])("writes the round with no walkthrough when %s", async (_, walkthrough) => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { stored, verdict } = await review(store, checks, walkthrough);

		expect(stored.filter(({ kind }) => kind === "walkthrough")).toEqual([]);
		expect(roundOf(stored).walkthrough).toBeNull();
		expect(verdict.all().map(({ properties }) => properties.source.check)).toEqual(["lens.contracts"]);
	});

	it("writes the round with no walkthrough once the wait has passed, though the walkthrough was stored", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let finished: Promise<void> | undefined;
		const { stored } = await review(store, checks, {
			// The walkthrough is stored before the round, and what the host returned settles only after it.
			started: (summarize) => {
				finished = summarize("pull-request").then(() => gate);
				return finished;
			},
			wait: 50,
		});
		release();
		await finished;

		expect(stored.filter(({ kind }) => kind === "walkthrough")).toEqual([]);
		expect(roundOf(stored).walkthrough).toBeNull();
	});

	it("waits for no walkthrough when no store is named", async () => {
		const began = Date.now();
		const { verdict } = await review(undefined, checks, { started: () => new Promise(() => {}), wait: 60_000 });

		expect(verdict.all().map(({ properties }) => properties.source.check)).toEqual(["lens.contracts"]);
		expect(Date.now() - began).toBeLessThan(30_000);
	});
});
