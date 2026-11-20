import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	everyRecordCounts,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	RecordError,
	type RecordJson,
	RecordSet,
	type RepositorySource,
	Revision,
	reviewPayloads,
	SharedRecord,
} from "@melian-agent/core";
import {
	type CheckRun,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	type Message,
	openHarness,
	RecordedRound,
	type RecordedRoundContents,
	type ReviewOptions,
	readVerdict,
	recordDismissal,
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
import type { CheckRunRecord } from "../src/checks.ts";
import { DismissError } from "../src/errors.ts";
import { dismissFinding, FindingsDocument } from "../src/findings.ts";
import { type ConversationId, StorageRejected, type Tx } from "../src/harness.ts";
import { ReviewRecords } from "../src/review-records.ts";
import { provenRun } from "./fixtures/proven-run.ts";
import { baseAndHead, commit, isolatedGitEnv, lines } from "./fixtures/repo.ts";
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
	run: { readonly checkRun?: CheckRun; readonly proven?: true; readonly policy?: RepositorySource } = {},
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
		{ match: correctness, replies: Array.from({ length: 32 }, () => answer) },
		{ match: contracts, replies: Array.from({ length: 32 }, () => answer) },
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
		...(run.policy === undefined ? {} : { policy: run.policy }),
		...(walkthrough === undefined ? {} : { lensesStarted: () => walkthrough.started(summarize) }),
		...(walkthrough?.wait === undefined ? {} : { walkthroughWait: walkthrough.wait }),
	});
	return {
		changeset,
		verdict: result.verdict,
		unshared: result.unshared,
		stored: (await store?.list(changeset.id)) ?? [],
	};
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

	it("fails the review with a record error when the store lists a round whose payload is no round", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review(store);
		const earlier = first.stored.find(({ kind }) => kind === "round")!;
		commit(repo, { "src/b.ts": lines("export const b = 1;") });
		const list = store.list.bind(store);
		vi.spyOn(store, "list").mockImplementation(async (id) => [
			...(await list(id)).filter((each) => SharedRecord.parseEnvelope(each).kind !== "round"),
			{ ...earlier, payload: null },
		]);
		await expect(review(store)).rejects.toBeInstanceOf(RecordError);
	});

	it("names in before the rounds of the revision before that its store held when the review began, and no later one", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review(store);
		const earlier = first.stored.find(({ kind }) => kind === "round")!;
		const { base, head } = first.changeset.revision;
		const late = ReviewRecords.of(first.changeset.id, { base, head }).round([], undefined, [], []);
		commit(repo, { "src/b.ts": lines("export const b = 1;") });
		const list = store.list.bind(store);
		let listed = 0;
		vi.spyOn(store, "list").mockImplementation(async (id) => {
			const held = await list(id);
			if (listed++ === 0) await store.add([late.toJSON()]);
			return held;
		});
		const later = await review(store);
		const round = later.stored.find(({ kind, revision }) => kind === "round" && revision !== earlier.revision)!
			.payload as { before: string[] };
		expect(later.stored.map((each) => SharedRecord.parseEnvelope(each).id)).toContain(late.id);
		expect(round.before).toEqual([SharedRecord.parseEnvelope(earlier).id]);
	});

	it("names in before, on a host with no history of the changeset, each round of another revision no other names", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const rounds = async () => {
			const held = (await store.list((await Changeset.resolve(repo, "main...feature")).id)).filter(
				({ kind }) => kind === "round",
			);
			return held.map((each) => ({
				id: SharedRecord.parseEnvelope(each).id,
				...(each.payload as { before: string[] }),
				revision: each.revision,
			}));
		};
		const fresh = async () => {
			await harness?.close(context);
			harness = undefined;
			commit(repo, { [`src/${(await rounds()).length}.ts`]: lines("export const n = 1;") });
			return review(store);
		};
		const first = await review(store);
		const [one] = await rounds();
		const second = await fresh();
		const two = (await rounds()).find(({ revision }) => revision === Revision.key(second.changeset.revision))!;
		expect(two.before).toEqual([one!.id]);
		const third = await fresh();
		const three = (await rounds()).find(({ revision }) => revision === Revision.key(third.changeset.revision))!;
		expect(three.before).toEqual([two.id]);
		expect(first.changeset.id).toBe(third.changeset.id);
	});

	it("names in before every branch of a forked history, on a host with no history of the changeset", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review(store);
		const [earlier] = first.stored.filter(({ kind }) => kind === "round");
		const other = ReviewRecords.of(first.changeset.id, { base: "4".repeat(40), head: "5".repeat(40) }).round(
			[],
			undefined,
			[],
			[],
		);
		await store.add([other.toJSON()]);
		await harness?.close(context);
		harness = undefined;
		commit(repo, { "src/b.ts": lines("export const b = 1;") });
		const later = await review(store);
		const round = later.stored.find(
			({ kind, revision }) => kind === "round" && revision === Revision.key(later.changeset.revision),
		)!.payload as { before: string[] };
		expect(round.before).toEqual([SharedRecord.parseEnvelope(earlier!).id, other.id].sort());
	});

	it("names in before no round of its own revision, on a host with no history of the changeset", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review(store);
		const [earlier] = first.stored.filter(({ kind }) => kind === "round");
		commit(repo, { "src/b.ts": lines("export const b = 1;") });
		const second = await review(store);
		const own = Revision.key(second.changeset.revision);
		const [held] = second.stored.filter(({ kind, revision }) => kind === "round" && revision === own);
		await harness?.close(context);
		harness = undefined;
		const again = await review(store, checks, undefined, ["contracts"]);
		const round = again.stored.find(
			(each) => each.kind === "round" && each.revision === own && each.key !== held!.key,
		)!.payload as { before: string[] };
		expect(round.before).toEqual([SharedRecord.parseEnvelope(earlier!).id]);
	});

	it("names in before the rounds of its previous revision and another branch's, on a host with history", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review(store);
		const [earlier] = first.stored.filter(({ kind }) => kind === "round");
		const other = ReviewRecords.of(first.changeset.id, { base: "4".repeat(40), head: "5".repeat(40) }).round(
			[],
			undefined,
			[],
			[],
		);
		await store.add([other.toJSON()]);
		commit(repo, { "src/b.ts": lines("export const b = 1;") });
		const later = await review(store);
		const round = later.stored.find(
			({ kind, revision }) => kind === "round" && revision === Revision.key(later.changeset.revision),
		)!.payload as { before: string[] };
		expect(round.before).toEqual([SharedRecord.parseEnvelope(earlier!).id, other.id].sort());
	});

	it("names in before another host's round written since its own, on a host with history", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const roundOf = (stored: readonly RecordEnvelope[], revision: string) =>
			stored.find((each) => each.kind === "round" && each.revision === revision)!;
		const first = await review(store);
		const one = roundOf(first.stored, Revision.key(first.changeset.revision));
		const hostA = harness;
		harness = undefined;
		commit(repo, { "src/b.ts": lines("export const b = 1;") });
		const second = await review(store);
		const two = roundOf(second.stored, Revision.key(second.changeset.revision));
		const hostB = () => harness;
		await hostB()?.close(context);
		harness = hostA;
		commit(repo, { "src/c.ts": lines("export const c = 1;") });
		const third = await review(store);

		const three = roundOf(third.stored, Revision.key(third.changeset.revision)).payload as { before: string[] };
		expect((two.payload as { before: string[] }).before).toEqual([SharedRecord.parseEnvelope(one).id]);
		expect(three.before).toEqual([SharedRecord.parseEnvelope(one).id, SharedRecord.parseEnvelope(two).id].sort());
	});

	it("adds the same bytes when the same head is reviewed again", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = (await review(store)).stored;
		const second = (await review(store)).stored;
		expect(second).toEqual(first);
	});
});

const dismissal = { by: "Maintainer", reason: "a is meant to be 2 now.", at: "2026-11-16T00:00:00.000Z" };
const dismissalsOf = (stored: RecordEnvelope[]) => stored.filter(({ kind }) => kind === "dismissal");

// A review, and its finding dismissed as `melian dismiss --records` dismisses it, into `store`, or with no store when
// `shared` is false.
async function dismissedReview(store: MemoryRecordStore, shared = true) {
	const first = await review(store);
	const id = first.verdict.all().find(({ ruleId }) => ruleId === "changed-return")!.id;
	const records = shared ? { records: { store, changeset: first.changeset.id } } : {};
	await recordDismissal({
		harness: harness!,
		repoRoot: repo,
		revision: first.changeset.revision,
		id,
		dismissal,
		...records,
	});
	return { first, id };
}

describe("a review that names a record store after a dismissal", () => {
	it("shares no dismissal made with no store, and names it as unshared", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { id } = await dismissedReview(store, false);
		const later = await review(store);
		expect(dismissalsOf(later.stored)).toEqual([]);
		expect(later.unshared).toEqual([{ finding: id, code: "madeWithoutStore" }]);
	});

	it("shares the dismissal as melian dismiss stored it, at the head it was made at, naming the rounds its store held", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { first, id } = await dismissedReview(store);
		expect(dismissalsOf(first.stored)).toEqual([]);
		const held = (await store.list(first.changeset.id)).filter(({ kind }) => kind === "round");
		expect(held).toHaveLength(1);

		const { stored } = await review(store);
		const root = (await harness!.root(context)).id;
		const { lifecycle } = (await harness!.snapshot(FindingsDocument, root, context))!.items[id]!;
		const { base, head } = first.changeset.revision;
		expect(dismissalsOf(stored)).toEqual([
			{
				v: 1,
				changeset: first.changeset.id,
				kind: "dismissal",
				key: id,
				payload: {
					v: 1,
					by: dismissal.by,
					reason: dismissal.reason,
					at: dismissal.at,
					severity: "P2",
					sighting: {
						revision: `${base}..${head}`,
						finding: JSON.parse(
							JSON.stringify({
								...lifecycle.dismissedSighting!.sighting,
								properties: { ...lifecycle.dismissedSighting!.sighting.properties, status: "new" },
							}),
						),
					},
					head,
					rounds: [],
					frontier: held.map((each) => SharedRecord.parseEnvelope(each).id),
					trigger: {
						hash: lifecycle.dismissedTrigger!.hash,
						proof: JSON.parse(JSON.stringify(lifecycle.dismissedTrigger!.proof)),
					},
				},
			},
		]);
	});

	it("adds the same dismissal record, by its bytes and its ID, when a later round is exported", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await dismissedReview(store);
		const once = dismissalsOf((await review(store)).stored);
		expect(once).toHaveLength(1);

		commit(repo, { "src/b.ts": lines("export const b = 1;") });
		const later = await review(store);
		expect(later.changeset.revision.head).not.toBe((once[0]!.payload as { head: string }).head);
		const again = dismissalsOf(later.stored);
		expect(again).toEqual(once);
		expect(again.map((each) => SharedRecord.parseEnvelope(each).id)).toEqual(
			once.map((each) => SharedRecord.parseEnvelope(each).id),
		);
	});

	it("writes a dismissal made again with the store as superseding the one it replaced, and the next review writes nothing", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { first, id } = await dismissedReview(store);
		const [once] = dismissalsOf((await review(store)).stored).map((each) => SharedRecord.parseEnvelope(each));
		const again = { ...dismissal, reason: "a is 2 by design.", at: "2026-11-17T00:00:00.000Z" };
		const made = await recordDismissal({
			harness: harness!,
			repoRoot: repo,
			revision: first.changeset.revision,
			id,
			dismissal: again,
			records: { store, changeset: first.changeset.id },
		});
		const written = dismissalsOf(await store.list(first.changeset.id)).map((each) =>
			SharedRecord.parseEnvelope(each),
		);
		const replacing = written.find((each) => each.id !== once!.id)!;
		expect(written).toHaveLength(2);
		expect(replacing.supersedes).toEqual([once!.id]);
		expect((replacing.toJSON().payload as { reason: string }).reason).toBe(again.reason);

		const add = vi.spyOn(store, "add");
		const stored = dismissalsOf((await review(store)).stored).map((each) => SharedRecord.parseEnvelope(each));
		expect(dismissalsOf(add.mock.calls.flatMap(([records]) => [...records]))).toEqual([]);
		expect(stored.map(({ id }) => id).sort()).toEqual(written.map(({ id }) => id).sort());
		const standing = RecordSet.of(stored, { counts: everyRecordCounts, payloads: reviewPayloads }).unsuperseded();
		expect(standing.map(({ id }) => id)).toEqual([replacing.id]);
		expect(made.unshared).toEqual([]);
	});

	it("writes nothing on a second review for a dismissal whose record the store holds", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await dismissedReview(store);
		const once = dismissalsOf((await review(store)).stored);
		expect(once).toHaveLength(1);
		const add = vi.spyOn(store, "add");
		const again = await review(store);
		expect(add).toHaveBeenCalled();
		expect(dismissalsOf(add.mock.calls.flatMap(([records]) => [...records]))).toEqual([]);
		expect(dismissalsOf(again.stored)).toEqual(once);
	});

	it("keeps a dismissal record an earlier build exported with what it superseded, and writes no other", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { first, id } = await dismissedReview(store);
		const [once] = dismissalsOf((await review(store)).stored).map((each) => SharedRecord.parseEnvelope(each));
		const again = { ...dismissal, reason: "a is 2 by design.", at: "2026-11-17T00:00:00.000Z" };
		await recordDismissal({
			harness: harness!,
			repoRoot: repo,
			revision: first.changeset.revision,
			id,
			dismissal: again,
		});
		// An earlier build built the record at export, superseding every dismissal of the finding its listing held.
		const root = (await harness!.root(context)).id;
		const state = (await harness!.snapshot(FindingsDocument, root, context))!;
		const made = ReviewRecords.of(first.changeset.id, first.changeset.revision).madeOf(state, id, [])!.toJSON();
		const { frontier: _, ...unbounded } = made.payload as { frontier?: string[] };
		const earlier = SharedRecord.parse(
			{ ...made, payload: unbounded as RecordJson, supersedes: [once!.id] },
			reviewPayloads,
		);
		await store.add([earlier.toJSON()]);

		const add = vi.spyOn(store, "add");
		const stored = dismissalsOf((await review(store)).stored).map((each) => SharedRecord.parseEnvelope(each));
		expect(dismissalsOf(add.mock.calls.flatMap(([records]) => [...records]))).toEqual([]);
		expect(stored.map(({ id }) => id).sort()).toEqual([once!.id, earlier.id].sort());
		const standing = RecordSet.of(stored, { counts: everyRecordCounts, payloads: reviewPayloads }).unsuperseded();
		expect(standing.map(({ id }) => id)).toEqual([earlier.id]);
	});

	it("shares no dismissal made again with no store, so the record of the one it replaced stands alone", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { first, id } = await dismissedReview(store);
		const [once] = dismissalsOf((await review(store)).stored).map((each) => SharedRecord.parseEnvelope(each));
		const again = { ...dismissal, reason: "a is 2 by design.", at: "2026-11-17T00:00:00.000Z" };
		const made = await recordDismissal({
			harness: harness!,
			repoRoot: repo,
			revision: first.changeset.revision,
			id,
			dismissal: again,
		});
		expect(dismissalsOf(await store.list(first.changeset.id))).toHaveLength(1);

		const later = await review(store);
		expect(dismissalsOf(later.stored).map((each) => SharedRecord.parseEnvelope(each).id)).toEqual([once!.id]);
		expect(later.unshared).toEqual([{ finding: id, code: "madeWithoutStore" }]);
		expect(made.unshared).toEqual([]);
	});

	it("exports no record of a dismissal stored with no sighting, as one before findings document version 11 was", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review(store);
		const id = first.verdict.all().find(({ ruleId }) => ruleId === "changed-return")!.id;
		const root = await harness!.root(context);
		const { base, head } = first.changeset.revision;
		await root.commit((tx) => dismissFinding(tx, root.id, id, dismissal, `${base}..${head}`), context);

		const { stored } = await review(store);
		expect((await harness!.snapshot(FindingsDocument, root.id, context))!.items[id]!.lifecycle.status).toBe(
			"dismissed",
		);
		expect(dismissalsOf(stored)).toEqual([]);
	});

	it("writes no record when a dismissal stored with no sighting is made again with the store", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review(store);
		const id = first.verdict.all().find(({ ruleId }) => ruleId === "changed-return")!.id;
		const root = await harness!.root(context);
		const { base, head } = first.changeset.revision;
		await root.commit((tx) => dismissFinding(tx, root.id, id, dismissal, `${base}..${head}`), context);

		const made = await recordDismissal({
			harness: harness!,
			repoRoot: repo,
			revision: first.changeset.revision,
			id,
			dismissal,
			records: { store, changeset: first.changeset.id },
		});

		expect(made.unshared).toEqual([]);
		expect(dismissalsOf(await store.list(first.changeset.id))).toEqual([]);
	});
});

describe("a review that names a record store, when building a dismissal's record fails", () => {
	it.each([
		["an error of no dismissal", () => new Error("the store's record is malformed")],
		[
			"a dismissal error that is no reason to leave the record unshared",
			() => new DismissError("notInstalled", "no dismissal task", { revision: "r", finding: "f" }),
		],
	])("fails the review on %s", async (_, made) => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await dismissedReview(store);
		const thrown = made();
		const spy = vi.spyOn(ReviewRecords.prototype, "dismissalOf").mockImplementation(() => {
			throw thrown;
		});
		try {
			await expect(review(store)).rejects.toBe(thrown);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("a review that names a record store, when a dismissal's run is unproven", () => {
	it("names the dismissal unshared, and finishes the review", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { id } = await dismissedReview(store);
		const spy = vi.spyOn(ReviewRecords.prototype, "dismissalOf").mockImplementation(() => {
			throw new DismissError("unprovenRun", "the run is unproven", { revision: "r", finding: id });
		});
		try {
			const later = await review(store);
			expect(later.unshared).toEqual([{ finding: id, code: "unprovenRun" }]);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("a dismissal shared across hosts", () => {
	it("still counts in a round a third host, with no history of the changeset, exports after a second", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await dismissedReview(store);
		await review(store);
		for (const file of ["src/b.ts", "src/c.ts"]) {
			await harness?.close(context);
			harness = undefined;
			commit(repo, { [file]: lines("export const b = 1;") });
			await review(store);
		}
		const changeset = await Changeset.resolve(repo, "main...feature");
		const held = await store.list(changeset.id);
		const round = held
			.filter(({ kind, revision }) => kind === "round" && revision === Revision.key(changeset.revision))
			.map((each) => SharedRecord.parseEnvelope(each).id)
			.at(-1)!;
		const contents = (await RecordedRound.of(held, round, everyRecordCounts).contents(
			changeset.revision,
			repo,
		)) as RecordedRoundContents;
		expect(contents.dismissals.map(({ finding }) => finding)).toHaveLength(1);
	});
});

describe("a dismissal made with a store that fails", () => {
	const dismiss = (store: MemoryRecordStore, first: Awaited<ReturnType<typeof review>>, id: string) =>
		recordDismissal({
			harness: harness!,
			repoRoot: repo,
			revision: first.changeset.revision,
			id,
			dismissal,
			records: { store, changeset: first.changeset.id },
		});
	const statusOf = async (id: string) => {
		const root = (await harness!.root(context)).id;
		return (await harness!.snapshot(FindingsDocument, root, context))!.items[id]!.lifecycle.status;
	};

	it.each(["list", "add"] as const)(
		"refuses when the store's %s fails, and records nothing on the host or in the store",
		async (method) => {
			const store = new MemoryRecordStore({ payloads: reviewPayloads });
			const first = await review(store);
			const id = first.verdict.all().find(({ ruleId }) => ruleId === "changed-return")!.id;
			const refused = new Error(`the store's ${method} is unreachable`);
			vi.spyOn(store, method).mockRejectedValueOnce(refused);

			const made = dismiss(store, first, id);

			await expect(made).rejects.toMatchObject({ code: "storeFailed", cause: refused });
			await expect(made).rejects.toThrow(
				new RegExp(
					`^the dismissal is not recorded, because the record store failed: the store's ${method} is unreachable${
						method === "add" ? "; the store may hold its record, so run the command again" : ""
					}$`,
				),
			);
			const root = (await harness!.root(context)).id;
			const verdict = await readVerdict(harness!, root, Revision.key(first.changeset.revision), context);
			expect([await statusOf(id), verdict?.defect(id)?.speaker.properties.status]).toEqual(["new", "new"]);
			expect(dismissalsOf(await store.list(first.changeset.id))).toEqual([]);
		},
	);

	it("keeps the record in the store, records nothing on the host, and refuses, when the store's add lands and then fails, until dismiss again writes the same record", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review(store);
		const id = first.verdict.all().find(({ ruleId }) => ruleId === "changed-return")!.id;
		const add = store.add.bind(store);
		const refused = new Error("the store's add is unreachable");
		vi.spyOn(store, "add").mockImplementationOnce(async (records) => {
			await add(records);
			throw refused;
		});

		await expect(dismiss(store, first, id)).rejects.toMatchObject({ code: "storeFailed", cause: refused });
		const shared = dismissalsOf(await store.list(first.changeset.id));
		expect([await statusOf(id), shared.length]).toEqual(["new", 1]);

		const made = await dismiss(store, first, id);
		expect([await statusOf(id), made.finding.properties.status]).toEqual(["dismissed", "dismissed"]);
		expect(dismissalsOf(await store.list(first.changeset.id))).toEqual(shared);
	});

	it("leaves the record shared and the host undismissed when the host's commit fails after the write, and dismiss again writes the same record", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const first = await review(store);
		const id = first.verdict.all().find(({ ruleId }) => ruleId === "changed-return")!.id;
		const add = vi.spyOn(store, "add");
		const storage = Object.getPrototypeOf(createMemoryStorage());
		const commit = storage.commit;
		let refused = false;
		// The host's first commit after the store's write fails, as a full disk would fail it.
		vi.spyOn(storage, "commit").mockImplementation(function (this: unknown, ...args: unknown[]) {
			if (add.mock.calls.length === 0 || refused) return commit.apply(this, args);
			refused = true;
			return Promise.reject(new StorageRejected("the disk is full"));
		});

		await expect(dismiss(store, first, id)).rejects.toThrow("the disk is full");
		const shared = dismissalsOf(await store.list(first.changeset.id));
		expect([await statusOf(id), shared.length]).toEqual(["new", 1]);

		vi.mocked(storage.commit).mockRestore();
		const made = await dismiss(store, first, id);
		expect([await statusOf(id), made.finding.properties.status]).toEqual(["dismissed", "dismissed"]);
		expect(dismissalsOf(await store.list(first.changeset.id))).toEqual(shared);
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

describe("a dismissal shared across hosts that each hold some of its rounds", () => {
	// Each host keeps its own findings and holds only the rounds it ran; every host shares one record store and one
	// repository. The oracle runs every round and every dismissal in order, as a host that held them all would.
	const worktree: RepositorySource = { kind: "worktree" };
	type Host = { harness: Harness | undefined; latest?: Awaited<ReturnType<typeof review>> };
	type Step = {
		readonly kind: "commit-a" | "commit-other" | "review" | "dismiss" | "sync";
		readonly host: number;
		// The host whose store a sync copies into `host`'s.
		readonly from?: number;
	};

	const random = (seed: number) => () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	function historyOf(seed: number, syncs = false): Step[] {
		const next = random(seed);
		const hosts = 2 + Math.floor(next() * 2);
		const pick = () => Math.floor(next() * hosts);
		// Every history opens with a review and a dismissal on host 0, and ends with a review the reader reads.
		const steps: Step[] = [
			{ kind: "review", host: 0 },
			{ kind: "dismiss", host: 0 },
		];
		const kinds: Step["kind"][] = [
			"commit-a",
			"commit-other",
			"review",
			"review",
			"dismiss",
			...(syncs ? (["sync"] as const) : []),
		];
		for (let length = 3 + Math.floor(next() * 5); length > 0; length--) {
			const kind = kinds[Math.floor(next() * kinds.length)]!;
			const host = pick();
			steps.push(
				kind === "sync"
					? { kind, host, from: (host + 1 + Math.floor(next() * (hosts - 1))) % hosts }
					: { kind, host },
			);
		}
		steps.push({ kind: "review", host: pick() });
		return steps;
	}

	const findingOf = (reviewed: Awaited<ReturnType<typeof review>>) =>
		reviewed.verdict.all().find(({ ruleId }) => ruleId === "changed-return")?.id;

	async function statusOn(on: Harness, id: string) {
		const root = (await on.root(context)).id;
		return (await on.snapshot(FindingsDocument, root, context))!.items[id]?.lifecycle.status;
	}

	// Runs one review on `host`, whose harness the shared `review` helper opens and keeps.
	async function reviewOn(host: Host, store: MemoryRecordStore | undefined) {
		harness = host.harness;
		try {
			host.latest = await review(store, checks, undefined, undefined, { policy: worktree });
		} finally {
			host.harness = harness;
			harness = undefined;
		}
		return host.latest;
	}

	// Dismisses as `melian dismiss` does, at the revision `as` last reviewed, which `host` reviewed too.
	async function dismissOn(host: Host, as: Host, store: MemoryRecordStore | undefined, at: string) {
		const latest = as.latest!;
		const id = findingOf(latest);
		if (id === undefined) return;
		await recordDismissal({
			harness: host.harness!,
			repoRoot: repo,
			revision: latest.changeset.revision,
			id,
			dismissal: { ...dismissal, at },
			...(store === undefined ? {} : { records: { store, changeset: latest.changeset.id } }),
		});
	}

	// What a reader of the last round makes of the finding, and what the oracle's own lifecycle makes of it.
	async function outcomeOf(steps: readonly Step[]) {
		// The finding sits on line 1; line 2 shares its hunk, so an edit there reopens it and keeps its ID.
		rmSync(repo, { recursive: true, force: true });
		repo = baseAndHead(
			{ "src/a.ts": lines("export const a = 1;") },
			{ "src/a.ts": lines("export const a = 2;", "export const k = 0;") },
		);
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const hosts: Host[] = [0, 1, 2].map(() => ({ harness: undefined }));
		const oracle: Host = { harness: undefined };
		let edits = 0;
		let k = 0;
		try {
			for (const [index, step] of steps.entries()) {
				const host = hosts[step.host]!;
				// Each edit toggles the line beside the finding, in its hunk, so one reopens it and the next restores the text it
				// was dismissed over.
				if (step.kind === "commit-a") {
					k = 1 - k;
					commit(repo, { "src/a.ts": lines("export const a = 2;", `export const k = ${k};`) });
				}
				if (step.kind === "commit-other") commit(repo, { "src/b.ts": lines(`export const b = ${edits++};`) });
				if (step.kind === "review") {
					await reviewOn(host, store);
					await reviewOn(oracle, undefined);
				}
				if (step.kind === "dismiss" && host.latest !== undefined) {
					const at = new Date(Date.UTC(2026, 10, 16, 0, index)).toISOString();
					const before = (await store.list(host.latest.changeset.id)).length;
					await dismissOn(host, host, store, at);
					// A host that dismisses again what it holds dismissed records nothing, so the oracle, which would dismiss at its
					// own later revision, has nothing to mirror.
					if ((await store.list(host.latest.changeset.id)).length > before)
						await dismissOn(oracle, host, undefined, at);
				}
			}
			const last = oracle.latest!;
			const id = findingOf(last);
			if (id === undefined) return "absent" as const;
			const held = await store.list(last.changeset.id);
			const round = held
				.filter(({ kind, revision }) => kind === "round" && revision === Revision.key(last.changeset.revision))
				.map((each) => SharedRecord.parseEnvelope(each).id)
				.at(-1)!;
			// The reader reads the round as `melian findings --records` does, under the policy the review read.
			const read = await RecordedRound.of(held, round, everyRecordCounts).verdict({
				revision: last.changeset.revision,
				config: defaultConfig,
				repoRoot: repo,
				policy: worktree,
			});
			// The round reads not reviewed for its skipped checks alone; a refusal of its records is the reader's own.
			const refused = read.notRun.find(({ name }) => name === "records");
			if (refused !== undefined) throw new Error(`the reader refused the round: ${refused.reason}`);
			const reader = read.dismissed.some(({ properties }) => properties.id === id);
			const host = (await statusOn(oracle.harness!, id)) === "dismissed";
			return reader && host ? "both" : reader ? "readerOnly" : host ? "hostOnly" : "neither";
		} finally {
			for (const each of [...hosts, oracle]) await each.harness?.close(context);
		}
	}
	// Hosts that each keep a store of their own and copy another's into it now and then, so a host can write a round
	// without having seen another's, or dismiss with a frontier that lacks one. The oracle is rule 7 read over the set
	// every store holds at the end: a dismissal no other supersedes keeps the finding dismissed when every round of the
	// changeset its writer did not hold, the round read among them, reviewed the line beside the finding as the
	// dismissed revision had it. No host need hold that set, so the host that wrote the round read may pass what the
	// reader blocks.
	async function setOutcomeOf(steps: readonly Step[]) {
		rmSync(repo, { recursive: true, force: true });
		repo = baseAndHead(
			{ "src/a.ts": lines("export const a = 1;") },
			{ "src/a.ts": lines("export const a = 2;", "export const k = 0;") },
		);
		const hosts: (Host & { readonly store: MemoryRecordStore; k: number })[] = [0, 1, 2].map(() => ({
			harness: undefined,
			store: new MemoryRecordStore({ payloads: reviewPayloads }),
			k: 0,
		}));
		// The line beside the finding as each round reviewed it, and what each dismissal's writer held.
		const roundK = new Map<string, number>();
		const made = new Map<string, { readonly k: number; readonly held: ReadonlySet<string> }>();
		let changeset: string | undefined;
		let read: string | undefined;
		let edits = 0;
		let k = 0;
		const ids = async (store: MemoryRecordStore) =>
			changeset === undefined ? [] : (await store.list(changeset)).map((each) => SharedRecord.parseEnvelope(each));
		try {
			for (const [index, step] of steps.entries()) {
				const host = hosts[step.host]!;
				if (step.kind === "commit-a") {
					k = 1 - k;
					commit(repo, { "src/a.ts": lines("export const a = 2;", `export const k = ${k};`) });
				}
				if (step.kind === "commit-other") commit(repo, { "src/b.ts": lines(`export const b = ${edits++};`) });
				if (step.kind === "sync" && changeset !== undefined)
					await host.store.add(await hosts[step.from!]!.store.list(changeset));
				if (step.kind === "review") {
					const had = new Set((await ids(host.store)).map(({ id }) => id));
					harness = host.harness;
					let reviewed: Awaited<ReturnType<typeof review>>;
					try {
						reviewed = await review(host.store, checks, undefined, undefined, { policy: worktree });
					} finally {
						host.harness = harness;
						harness = undefined;
					}
					changeset = reviewed.changeset.id;
					host.k = k;
					host.latest = reviewed;
					// A review that reuses its stored verdict writes no new round, so the host's latest at the revision is the one.
					const at = (await ids(host.store)).filter(
						({ kind, revision }) => kind === "round" && revision === Revision.key(reviewed.changeset.revision),
					);
					read = (at.find(({ id }) => !had.has(id)) ?? at.at(-1)!).id;
					roundK.set(read, k);
				}
				if (step.kind === "dismiss" && host.latest !== undefined) {
					const before = await ids(host.store);
					await dismissOn(host, host, host.store, new Date(Date.UTC(2026, 10, 16, 0, index)).toISOString());
					const written = (await ids(host.store)).find(
						({ id, kind }) => kind === "dismissal" && !before.some((each) => each.id === id),
					);
					if (written !== undefined)
						made.set(written.id, {
							k: host.k,
							held: new Set(before.filter(({ kind }) => kind === "round").map(({ id }) => id)),
						});
				}
			}
			const last = hosts[steps.at(-1)!.host]!;
			const id = findingOf(last.latest!);
			if (id === undefined) return "absent" as const;
			const everyStore = new MemoryRecordStore({ payloads: reviewPayloads });
			for (const each of hosts) await everyStore.add(await each.store.list(changeset!));
			const held = await everyStore.list(changeset!);
			const set = RecordSet.of(held, { counts: everyRecordCounts, payloads: reviewPayloads });
			const oracle = set
				.unsuperseded()
				.filter(({ kind }) => kind === "dismissal")
				.some((each) => {
					const { k: dismissedAt, held: writer } = made.get(each.id)!;
					return [...roundK].every(([round, at]) => writer.has(round) || at === dismissedAt);
				});
			const verdict = await RecordedRound.of(held, read!, everyRecordCounts).verdict({
				revision: last.latest!.changeset.revision,
				config: defaultConfig,
				repoRoot: repo,
				policy: worktree,
			});
			const refused = verdict.notRun.find(({ name }) => name === "records");
			if (refused !== undefined) throw new Error(`the reader refused the round: ${refused.reason}`);
			const reader = verdict.dismissed.some(({ properties }) => properties.id === id);
			const writer = (await statusOn(last.harness!, id)) === "dismissed";
			return { reader, oracle, writer };
		} finally {
			for (const each of hosts) await each.harness?.close(context);
		}
	}

	// Seed 112 let a reader that followed only the read round's chain keep a dismissal the set reopens: a host wrote a
	// round without the frontier, citing a changed hunk, and the round read never names it. The host that wrote the round
	// read never saw that round, so it holds the finding dismissed where the reader reopens it, as rule 7 reads the set.
	it("keeps seed 112: a round written without the frontier reopens the dismissal, though the round read never names it", async () => {
		const outcome = await setOutcomeOf(historyOf(112, true));
		expect(outcome).toEqual({ reader: false, oracle: false, writer: true });
	});

	const syncSeeds = Number(process.env.MELIAN_PROPERTY_SEEDS ?? 20);
	it("reads a dismissal as rule 7 reads the set, when hosts keep stores of their own that sync late", {
		timeout: 60_000 + syncSeeds * 5_000,
	}, async () => {
		const outcomes: Record<string, number[]> = {};
		for (let seed = 1; seed <= syncSeeds; seed++) {
			const outcome = await setOutcomeOf(historyOf(seed, true)).catch((error: unknown) => {
				throw new Error(`seed ${seed} failed`, { cause: error });
			});
			const name =
				outcome === "absent"
					? outcome
					: `${outcome.reader === outcome.oracle ? "agree" : "disagree"}:${outcome.reader ? "kept" : "reopened"}${outcome.writer === outcome.reader ? "" : ",writer differs"}`;
			outcomes[name] = [...(outcomes[name] ?? []), seed];
		}
		process.stderr.write(`property seeds, separate stores: ${JSON.stringify(outcomes)}\n`);
		expect(Object.keys(outcomes).filter((name) => name.startsWith("disagree"))).toEqual([]);
		expect(Object.keys(outcomes).some((name) => name.startsWith("agree:kept"))).toBe(true);
		expect(Object.keys(outcomes).some((name) => name.startsWith("agree:reopened"))).toBe(true);
	});

	// Seeds that once found a defect, each kept as a named case. Seed 9 let a reader that skipped each round's own
	// revision dismiss the finding: dismissed on host 0, reopened by an edit beside it in a round on host 1, then
	// restored and read in a later round there.
	const kept: readonly { readonly seed: number; readonly why: string }[] = [
		{ seed: 9, why: "a round on another host reopened the dismissal, and a later one restored the text" },
		{
			seed: 302,
			why: "a host dismissed again a finding it held dismissed, which records nothing for others to read",
		},
	];

	it.each(kept)("keeps seed $seed: $why", async ({ seed }) => {
		expect(await outcomeOf(historyOf(seed))).not.toBe("readerOnly");
	});

	const seeds = Number(process.env.MELIAN_PROPERTY_SEEDS ?? 20);
	it("never lets a reader's dismissal stand where a host that held every round reopened it", {
		timeout: 60_000 + seeds * 5_000,
	}, async () => {
		const outcomes: Record<string, number[]> = {};
		for (let seed = 1; seed <= seeds; seed++) {
			const outcome = await outcomeOf(historyOf(seed)).catch((error: unknown) => {
				throw new Error(`seed ${seed} failed`, { cause: error });
			});
			outcomes[outcome] = [...(outcomes[outcome] ?? []), seed];
		}
		process.stderr.write(`property seeds: ${JSON.stringify(outcomes)}\n`);
		expect(outcomes.readerOnly).toBeUndefined();
		expect(outcomes.both?.length ?? 0).toBeGreaterThan(0);
		expect(outcomes.neither?.length ?? 0).toBeGreaterThan(0);
	});
});
