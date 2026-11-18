import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	everyRecordCounts,
	Finding,
	KeyedRequest,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	type RecordJson,
	Revision,
	reviewPayloads,
	SharedRecord,
} from "@melian-agent/core";
import {
	type CheckRun,
	type CheckRunRecord,
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	type Harness,
	openHarness,
	RecordedRound,
	reviewChangeset,
	runChecks,
} from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckSources, ChecksDocument, identityKey } from "../src/checks.ts";
import { replaceCheckFindings } from "../src/findings.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

// Text an earlier build stored from Biome's output, which the head's tree does not hold, such as a login it led Biome to
// read. Before issue #281 a static finding held its tool's text; such a sighting can still sit in a host's store.
const token = "melian-test-token-5d18e2";

const checks: CheckRunRecord[] = [
	{ name: "guardrails", status: "ran", findings: 0, notes: [] },
	{ name: "static.biome", status: "ran", version: "2.5.0", findings: 1, notes: [] },
	{ name: "static.tsc", status: "ran", version: "5.9.3", findings: 0, notes: [] },
	{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
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

// A blocking Biome finding as a build stored it. An earlier build put the tool's text in its rule, message and
// discriminator; this one writes a fixed sentence and no discriminator.
const sighting = (text: string | undefined) =>
	Finding.create({
		rule: text === undefined ? "lint/suspicious/noDebugger" : `lint/${text}`,
		message: text === undefined ? "Biome reports lint/suspicious/noDebugger here." : `Biome said ${text}`,
		file: "src/a.ts",
		startLine: 1,
		...(text === undefined ? {} : { discriminator: `Biome said ${text}` }),
		cause: "introduced",
		severity: "P1",
		explanation:
			text === undefined
				? { what: "Biome reports a rule here.", whyHere: "The change adds it.", whatToDo: "Fix it." }
				: { what: `Biome said ${text}`, whyHere: text, whatToDo: text },
		source: { check: "static.biome", version: "2.5.0" },
	});

// A request for `versions` of Melian's own check code, and a check run that names it by `key`, its own by default.
// Every run's request keys the checkout's install, here one identified, so no second run shares the key.
const install = { digests: { "package-lock.json": "a".repeat(64) }, identified: true };
const askFor = (versions: Record<string, number>) => KeyedRequest.of("check", { checks: versions, install });
const runUnder = (versions: Record<string, number>, key?: string): CheckRun => {
	const asked = askFor(versions);
	return {
		identity: { base: "b".repeat(40), head: "c".repeat(40), tier: "full", policy: asked.key.slice(0, 16), task: 7 },
		request: key ?? asked.key,
		records: checks,
	};
};
const current = { guardrails: 1, "static.biome": 3, "static.tsc": 4, "static.enola": 5, "static.mutation": 3 };
const asked = askFor(current);

// What the host's store holds beside the sightings: the request key each check task's terminal commit stamped, and the
// requests the checks document keeps by key.
type Store = {
	readonly stamps?: { readonly biome?: string; readonly tsc?: string };
	readonly requests?: Readonly<Record<string, RecordJson>>;
};
// A store a run under the current request wrote: both checks stamped with its key, and the request kept under it.
const proven: Store = { stamps: { biome: asked.key, tsc: asked.key }, requests: { [asked.key]: asked.request } };

// One review of the fixture, after the host's store already holds Biome's sighting of the revision, holding `text`.
async function review(
	store: MemoryRecordStore,
	run: { readonly checkRun?: CheckRun; readonly asMade?: true } = {},
	text: string | undefined = token,
	held: Store = {},
) {
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
	const quiet = () => fauxAssistantMessage("No findings.");
	scriptConversations(fake, [
		{ match: "You are the correctness reviewer", replies: [quiet, quiet] },
		{ match: "You are the contracts reviewer", replies: [quiet, quiet] },
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const root = await harness.root(context);
	const at = Revision.key(changeset.revision);
	// A run built here names this review's revision, so only its proof is in question.
	const checkRun =
		run.checkRun === undefined || run.asMade
			? run.checkRun
			: {
					...run.checkRun,
					identity: { ...run.checkRun.identity, base: changeset.revision.base, head: changeset.revision.head },
				};
	await root.commit(async (tx) => {
		const runs = await tx.doc(ChecksDocument, root.id);
		runs.requests = structuredClone({ ...held.requests });
		// The run's own task stored the records it was handed, under its identity.
		if (checkRun !== undefined)
			runs.runs[identityKey(checkRun.identity)] = Object.fromEntries(
				checkRun.records.map((record) => [record.name, record]),
			);
		// The run's own task, 7, records the check task it started for each check, which stamps what that task wrote.
		(await tx.doc(CheckSources, root.id, "7", null)).tasks = { "static.biome": 11, "static.tsc": 12 };
		const stamp = (request: string | undefined, task: number) =>
			request === undefined ? undefined : { request, task };
		await replaceCheckFindings(tx, root.id, "static.biome", at, [sighting(text)], stamp(held.stamps?.biome, 11));
		await replaceCheckFindings(tx, root.id, "static.tsc", at, [], stamp(held.stamps?.tsc, 12));
	}, context);
	const { verdict } = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts"),
		standards: [],
		models: fake.review,
		...(checkRun === undefined ? { checks } : { checkRun }),
		policy: { kind: "worktree" },
		records: store,
	});
	const stored = await store.list(changeset.id);
	return { changeset, config, verdict, stored };
}

const bytes = (stored: readonly RecordEnvelope[]) => JSON.stringify(stored);
const checkRecord = (stored: readonly RecordEnvelope[], name: string) =>
	stored.find(
		({ kind, payload }) => kind === "check" && (payload as { result: { name: string } }).result.name === name,
	)!.payload as { result: { status: string; reason?: string }; sightings: unknown[] };
const biomeRecord = (stored: readonly RecordEnvelope[]) => checkRecord(stored, "static.biome");
const withheldRecord = (name: string) => ({
	v: 1,
	result: { name, status: "failed", reason: "withheld", error: expect.any(String) },
	sightings: [],
});

function readBack(reviewed: Awaited<ReturnType<typeof review>>) {
	const rounds = reviewed.stored.filter(({ kind }) => kind === "round");
	const id = SharedRecord.parseEnvelope(rounds.at(-1)!).id;
	return RecordedRound.of(reviewed.stored, id, everyRecordCounts).verdict({
		revision: reviewed.changeset.revision,
		config: reviewed.config,
		repoRoot: repo,
		policy: { kind: "worktree" },
	});
}

const old = askFor({ ...current, "static.biome": 1 });

describe("a static check's sightings, exported from a run the store proves wrote them", () => {
	it("are shared, with each static check's record, when its stamp and stored request prove the run", async () => {
		const reviewed = await review(
			new MemoryRecordStore({ payloads: reviewPayloads }),
			{ checkRun: runUnder(current) },
			undefined,
			proven,
		);

		expect(biomeRecord(reviewed.stored)).toMatchObject({ result: { name: "static.biome", status: "ran" } });
		expect(biomeRecord(reviewed.stored).sightings).toHaveLength(1);
		expect(checkRecord(reviewed.stored, "static.tsc")).toMatchObject({
			result: { name: "static.tsc", status: "ran" },
			sightings: [],
		});
	});
});

describe("a static check's sightings, exported from a run that does not prove the text they hold is Melian's", () => {
	// tsc found nothing, so its record holds no tool text, yet a run the store does not prove may not call it clean.
	it.each<[string, { readonly checkRun?: CheckRun }, Store, "ran" | "withheld"]>([
		["bare check records", {}, proven, "withheld"],
		[
			"a run whose sightings carry no stamp",
			{ checkRun: runUnder(current) },
			{ ...proven, stamps: { tsc: asked.key } },
			"ran",
		],
		[
			"a run whose sightings another run stamped",
			{ checkRun: runUnder(current) },
			{ ...proven, stamps: { biome: "d".repeat(64), tsc: asked.key } },
			"ran",
		],
		// A caller can hand in any run beside the sightings, so a request the store never kept proves nothing.
		[
			"a run whose request the store never kept",
			{ checkRun: runUnder(current) },
			{ stamps: proven.stamps },
			"withheld",
		],
		[
			"a run whose stored request was edited after it was keyed",
			{ checkRun: runUnder(current) },
			// It still asks for today's code, so only its hash fails.
			{ ...proven, requests: { [asked.key]: { checks: current, install, edited: true } } },
			"withheld",
		],
		[
			"a run of a build whose Biome check stored its text",
			{ checkRun: runUnder({ ...current, "static.biome": 1 }) },
			// That build asked for today's tsc code, so tsc's empty result is proven.
			{ stamps: { biome: old.key, tsc: old.key }, requests: { [old.key]: old.request } },
			"ran",
		],
	])("leave no tool text in the record, from %s", async (_, run, held, tsc) => {
		const reviewed = await review(new MemoryRecordStore({ payloads: reviewPayloads }), run, token, held);

		// Records handed in with no run are the caller's word on this host. A run's Biome sightings it did not stamp read
		// as not run here too, by the ruling of 2026-11-18 on issue #562.
		expect(reviewed.verdict.status).toBe(run.checkRun === undefined ? "findings" : "not-reviewed");
		expect(bytes(reviewed.stored)).not.toContain(token);
		expect(biomeRecord(reviewed.stored)).toEqual(withheldRecord("static.biome"));
		expect(checkRecord(reviewed.stored, "static.tsc")).toEqual(
			tsc === "ran"
				? expect.objectContaining({ result: expect.objectContaining({ status: "ran" }), sightings: [] })
				: withheldRecord("static.tsc"),
		);
	});

	// A stale run that found nothing commits after the review's run, so it replaces tsc's sightings and stamps its own key.
	it("withhold a check that sighted nothing when another run stamped its empty result", async () => {
		const reviewed = await review(
			new MemoryRecordStore({ payloads: reviewPayloads }),
			{ checkRun: runUnder(current) },
			undefined,
			{ ...proven, stamps: { biome: asked.key, tsc: "d".repeat(64) } },
		);

		expect(biomeRecord(reviewed.stored)).toMatchObject({ result: { name: "static.biome", status: "ran" } });
		expect(checkRecord(reviewed.stored, "static.tsc")).toEqual(withheldRecord("static.tsc"));
	});

	// A request that could not key the install starts a new run each time it is asked, so run B under run A's key can
	// replace A's blocker with nothing and stamp the key A's stamp held.
	it("withhold a check whose run's request was not keyed fully, though its stamp and stored request prove it", async () => {
		const unkeyed = KeyedRequest.of("check", {
			checks: current,
			install: { digests: { "package-lock.json": "unavailable" }, identified: false },
		});
		const blocked = checks.map((check) => (check.name === "static.tsc" ? { ...check, findings: 1 } : check));
		const reviewed = await review(
			new MemoryRecordStore({ payloads: reviewPayloads }),
			{ checkRun: { ...runUnder(current, unkeyed.key), records: blocked } },
			undefined,
			{ stamps: { biome: unkeyed.key, tsc: unkeyed.key }, requests: { [unkeyed.key]: unkeyed.request } },
		);

		expect(checkRecord(reviewed.stored, "static.tsc")).toEqual({
			v: 1,
			result: { name: "static.tsc", status: "failed", reason: "unkeyed", error: expect.any(String) },
			sightings: [],
		});
		expect(biomeRecord(reviewed.stored)).toMatchObject({ result: { status: "failed", reason: "unkeyed" } });
	});

	it("never read back as passed on another host, where the host's own verdict blocks on them", async () => {
		const reviewed = await review(new MemoryRecordStore({ payloads: reviewPayloads }));
		const verdict = await readBack(reviewed);

		expect(reviewed.verdict.status).toBe("findings");
		expect(verdict.status).toBe("not-reviewed");
		// The withheld record drops the sighting whose path the review's policy was read for, so the reader reads another.
		expect(verdict.notRun.map(({ name }) => name)).toEqual(["records"]);
	});
});

describe("a check run made in this process for another revision", () => {
	it("is refused by a review of this one, so neither its records nor its proof stand for checks never run here", async () => {
		gitIn(repo, "checkout", "--quiet", "-b", "other");
		gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", "other");
		gitIn(repo, "checkout", "--quiet", "feature");
		const fake = createFakeModels();
		const registry = createReviewRegistry();
		registry.install(checksExtension);
		const elsewhere = await openHarness(createMemoryStorage(), {
			models: fake.models,
			registry,
			env: () => createNodeExecutionEnv(repo),
		});
		try {
			const config: MelianConfig = { ...defaultConfig, tiers: twoLensTiers };
			const run = await runChecks(
				elsewhere,
				{
					rootConversationId: (await elsewhere.root(context, { agent: { model: fake.ref() } })).id,
					changeset: await Changeset.resolve(repo, "main...other"),
					config,
					source: { kind: "revision", commit: gitIn(repo, "rev-parse", "main") },
					tier: "full",
				},
				context,
			);
			const store = new MemoryRecordStore({ payloads: reviewPayloads });

			await expect(review(store, { checkRun: run, asMade: true })).rejects.toMatchObject({
				code: "foreignCheckRun",
			});
			expect(bytes(await store.list((await Changeset.resolve(repo, "main...feature")).id))).not.toContain(token);
		} finally {
			await elsewhere.close(context);
		}
	});
});

describe("a check run handed to a review", () => {
	it.each([
		["another base", (_: string, head: string) => ({ base: "a".repeat(40), head, tier: "full" })],
		["another tier", (base: string, head: string) => ({ base, head, tier: "standard" })],
	])("is refused when it names %s than the review's", async (_, names) => {
		const { base, head } = (await Changeset.resolve(repo, "main...feature")).revision;
		const made = runUnder(current);
		const checkRun = { ...made, identity: { ...made.identity, ...names(base, head) } };

		await expect(
			review(new MemoryRecordStore({ payloads: reviewPayloads }), { checkRun, asMade: true }),
		).rejects.toMatchObject({ code: "foreignCheckRun", lenses: [] });
	});
});
