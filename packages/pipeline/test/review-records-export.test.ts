import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Changeset,
	DirectoryRecordStore,
	defaultConfig,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	Revision,
	reviewPayloads,
	SharedRecord,
	TierAccount,
} from "@melian-agent/core";
import {
	ChangeLenses,
	type CheckRun,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	type Message,
	openHarness,
	type ReviewOptions,
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
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { type CheckRunRecord, headCodeChecks } from "../src/checks.ts";
import { FindingsDocument } from "../src/findings.ts";
import type { ConversationId, Tx } from "../src/harness.ts";
import { RelayBatch } from "../src/record-relay.ts";
import { ReviewRecords } from "../src/review-records.ts";
import { provenRun } from "./fixtures/proven-run.ts";
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

async function review(
	store: MemoryRecordStore | undefined,
	given: typeof checks = checks,
	walkthrough?: Walkthrough,
	named: readonly string[] = ["correctness", "contracts"],
	run: { readonly checkRun?: CheckRun; readonly proven?: true } = {},
) {
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
	const checkRun = run.proven ? await provenRun(harness, changeset, given) : run.checkRun;
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
		lenses: (await Lens.builtins()).filter(({ name }) => named.includes(name)),
		standards: [],
		models: fake.review,
		...(checkRun === undefined
			? { checks: given }
			: // A run built here names this review's revision, as a review refuses one that names another.
				{
					checkRun: {
						...checkRun,
						identity: { ...checkRun.identity, base: changeset.revision.base, head: changeset.revision.head },
					},
				}),
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

		const kinds = stored.map(({ kind }) => kind).sort();
		expect(kinds).toEqual(["account", "check", "check", "check", "lens", "lens", "round", "verification"]);
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

	it("exports a batch the relay takes whole, under the tier the review read", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { changeset, stored } = await review(store);
		const directory = await mkdtemp(join(tmpdir(), "melian-relay-export-"));
		try {
			const artefact = await DirectoryRecordStore.open(directory, reviewPayloads);
			await artefact.add(stored);
			await artefact.close();
			const config = { ...defaultConfig, tiers: twoLensTiers };
			const lenses = (await Lens.builtins()).filter(({ name }) => ["correctness", "contracts"].includes(name));
			const selection = await ChangeLenses.read({ changeset, lenses, config, tier: "full", floor: "quick" });
			const batch = await RelayBatch.read(directory, {
				changeset: changeset.id,
				revision: Revision.key(changeset.revision),
				fork: false,
				tier: TierAccount.of(config, "full", selection.tierLenses()),
				handedOver: headCodeChecks,
			});
			expect(batch.records).toHaveLength(stored.length);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("exports nothing until adjudication decides, then each lens run once, with its check, beside the round", async () => {
		const adds: RecordEnvelope[][] = [];
		const store = new (class extends MemoryRecordStore {
			override async add(records: RecordEnvelope[]) {
				adds.push(structuredClone(records));
				return super.add(records);
			}
		})({ payloads: reviewPayloads });
		await review(store);

		expect(adds).toHaveLength(1);
		const lenses = adds[0]!.filter(({ kind }) => kind === "lens");
		expect(lenses.map(({ payload }) => (payload as { check: { name: string } | null }).check?.name).sort()).toEqual([
			"lens.contracts",
			"lens.correctness",
		]);
	});

	it("exports a host's record that names an absent field as undefined", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const given = checks.map((check) =>
			check.name === "guardrails" ? { ...check, notes: undefined as never, error: undefined } : check,
		);
		// A static check's record is the one its run stored, so only a check outside the run takes the host's.
		const { stored } = await review(store, given);
		const guardrails = stored.find(
			({ kind, payload }) =>
				kind === "check" && (payload as { result: { name: string } }).result.name === "guardrails",
		)!.payload as { result: { notes: string[] } };
		expect(guardrails.result.notes).toEqual([]);
	});

	it("names no round as replaced, though another host's blocking round is stored, which leaves what blocks unchanged", async () => {
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
		expect((own.payload as { replaces: string[] }).replaces).toEqual([]);
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

describe("a check record's key", () => {
	const requestKey = "a".repeat(64);
	const checkKeys = async (run: { readonly checkRun?: CheckRun }) => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { stored } = await review(store, checks, undefined, ["correctness", "contracts"], run);
		return stored
			.filter(({ kind }) => kind === "check")
			.map(({ key }) => key)
			.sort();
	};
	const runOf = (task: number, request = requestKey): CheckRun => ({
		identity: {
			base: "b".repeat(40),
			head: "c".repeat(40),
			tier: "full",
			policy: request.slice(0, 16),
			task,
		},
		request,
		records: checks,
	});

	it("is the same for two runs of one request that differ only in their task", async () => {
		const seven = await checkKeys({ checkRun: runOf(7) });
		const twelve = await checkKeys({ checkRun: runOf(12) });
		expect(seven).toHaveLength(3);
		expect(twelve).toEqual(seven);
	});

	it("differs for two runs whose requests differ past the identity's prefix", async () => {
		const other = `${requestKey.slice(0, 16)}${"b".repeat(48)}`;
		const one = await checkKeys({ checkRun: runOf(7) });
		const two = await checkKeys({ checkRun: runOf(7, other) });
		expect(one).toHaveLength(3);
		expect(two).toHaveLength(3);
		expect(two.filter((key) => one.includes(key))).toEqual([]);
	});

	it("is the key the record store derives from the request, the revision and the check's name", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { changeset, stored } = await review(store, checks, undefined, ["correctness", "contracts"], {
			checkRun: runOf(7),
		});
		const records = ReviewRecords.of(changeset.id, changeset.revision);
		const biome = stored.find(
			({ kind, payload }) =>
				kind === "check" && (payload as { result: { name: string } }).result.name === "static.biome",
		)!;
		expect(biome.key).toBe(records.check(requestKey, checks[1] as CheckRunRecord, []).key);
	});

	it("takes its request from the run it exports, which no option can pair with another run's", async () => {
		expectTypeOf<ReviewOptions>().not.toHaveProperty("checkRequest");
		const other = `${requestKey.slice(0, 16)}${"b".repeat(48)}`;
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { changeset, stored } = await review(store, checks, undefined, ["correctness", "contracts"], {
			checkRun: runOf(7, other),
		});
		const records = ReviewRecords.of(changeset.id, changeset.revision);
		expect(
			stored
				.filter(({ kind }) => kind === "check")
				.map(({ key }) => key)
				.sort(),
		).toEqual(
			checks
				.filter(({ name }) => name !== "decisions.fast")
				.map((check) => records.check(other, check as CheckRunRecord, []).key)
				.sort(),
		);
	});

	it("under no request never matches the key of a run under one", async () => {
		const none = await checkKeys({});
		const known = await checkKeys({ checkRun: runOf(7) });
		expect(none).toHaveLength(3);
		expect(none.filter((key) => known.includes(key))).toEqual([]);
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

	it("exports the walkthrough of a review that runs no lens", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { stored } = await review(store, checks, { started: (summarize) => summarize("pull-request") }, []);

		const walkthroughs = stored.filter(({ kind }) => kind === "walkthrough");
		expect(walkthroughs).toHaveLength(1);
		expect(roundOf(stored).walkthrough).toEqual({
			key: walkthroughs[0]!.key,
			id: SharedRecord.parseEnvelope(walkthroughs[0]!).id,
		});
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

	it("exports the findings adjudication decided from, though another review changed them while it waited", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { stored, verdict } = await review(store, checks, {
			// A later review of the revision replaces this one's lens task and clears its sightings while this one waits.
			started: async () => {
				const open = harness!;
				const root = await open.root(context);
				while (Object.keys((await open.snapshot(VerdictDocument, root.id, context))?.decisions ?? {}).length === 0)
					await new Promise((resolve) => setTimeout(resolve, 10));
				await root.commit(async (tx) => {
					const findings = await tx.doc(FindingsDocument, root.id);
					for (const item of Object.values(findings.items)) item.sightings = {};
					for (const key of Object.keys(findings.versions)) findings.versions[key] = findings.versions[key]! + 1;
				}, context);
			},
		});

		const named = new Set(
			(stored.find(({ kind }) => kind === "round")!.payload as { read: { id: string }[] }).read.map(({ id }) => id),
		);
		const sighted = stored
			.filter((each) => each.kind === "lens" && named.has(SharedRecord.parseEnvelope(each).id))
			.flatMap((each) =>
				(each.payload as { sightings: { ruleId: string }[] }).sightings.map(({ ruleId }) => ruleId),
			);

		expect(verdict.all().map(({ properties }) => properties.source.check)).toEqual(["lens.contracts"]);
		expect(sighted).toEqual(["changed-return"]);
	});

	it.each([
		[
			"changed the findings",
			async (tx: Tx, id: ConversationId) => {
				const findings = await tx.doc(FindingsDocument, id);
				for (const item of Object.values(findings.items)) item.sightings = {};
				for (const key of Object.keys(findings.versions)) findings.versions[key] = findings.versions[key]! + 1;
			},
		],
		[
			"decided the verdict again",
			async (tx: Tx, id: ConversationId) => {
				const { decisions } = await tx.doc(VerdictDocument, id);
				for (const decision of Object.values(decisions ?? {})) decision.task += 100;
			},
		],
	] as const)(
		"writes no round when another review %s before this one read its findings to export",
		async (_, replace) => {
			const store = new MemoryRecordStore({ payloads: reviewPayloads });
			let cleared = false;
			const { stored, verdict } = await review(store, checks, {
				started: async () => {
					const open = harness!;
					const read = open.snapshot.bind(open) as (
						doc: unknown,
						id: ConversationId,
						given?: unknown,
					) => Promise<unknown>;
					// The first read of the findings once the verdict is decided finds them already cleared by a later review.
					const intercept = async (doc: unknown, id: ConversationId, given?: unknown) => {
						if (doc === FindingsDocument && !cleared) {
							const decided =
								((await read(VerdictDocument, id)) as { decisions?: object } | undefined)?.decisions ?? {};
							if (Object.keys(decided).length > 0) {
								cleared = true;
								await (await open.root(context)).commit((tx) => replace(tx, id), context);
							}
						}
						return read(doc, id, given);
					};
					vi.spyOn(open, "snapshot").mockImplementation(intercept as unknown as Harness["snapshot"]);
				},
			});

			expect(cleared).toBe(true);
			expect(verdict.all().map(({ properties }) => properties.source.check)).toEqual(["lens.contracts"]);
			expect(stored.filter(({ kind }) => kind === "round")).toEqual([]);
		},
	);

	it("waits for no walkthrough when no store is named", async () => {
		const began = Date.now();
		const { verdict } = await review(undefined, checks, { started: () => new Promise(() => {}), wait: 60_000 });

		expect(verdict.all().map(({ properties }) => properties.source.check)).toEqual(["lens.contracts"]);
		expect(Date.now() - began).toBeLessThan(30_000);
	});
});
