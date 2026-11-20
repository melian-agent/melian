import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AccountPayload,
	Changeset,
	type CheckPayload,
	type DismissalPayload,
	defaultConfig,
	everyRecordCounts,
	Finding,
	findingId,
	fingerprintKey,
	Lens,
	type LensPayload,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	type RecordJson,
	type RepositorySource,
	Revision,
	reviewPayloads,
	SharedRecord,
	Standards,
	type StoredFinding,
	type Verdict,
} from "@melian-agent/core";
import { recordKey } from "@melian-agent/core/testing";
import { RecordedDecider } from "@melian-agent/decisions";
import {
	type CheckRunRecord,
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	createReviewRegistry,
	decisionExtension,
	dismissFinding,
	type Harness,
	type Message,
	openHarness,
	RecordedRound,
	type RecordedRoundContents,
	ReviewError,
	readFindings,
	recordDismissal,
	reviewChangeset,
	upsertFinding,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeSightings } from "../src/findings.ts";
import { provingHunk, reviewFiles } from "../src/lens-tools.ts";
import { accountKey, ReviewRecords } from "../src/review-records.ts";
import { provenRun } from "./fixtures/proven-run.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers, withBudget } from "./fixtures/review-scenario.ts";
import { expectSharedVerdict } from "./fixtures/shared-verdict.ts";

const correctness = "You are the correctness reviewer";
const verifierMarker = "Melian adversarial verifier";
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
const checks: CheckRunRecord[] = [
	{ name: "guardrails", status: "ran", findings: 0, notes: [] },
	{ name: "static.biome", status: "ran", version: "2.5.0", findings: 0, notes: [] },
	{ name: "static.tsc", status: "ran", version: "5.9.3", findings: 0, notes: [] },
	{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
];

const worktree: RepositorySource = { kind: "worktree" };
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

const reports = (finding: object) => (messages: readonly Message[]) =>
	messages.some((message) => message.role === "toolResult")
		? fauxAssistantMessage("Done.")
		: fauxAssistantMessage(fauxToolCall("report_finding", finding as never), { stopReason: "toolUse" });
const quiet = () => fauxAssistantMessage("No findings.");
const reads = fauxAssistantMessage(fauxToolCall("read_file", { path: "src/a.ts" }), { stopReason: "toolUse" });
const broken = fauxAssistantMessage("", { stopReason: "error", errorMessage: "the request was malformed" });

type Scenario = {
	readonly given?: readonly CheckRunRecord[];
	readonly correctness?: readonly ScriptedReply[];
	readonly contracts?: readonly ScriptedReply[];
	readonly verifier?: readonly ScriptedReply[];
	readonly lenses?: (lens: Lens) => Lens;
	readonly standards?: (changeset: Changeset) => Promise<Standards>;
	// Triage's answer for contracts, so it can run at quick and escalate.
	readonly triage?: RecordedDecider;
	// Where the review reads per-path policy, the working tree by default; with `null`, `config` applies to every path.
	readonly policy?: RepositorySource | null;
};

// One review of the fixture under `scenario`, exporting to `store`. A review that throws carries the verdict it
// recorded, which is the host's.
async function review(store: MemoryRecordStore, scenario: Scenario = {}) {
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	const config: MelianConfig = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: {
			heavy: { model: `${heavy.provider}/${heavy.modelId}` },
			...(scenario.triage === undefined ? {} : { medium: { model: `${heavy.provider}/${heavy.modelId}` } }),
		},
		...(scenario.triage === undefined ? {} : { triage: { escalateAt: "P2" as const } }),
	};
	const registry = createReviewRegistry();
	if (scenario.triage !== undefined) registry.install(decisionExtension(scenario.triage));
	harness ??= await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		settings: { retry: { enabled: false } },
	});
	scriptConversations(fake, [
		...(scenario.verifier === undefined ? [] : [{ match: verifierMarker, replies: [...scenario.verifier] }]),
		{ match: correctness, replies: [...(scenario.correctness ?? [quiet, quiet])] },
		{ match: contracts, replies: [...(scenario.contracts ?? [reports(changedReturn), quiet, quiet])] },
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const lenses = (await Lens.builtins())
		.filter(({ name }) => name === "correctness" || name === "contracts")
		.map(scenario.lenses ?? ((lens) => lens));
	const verdict = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: scenario.standards === undefined ? [] : await scenario.standards(changeset),
		models: fake.review,
		// A host's round hands in the run its checks wrote, so a reader can prove its static checks as the host does.
		checkRun: await provenRun(harness, changeset, [...(scenario.given ?? checks)]),
		records: store,
		...(scenario.triage === undefined ? {} : { decider: scenario.triage }),
		...(scenario.policy === null ? {} : { policy: scenario.policy ?? worktree }),
	}).then(
		(result) => result.verdict,
		(error: unknown) => {
			if (error instanceof ReviewError && error.verdict !== undefined) return error.verdict;
			throw error;
		},
	);
	return { changeset, config, verdict, stored: await store.list(changeset.id) };
}

type Reviewed = Awaited<ReturnType<typeof review>>;

const exported = () => new MemoryRecordStore({ payloads: reviewPayloads });

// The round the review exported last: the one no other round of its revision names as replaced.
function roundOf(stored: readonly RecordEnvelope[]): string {
	const rounds = stored.filter(({ kind }) => kind === "round");
	return SharedRecord.parseEnvelope(rounds.at(-1)!).id;
}

function read(reviewed: Reviewed, records: readonly RecordEnvelope[] = reviewed.stored, id = roundOf(records)) {
	return RecordedRound.of(records, id, everyRecordCounts).verdict({
		revision: reviewed.changeset.revision,
		config: reviewed.config,
		repoRoot: repo,
		policy: worktree,
	});
}

function readUnder(reviewed: Reviewed, policy: RepositorySource) {
	return RecordedRound.of(reviewed.stored, roundOf(reviewed.stored), everyRecordCounts).verdict({
		revision: reviewed.changeset.revision,
		config: reviewed.config,
		repoRoot: repo,
		policy,
	});
}

// Every check name the host's verdict holds, less those an exported record of the round decides. A check the export
// cannot write is left, by name.
function unexported(reviewed: Reviewed): string[] {
	const records = reviewed.stored.map((each) => SharedRecord.parseEnvelope(each));
	const round = records.find(({ id }) => id === roundOf(reviewed.stored))!;
	const named = new Set(round.manifest()!.read.map(({ id }) => id));
	const decided = new Set<string>();
	for (const record of records.filter(({ id }) => named.has(id))) {
		const payload = record.payload as Record<string, { name?: string } | null> & { filled?: { name: string }[] };
		if (record.kind === "check") decided.add(payload.result!.name!);
		if ((record.kind === "lens" || record.kind === "verification") && payload.check !== null)
			decided.add(payload.check!.name!);
		if (record.kind === "account") for (const { name } of payload.filled!) decided.add(name);
	}
	// Adjudication writes a check of the manifest that no record holds as skipped with no record, on either side.
	const manifest = (records.find(({ kind, id }) => kind === "account" && named.has(id))!.payload as AccountPayload)
		.checks;
	return [...(reviewed.verdict.ran ?? []), ...reviewed.verdict.notRun]
		.filter((check) => !(check.reason === "no record" && manifest.includes(check.name)))
		.map(({ name }) => name)
		.filter((name) => !decided.has(name));
}

// Asks the same of the reader as of the host, for one end state: the whole verdict, but the text a record withholds, and a
// record for every check.
async function decidesAsTheHost(scenario: Scenario): Promise<Verdict> {
	const reviewed = await review(exported(), scenario);
	expect(unexported(reviewed)).toEqual([]);
	expectSharedVerdict((await read(reviewed)).toJSON(), reviewed.verdict.toJSON());
	return reviewed.verdict;
}

const failedGuardrails: CheckRunRecord = { name: "guardrails", status: "failed", reason: "toolFailed", error: "boom" };
const provisionalBiome: CheckRunRecord = {
	name: "static.biome",
	status: "provisional",
	version: "2.5.0",
	findings: 0,
	notes: [],
	reason: "reused an earlier head's results",
};
const correctnessUnder = (budget: Parameters<typeof withBudget>[1]) => (lens: Lens) =>
	lens.name === "correctness" ? withBudget(lens, budget) : lens;
const contractsUnder = (budget: Parameters<typeof withBudget>[1]) => (lens: Lens) =>
	lens.name === "contracts" ? withBudget(lens, budget) : lens;

describe("a round read back from its records", () => {
	it.each<[string, { readonly base?: string; readonly head?: string }]>([
		["base", { base: "f".repeat(40) }],
		["head", { head: "f".repeat(40) }],
	])("reads as not reviewed when the caller's revision has another %s than the round's", async (_, other) => {
		const reviewed = await review(exported(), {});
		const { revision } = reviewed.changeset;
		const verdict = await RecordedRound.of(reviewed.stored, roundOf(reviewed.stored), everyRecordCounts).verdict({
			revision: Revision.from({ base: revision.base, head: revision.head, files: revision.files, ...other }),
			config: reviewed.config,
			repoRoot: repo,
			policy: worktree,
		});
		const asked = `${other.base ?? revision.base}..${other.head ?? revision.head}`;
		expect([verdict.status, verdict.notRun]).toEqual([
			"not-reviewed",
			[
				{
					name: "records",
					status: "failed",
					reason: `round ${roundOf(reviewed.stored)} reviewed ${revision.base}..${revision.head}, not ${asked}`,
				},
			],
		]);
	});

	it("decides the verdict the review decided", async () => {
		const verdict = await decidesAsTheHost({});
		expect(verdict.status).toBe("findings");
	});

	it("passes a round whose every check ran and found nothing", async () => {
		const verdict = await decidesAsTheHost({ contracts: [quiet, quiet] });
		expect(verdict.status).toBe("passed");
	});

	it("blocks a round whose finding blocks", async () => {
		const verdict = await decidesAsTheHost({ contracts: [reports({ ...changedReturn, severity: "P1" }), quiet] });
		expect(verdict.status).toBe("findings");
		expect(verdict.blocking).toBe(true);
	});

	it.each<[string, Scenario, Verdict["status"]]>([
		["a deterministic check failed", { given: [failedGuardrails, ...checks.slice(1)] }, "not-reviewed"],
		["a check has no record", { given: checks.filter(({ name }) => name !== "static.tsc") }, "not-reviewed"],
		[
			"a check reused an earlier head's results",
			{ given: [checks[0]!, provisionalBiome, ...checks.slice(2)] },
			"not-reviewed",
		],
		["a lens failed", { contracts: [broken] }, "not-reviewed"],
		["the verifier failed, leaving a lens's finding unjudged", { verifier: [broken] }, "not-reviewed"],
		["a lens's findings budget ran out", { lenses: contractsUnder({ findings: 1 }) }, "not-reviewed"],
		[
			"a lens's token budget ended it",
			{ lenses: correctnessUnder({ tokens: 1 }), correctness: [reads, fauxAssistantMessage("Never asked.")] },
			"not-reviewed",
		],
		[
			"a lens's token budget ended it and its level counts that as run",
			{
				lenses: correctnessUnder({ tokens: 1, ended: "count" }),
				correctness: [reads, fauxAssistantMessage("Never asked.")],
			},
			"findings",
		],
		[
			"a lens's tools budget ended it",
			{
				lenses: correctnessUnder({ tools: 1 }),
				correctness: [reads, reads, reads, fauxAssistantMessage("Never asked.")],
			},
			"not-reviewed",
		],
	])("decides as the review did when %s", async (_, scenario, status) => {
		const verdict = await decidesAsTheHost(scenario);
		expect(verdict.status).toBe(status);
	});

	it("decides as the review did when a quick run escalated and the next level left its finding standing", async () => {
		const triage = new RecordedDecider({
			triage: {
				version: "1",
				answers: { contracts: { distribution: { quick: 1 } }, correctness: { distribution: { careful: 1 } } },
			},
		});
		const verdict = await decidesAsTheHost({ triage, contracts: [reports(changedReturn), quiet, quiet, quiet] });
		expect(verdict.ran).toContainEqual(
			expect.objectContaining({
				name: "lens.contracts",
				level: "careful",
				reason: expect.stringContaining("which careful neither restated nor refuted"),
			}),
		);
		expect(verdict.status).toBe("findings");
	});

	it("decides as the review did when the lens's standards were cut", async () => {
		rmSync(repo, { recursive: true, force: true });
		const standards = { "src/AGENTS.md": "x".repeat(300 * 1024) };
		repo = baseAndHead(
			{ ...standards, "src/a.ts": lines("export const a = 1;") },
			{ ...standards, "src/a.ts": lines("export const a = 2;") },
		);
		const verdict = await decidesAsTheHost({
			standards: (changeset) => {
				const source: RepositorySource = { kind: "revision", commit: changeset.revision.base };
				return Standards.load(repo, source, changeset.revision.paths());
			},
		});
		expect(verdict.status).toBe("not-reviewed");
		expect(verdict.notRun.find(({ name }) => name === "lens.correctness")?.reason).toContain("src/AGENTS.md");
	});

	it("never passes a round once any record it names loses what it decided", async () => {
		const reviewed = await review(exported());
		expect(reviewed.verdict.status).toBe("findings");
		const records = reviewed.stored.map((each) => SharedRecord.parseEnvelope(each));
		const round = records.find(({ id }) => id === roundOf(reviewed.stored))!;
		const named = records.filter(({ id }) => round.manifest()!.read.some((entry) => entry.id === id));
		const fields = { check: "result", lens: "check", verification: "check" } as const;
		const blanked = named.flatMap((record) => {
			const field = fields[record.kind as keyof typeof fields];
			if (field === undefined) return [];
			return [
				[`${record.kind} ${field} blanked`, record, { ...(record.payload as object), [field]: null }],
				[`${record.kind} ${field} removed`, record, without(record.payload, field)],
			] as const;
		});
		expect(new Set(blanked.map(([, record]) => record.kind))).toEqual(new Set(["check", "lens", "verification"]));
		const account = named.find(({ kind }) => kind === "account")!;
		const filled = (account.payload as AccountPayload).filled;
		expect(filled.length).toBeGreaterThan(0);
		const unfilled = filled.map(
			(entry) =>
				[
					`account without ${entry.name}`,
					account,
					{ ...(account.payload as object), filled: filled.filter((each) => each !== entry) },
				] as const,
		);
		for (const [what, record, payload] of [...blanked, ...unfilled]) {
			const changed = rebuilt(reviewed, records, round, record, payload as RecordJson);
			const verdict = await read(reviewed, changed.records, changed.round);
			expect([what, verdict.status]).toEqual([what, "not-reviewed"]);
		}
	});

	it("reads a finding dismissed since the round as live, blocking where the host passes and never the other way", async () => {
		const store = exported();
		const reviewed = await review(store);
		const before = await read(reviewed);
		const finding = Object.values(reviewed.verdict.findings).flat()[0]!;
		const dismissed = await recordDismissal({
			harness: harness!,
			revision: reviewed.changeset.revision,
			id: finding.properties.id,
			dismissal: { by: "maintainer", reason: "a is meant to be 2", at: "2026-11-16T00:00:00.000Z" },
			repoRoot: repo,
		});
		expect(dismissed.verdict.status).toBe("passed");
		const after = await read({ ...reviewed, stored: await store.list(reviewed.changeset.id) });
		expect(after.toJSON()).toEqual(before.toJSON());
		expect(after.status).toBe("findings");
	});

	it("resolves each finding under its own path's policy when the review and the reader read one source", async () => {
		rmSync(repo, { recursive: true, force: true });
		repo = baseAndHead(
			{
				"melian.yaml": lines("resolution:", "  P2: block"),
				"src/melian.yaml": lines("resolution:", "  P2: advisory"),
				"src/a.ts": lines("export const a = 1;"),
			},
			{ "src/a.ts": lines("export const a = 2;") },
		);
		const policy: RepositorySource = { kind: "revision", commit: gitIn(repo, "rev-parse", "main") };
		const reviewed = await review(exported(), { policy });
		const verdict = await readUnder(reviewed, policy);

		expect(reviewed.verdict.findings.advisory.map(({ ruleId }) => ruleId)).toEqual(["changed-return"]);
		expectSharedVerdict(verdict.toJSON(), reviewed.verdict.toJSON());
	});
});

// The finding `reported` makes, dismissed by the maintainer after a first review, and a second review that exports
// the dismissal.
async function dismissedAndReviewedAgain(reported: object = changedReturn) {
	const store = exported();
	const first = await review(store, { contracts: [reports(reported), quiet, quiet] });
	const { id } = Object.values(first.verdict.findings).flat()[0]!.properties;
	await recordDismissal({
		harness: harness!,
		revision: first.changeset.revision,
		id,
		dismissal: { by: "maintainer", reason: "a is meant to be 2", at: "2026-11-16T00:00:00.000Z" },
		repoRoot: repo,
		records: { store, changeset: first.changeset.id },
	});
	return { reviewed: await review(store, { contracts: [reports(reported), quiet, quiet] }), id };
}

const isDismissal = (envelope: RecordEnvelope) => envelope.kind === "dismissal";
const blocks = { ...changedReturn, severity: "P1" };

// What a verdict says of each finding, live or dismissed: its ID, whether it stands, and the dismissal it carries.
const standingOf = (verdict: Verdict) =>
	[...Object.values(verdict.findings).flat(), ...verdict.dismissed].map(({ properties }) => [
		properties.id,
		properties.status,
		properties.dismissal,
	]);

describe("a round read with the dismissals shared beside it", () => {
	it("dismisses a finding as the host does once a later round exports the dismissal", async () => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		expect(reviewed.stored.filter(isDismissal)).toHaveLength(1);
		expect(reviewed.verdict.status).toBe("passed");
		const verdict = await read(reviewed);
		// The host's round ran no verifier, so its records hold no claim of the first round's verification.
		const unverified = (each: Verdict) =>
			JSON.parse(JSON.stringify(each.toJSON(), (key, value) => (key === "verification" ? undefined : value)));
		expectSharedVerdict(unverified(verdict), unverified(reviewed.verdict));
		expect(standingOf(verdict)).toEqual([
			[id, "dismissed", { by: "maintainer", reason: "a is meant to be 2", at: "2026-11-16T00:00:00.000Z" }],
		]);
	});

	it("leaves the finding live and blocking, never dropped, when the dismissal record does not count", async () => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const verdict = await RecordedRound.of(
			reviewed.stored,
			roundOf(reviewed.stored),
			(record) => record.kind !== "dismissal",
		).verdict({ revision: reviewed.changeset.revision, config: reviewed.config, repoRoot: repo, policy: worktree });
		expect([verdict.status, verdict.blocking]).toEqual(["findings", true]);
		expect(standingOf(verdict)).toEqual([[id, "new", undefined]]);
	});

	it("leaves the finding live and blocking, never dropped, when its sighting no longer meets the trigger the dismissal accepted", async () => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const stale = reviewed.stored.map((envelope) => {
			if (!isDismissal(envelope)) return envelope;
			const payload = envelope.payload as { trigger: { hash: string; proof: unknown[] } };
			return SharedRecord.parseEnvelope({
				...envelope,
				payload: { ...payload, trigger: { ...payload.trigger, hash: "f".repeat(64) } },
			}).toJSON();
		});
		expect(stale).not.toEqual(reviewed.stored);
		const verdict = await read(reviewed, stale);
		expect([verdict.status, verdict.blocking]).toEqual(["findings", true]);
		expect(standingOf(verdict)).toEqual([[id, "new", undefined]]);
	});
});

describe("what a round's records hold", () => {
	it("hands over the round's revision, its sightings, the revision's proving hunks and each dismissal record whole", async () => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const records = reviewed.stored.map((each) => SharedRecord.parseEnvelope(each));
		const round = records.find(({ id: each }) => each === roundOf(reviewed.stored))!;
		const dismissal = records.find(({ kind }) => kind === "dismissal")!;
		const { by, reason, at, trigger, sighting: seen } = dismissal.payload as DismissalPayload;
		const contents = await RecordedRound.of(reviewed.stored, round.id, everyRecordCounts).contents(
			reviewed.changeset.revision,
		);
		expect(contents).toEqual({
			revision: Revision.key(reviewed.changeset.revision),
			sightings: (sighting(records, round).payload as LensPayload).sightings,
			hunks: reviewFiles(reviewed.changeset.revision.files).flatMap((file) => file.hunks.map(provingHunk)),
			dismissals: [
				{
					record: dismissal.id,
					finding: id,
					revision: seen.revision,
					supersedes: [],
					by,
					reason,
					at,
					trigger,
					cited: [],
				},
			],
		});
		expect((contents as RecordedRoundContents).hunks).toHaveLength(1);
		expect(seen.revision).toBe(Revision.key(reviewed.changeset.revision));
	});

	it("refuses a revision that is not the round's own, and a round its records cannot stand for", async () => {
		const reviewed = await review(exported());
		const { revision } = reviewed.changeset;
		const other = Revision.from({ base: revision.base, head: "f".repeat(40), files: revision.files });
		const round = RecordedRound.of(reviewed.stored, roundOf(reviewed.stored), everyRecordCounts);
		expect(await round.contents(other)).toEqual({
			refused: `reviewed ${Revision.key(revision)}, not ${Revision.key(other)}`,
		});
		expect(await RecordedRound.of(reviewed.stored, "0".repeat(64), everyRecordCounts).contents(revision)).toEqual({
			refused: "is not among the records, or does not count",
		});
	});
});

type DismissalJson = { at: string; reason: string; trigger: { hash: string; proof: { file: string; hash: string }[] } };

// `reviewed`'s records with each dismissal record replaced by `dismissals`.
function withDismissals(reviewed: Reviewed, dismissals: readonly RecordEnvelope[]): RecordEnvelope[] {
	return [...reviewed.stored.filter((each) => !isDismissal(each)), ...dismissals];
}

// The exported dismissal record with `change` made to its envelope and `payload` to its payload.
function redismissed(reviewed: Reviewed, payload: Partial<DismissalJson> = {}, change: Partial<RecordEnvelope> = {}) {
	const envelope = reviewed.stored.find(isDismissal)!;
	return SharedRecord.parseEnvelope({
		...envelope,
		...change,
		payload: { ...(envelope.payload as DismissalJson), ...payload },
	}).toJSON();
}

const reasonOf = async (reviewed: Reviewed, records: readonly RecordEnvelope[]) =>
	(await read(reviewed, records)).dismissed.map(({ properties }) => properties.dismissal?.reason);

describe("the dismissal records a reader applies", () => {
	it("applies no dismissal record of another changeset", async () => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const elsewhere = redismissed(reviewed, {}, { changeset: "f".repeat(64) });
		expect((await read(reviewed, withDismissals(reviewed, [redismissed(reviewed)]))).status).toBe("passed");
		const verdict = await read(reviewed, withDismissals(reviewed, [elsewhere]));
		expect([verdict.status, verdict.blocking]).toEqual(["findings", true]);
		expect(standingOf(verdict)).toEqual([[id, "new", undefined]]);
	});

	it("applies the latest of two dismissals of one finding, whichever sorts first by ID", async () => {
		const { reviewed } = await dismissedAndReviewedAgain(blocks);
		const earlier = redismissed(reviewed, { reason: "earlier" });
		const idOf = (envelope: RecordEnvelope) => SharedRecord.parseEnvelope(envelope).id;
		const later = (first: boolean) => {
			for (let n = 0; ; n++) {
				const each = redismissed(reviewed, {
					reason: "later",
					at: new Date(Date.parse("2026-11-17T00:00:00.000Z") + n).toISOString(),
				});
				if (idOf(each) < idOf(earlier) === first) return each;
			}
		};
		for (const first of [true, false])
			expect(await reasonOf(reviewed, withDismissals(reviewed, [earlier, later(first)]))).toEqual(["later"]);
	});

	it("applies the dismissal with the greater ID of two made at one time", async () => {
		const { reviewed } = await dismissedAndReviewedAgain(blocks);
		const pair = ["one", "two"].map((reason) => redismissed(reviewed, { reason }));
		const greater = pair.toSorted((a, b) =>
			SharedRecord.parseEnvelope(a).id < SharedRecord.parseEnvelope(b).id ? 1 : -1,
		)[0]!;
		for (const order of [pair, pair.toReversed()])
			expect(await reasonOf(reviewed, withDismissals(reviewed, order))).toEqual([
				(greater.payload as DismissalJson).reason,
			]);
	});

	// Slots and supersession go by a dismissal's key, and reopening reads its sighting, so the two must name one finding.
	it.each([
		["standing beside the finding's own dismissal", (good: RecordEnvelope, bad: RecordEnvelope) => [good, bad]],
		["alone", (_: RecordEnvelope, bad: RecordEnvelope) => [bad]],
		[
			"superseded by the finding's own dismissal",
			(good: RecordEnvelope, bad: RecordEnvelope) => [
				SharedRecord.parseEnvelope({ ...good, supersedes: [SharedRecord.parseEnvelope(bad).id] }).toJSON(),
				bad,
			],
		],
		[
			"of another changeset",
			(good: RecordEnvelope, bad: RecordEnvelope) => [
				good,
				SharedRecord.parseEnvelope({ ...bad, changeset: "f".repeat(64) }).toJSON(),
			],
		],
	])("reads as not reviewed when a dismissal record's key is not its sighting's finding, %s", async (_, set) => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const good = redismissed(reviewed);
		const bad = redismissed(reviewed, {}, { key: "f".repeat(16) });
		const records = withDismissals(reviewed, set(good, bad));
		const refused = `holds a dismissal record keyed ${"f".repeat(16)} whose sighting is of finding ${id}`;
		const round = RecordedRound.of(records, roundOf(records), everyRecordCounts);
		expect(round.refusal()).toBe(refused);
		expect(await round.contents(reviewed.changeset.revision)).toEqual({ refused });
		expect((await read(reviewed, records)).status).toBe("not-reviewed");
		expect((await read(reviewed, withDismissals(reviewed, [good]))).status).toBe("passed");
	});

	it("applies no dismissal another record of its finding supersedes, so superseding only ever blocks more", async () => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const holding = redismissed(reviewed, { reason: "holds" });
		const stale = (supersedes?: string[]) =>
			redismissed(
				reviewed,
				{
					reason: "stale",
					at: "2026-11-17T00:00:00.000Z",
					trigger: { ...(holding.payload as DismissalJson).trigger, hash: "f".repeat(64) },
				},
				supersedes === undefined ? {} : { supersedes },
			);
		expect(await reasonOf(reviewed, withDismissals(reviewed, [holding, stale()]))).toEqual(["holds"]);
		const replaced = await read(
			reviewed,
			withDismissals(reviewed, [holding, stale([SharedRecord.parseEnvelope(holding).id])]),
		);
		expect([replaced.status, replaced.blocking]).toEqual(["findings", true]);
		expect(standingOf(replaced)).toEqual([[id, "new", undefined]]);
	});

	it("hands over only standing dismissals, each with what it supersedes", async () => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const earlier = redismissed(reviewed, { reason: "earlier" });
		const earlierId = SharedRecord.parseEnvelope(earlier).id;
		const later = redismissed(
			reviewed,
			{ reason: "later", at: "2026-11-17T00:00:00.000Z" },
			{ supersedes: [earlierId] },
		);
		const contents = (await RecordedRound.of(
			withDismissals(reviewed, [earlier, later]),
			roundOf(reviewed.stored),
			everyRecordCounts,
		).contents(reviewed.changeset.revision)) as RecordedRoundContents;
		expect(
			contents.dismissals.map(({ record, finding, reason, supersedes }) => [record, finding, reason, supersedes]),
		).toEqual([[SharedRecord.parseEnvelope(later).id, id, "later", [earlierId]]]);
	});

	it("keeps a finding dismissed while either of two standing dismissals holds, and shows the one that holds", async () => {
		const { reviewed } = await dismissedAndReviewedAgain(blocks);
		const holding = redismissed(reviewed, { reason: "holds" });
		const stale = redismissed(reviewed, {
			reason: "stale",
			at: "2026-11-17T00:00:00.000Z",
			trigger: { ...(holding.payload as DismissalJson).trigger, hash: "f".repeat(64) },
		});
		for (const order of [
			[holding, stale],
			[stale, holding],
		])
			expect(await reasonOf(reviewed, withDismissals(reviewed, order))).toEqual(["holds"]);
	});

	it("keeps an affected finding dismissed while the revision holds every hunk its proof names, and no longer", async () => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const records = reviewed.stored.map((each) => SharedRecord.parseEnvelope(each));
		const round = records.find(({ id: each }) => each === roundOf(reviewed.stored))!;
		const lens = sighting(records, round);
		const proof = reviewFiles(reviewed.changeset.revision.files).flatMap((file) => file.hunks.map(provingHunk));
		expect(proof).toHaveLength(1);
		const payload = lens.payload as { sightings: { properties: { trigger: object } }[] };
		const affected = payload.sightings.map((each) => ({
			...each,
			properties: { ...each.properties, cause: "affected", trigger: { ...each.properties.trigger, proof } },
		}));
		const changed = rebuilt(reviewed, records, round, lens, { ...payload, sightings: affected } as RecordJson);
		const under = async (accepted: DismissalJson["trigger"]["proof"]) => {
			const dismissal = redismissed(reviewed, {
				trigger: { ...(redismissed(reviewed).payload as DismissalJson).trigger, proof: accepted },
			});
			return read(reviewed, [...changed.records.filter((each) => !isDismissal(each)), dismissal], changed.round);
		};
		const standing = await under(proof);
		expect(standingOf(standing)).toEqual([[id, "dismissed", expect.objectContaining({ by: "maintainer" })]]);
		const gone = await under([...proof, { file: "src/a.ts", hash: "0".repeat(64) }]);
		expect([gone.status, gone.blocking]).toEqual(["findings", true]);
		expect(standingOf(gone)).toEqual([[id, "new", undefined]]);
	});

	type Held = SharedRecord[] | null | ((read: SharedRecord) => SharedRecord[]);

	// A commit for each digit of the current repository, so a reader can resolve every round's revision: an even digit
	// holds the base's tree and an odd one the head's, so 0..1 changes what the reviewed revision changes.
	const sides = new Map<string, string>();
	let sidesIn: string | undefined;
	const side = (digit: string) => {
		if (sidesIn !== repo) {
			sides.clear();
			sidesIn = repo;
		}
		const tree = gitIn(repo, "rev-parse", `${Number(digit) % 2 === 0 ? "main" : "feature"}^{tree}`);
		const commit = sides.get(digit) ?? gitIn(repo, "commit-tree", "-m", digit, tree);
		sides.set(digit, commit);
		return commit;
	};
	const revisionOf = (from: string, to: string) => `${side(from)}..${side(to)}`;

	// The round with its finding sighted as affected at the revision's one proving hunk, and dismissed at `dismissedAt`
	// accepting it. `elsewhere` is a copy of the round's record of `kind` at revision 1..2 that cites a hunk the revision
	// lacks, and `second` the round of that revision that read it, after `first`, of revision 0..1.
	async function citedAcross(
		kind: "lens" | "check",
		dismissedAt?: string,
		accepted?: (proof: { file: string; hash: string }[]) => { hash: string; proof: object[] },
	) {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const records = reviewed.stored.map((each) => SharedRecord.parseEnvelope(each));
		const round = records.find(({ id: each }) => each === roundOf(reviewed.stored))!;
		const lens = sighting(records, round);
		const proof = reviewFiles(reviewed.changeset.revision.files).flatMap((file) => file.hunks.map(provingHunk));
		const payload = lens.payload as { sightings: { properties: { trigger: object } }[] };
		const citing = (cited: readonly { file: string; hash: string }[], source?: object) =>
			payload.sightings.map((each) => ({
				...each,
				properties: {
					...each.properties,
					...(source === undefined ? {} : { source }),
					cause: "affected",
					trigger: { ...each.properties.trigger, proof: cited },
				},
			}));
		const changed = rebuilt(reviewed, records, round, lens, {
			...payload,
			sightings: citing(proof),
		} as unknown as RecordJson);
		const { sighting: seen, trigger } = redismissed(reviewed).payload as DismissalPayload;
		const dismissal = redismissed(reviewed, {
			trigger: accepted?.(proof) ?? { ...trigger, proof },
			sighting: { ...seen, revision: dismissedAt ?? seen.revision },
			head: (dismissedAt ?? seen.revision).split("..")[1],
		} as Partial<DismissalJson>);
		const copied = kind === "lens" ? lens : namedOf(records, round, "check");
		const elsewhere = SharedRecord.parseEnvelope({
			...copied.toJSON(),
			revision: revisionOf("1", "2"),
			payload: {
				...(copied.payload as object),
				sightings: citing(
					[...proof, { file: "src/b.ts", hash: "0".repeat(64) }],
					kind === "lens" ? undefined : { check: (copied.payload as CheckPayload).result.name },
				),
			} as unknown as RecordJson,
		});
		const roundAt = (from: string, to: string, read: SharedRecord[], before: SharedRecord[], changeset?: string) =>
			ReviewRecords.of(changeset ?? reviewed.changeset.id, { base: side(from), head: side(to) }).round(
				read,
				undefined,
				[],
				before.map((each) => each.id),
			);
		// A round of the revision `base..head`, named by commit, that reads `read` after `before`.
		const roundOn = (base: string, head: string, read: SharedRecord[], before: SharedRecord[]) =>
			ReviewRecords.of(reviewed.changeset.id, { base, head }).round(
				read,
				undefined,
				[],
				before.map((each) => each.id),
			);
		// A copy of the round's lens record at `revision` whose sightings cite `cited`.
		const citingAt = (revision: string, cited: readonly { file: string; hash: string }[]) =>
			SharedRecord.parseEnvelope({
				...lens.toJSON(),
				revision,
				payload: { ...(lens.payload as object), sightings: citing(cited) } as unknown as RecordJson,
			});
		const first = roundAt("0", "1", [], []);
		const second = roundAt("1", "2", [elsewhere], [first]);
		// The read round written again to follow `before`, with the dismissal and `shared` beside it, and its ID. The
		// dismissal names `held` as its frontier, when given, as though its writer held those rounds, and none for `null`;
		// a function of the read round names a frontier that holds it.
		const after = (before: SharedRecord[], shared: SharedRecord[], held?: Held) => {
			const parsed = changed.records.map((each) => SharedRecord.parseEnvelope(each));
			const current = parsed.find((each) => each.id === changed.round)!;
			const manifest = current.manifest()!;
			const byId = new Map(parsed.map((each) => [each.id, each]));
			const { base, head } = reviewed.changeset.revision;
			const followed = ReviewRecords.of(reviewed.changeset.id, { base, head }).round(
				manifest.read.map((each) => byId.get(each.id)!),
				undefined,
				manifest.replaces,
				before.map((each) => each.id),
			);
			const kept = parsed.filter((each) => each !== current && each.kind !== "dismissal");
			const holding = typeof held === "function" ? held(followed) : held;
			const { frontier: _, ...unbounded } = dismissal.payload as DismissalJson & { frontier?: string[] };
			// The writer dismissed after the review that wrote the kept round, so it held that round too.
			const writer = holding && [...holding, ...kept.filter((each) => each.kind === "round")];
			const payload = writer
				? { ...unbounded, frontier: [...new Set(writer.map((each) => each.id))].sort() }
				: unbounded;
			const made =
				holding === undefined
					? dismissal
					: SharedRecord.parseEnvelope({ ...dismissal, payload: payload as unknown as RecordJson }).toJSON();
			const records = [...kept, followed, ...shared].map((each) => each.toJSON()).concat([made]);
			return [records, followed.id] as const;
		};
		const readAfter = (before: SharedRecord[], shared: SharedRecord[], held?: Held) =>
			read(reviewed, ...after(before, shared, held));
		const handedAfter = async (before: SharedRecord[], shared: SharedRecord[], held?: Held) =>
			(await RecordedRound.of(...after(before, shared, held), everyRecordCounts).contents(
				reviewed.changeset.revision,
			)) as RecordedRoundContents;
		return {
			id,
			proof,
			elsewhere,
			first,
			second,
			roundAt,
			roundOn,
			citingAt,
			after,
			readAfter,
			handedAfter,
			revision: reviewed.changeset.revision,
		};
	}

	type Chain = Awaited<ReturnType<typeof citedAcross>>;
	const dismissedOf = (id: string) => [[id, "dismissed", expect.objectContaining({ by: "maintainer" })]];

	it.each(["lens", "check"] as const)(
		"reopens a dismissal once a round after it shared a %s record citing a hunk the revision no longer holds",
		async (kind) => {
			const { id, elsewhere, first, second, readAfter } = await citedAcross(kind, revisionOf("0", "1"));
			const remembered = await readAfter([second], [first, second, elsewhere]);
			expect([remembered.status, remembered.blocking]).toEqual(["findings", true]);
			expect(standingOf(remembered)).toEqual([[id, "new", undefined]]);
		},
	);

	it("remembers no hunk the round it reads cites, as the host tests each sighting against what it held before", async () => {
		// The dismissal accepted another trigger and no proof, so only a hunk remembered from before the round read
		// would let its sightings, which cite hunks the revision holds, keep it.
		const { id, first, readAfter } = await citedAcross("lens", revisionOf("0", "1"), () => ({
			hash: "f".repeat(64),
			proof: [],
		}));
		const reopened = await readAfter([first], [first]);
		expect([reopened.status, reopened.blocking]).toEqual(["findings", true]);
		expect(standingOf(reopened)).toEqual([[id, "new", undefined]]);
	});

	it("tests a dismissal against no other finding's sightings in a round since it", async () => {
		const { id, elsewhere, first, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		// The round since sights only another finding, citing a hunk its revision lacks, which would reopen this one.
		type Sighting = {
			ruleId: string;
			properties: { id: string; occurrence?: number; discriminator?: string };
			partialFingerprints: Record<string, string>;
			locations: { physicalLocation: { region: { snippet?: { text: string } } } }[];
		};
		const payload = elsewhere.payload as { sightings: Sighting[] };
		const renamed = (each: Sighting): Sighting => {
			const rule = "another-rule";
			const { occurrence, discriminator } = each.properties;
			const snippet = each.locations[0]!.physicalLocation.region.snippet?.text ?? "";
			const other = findingId({ file: "src/a.ts", rule, snippet, occurrence, discriminator });
			return {
				...each,
				ruleId: rule,
				properties: { ...each.properties, id: other },
				partialFingerprints: { ...each.partialFingerprints, [fingerprintKey]: other },
			};
		};
		const other = SharedRecord.parseEnvelope({
			...elsewhere.toJSON(),
			payload: { ...payload, sightings: payload.sightings.map(renamed) } as unknown as RecordJson,
		});
		const since = roundAt("1", "2", [other], [first]);
		const read = await readAfter([since], [first, since, other], [first]);
		expect(standingOf(read).filter(([each]) => each === id)).toEqual(dismissedOf(id));
	});

	it("tests no round its writer held before its frontier, though a later round names it beside the frontier", async () => {
		const { id, elsewhere, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		// The writer held `earlier`, whose sighting would reopen the finding, through `frontier`, which follows it.
		const earlier = roundAt("1", "2", [elsewhere], []);
		const frontier = roundAt("2", "3", [], [earlier]);
		const read = await readAfter([earlier, frontier], [earlier, frontier, elsewhere], [frontier]);
		expect(standingOf(read)).toEqual(dismissedOf(id));
	});

	it("tests no round its writer held two rounds before its frontier, though a later round names it", async () => {
		const { id, elsewhere, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		// `earliest`, whose sighting would reopen the finding, comes before `earlier`, which comes before the frontier.
		const earliest = roundAt("1", "2", [elsewhere], []);
		const earlier = roundAt("2", "3", [], [earliest]);
		const frontier = roundAt("3", "4", [], [earlier]);
		const read = await readAfter([earliest, frontier], [earliest, earlier, frontier, elsewhere], [frontier]);
		expect(standingOf(read)).toEqual(dismissedOf(id));
	});

	it("keeps a dismissal whose writer held the round read, and a later round of another revision", async () => {
		const { id, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		// The writer reviewed this revision, then another, then dismissed: it held both rounds.
		const later = roundAt("1", "2", [], []);
		const read = await readAfter([], [later], (round) => [round, later]);
		expect(standingOf(read)).toEqual(dismissedOf(id));
	});

	it("keeps a dismissal whose frontier names a round its writer held and this set does not", async () => {
		const { id, elsewhere, first, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		// Another host's store held `unshared` beside `first`; the reader was handed only `first`.
		const unshared = roundAt("1", "2", [elsewhere], [first]);
		const read = await readAfter([first], [first], [first, unshared]);
		expect(standingOf(read)).toEqual(dismissedOf(id));
	});

	it("reopens a dismissal on a sibling round another host wrote without its frontier, though the round read never names it", async () => {
		const { id, elsewhere, first, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		// Host B never held `first`, so its round follows none; its sighting cites a hunk the dismissal never accepted.
		const sibling = roundAt("1", "2", [elsewhere], []);
		const read = await readAfter([first], [first, sibling, elsewhere], [first]);
		expect([read.status, read.blocking]).toEqual(["findings", true]);
		expect(standingOf(read)).toEqual([[id, "new", undefined]]);
	});

	it("keeps a dismissal whose frontier names a round this set lacks, read at a round that follows none", async () => {
		const { id, elsewhere, first, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		// The writer held `unshared`, which the set lacks; every round the set holds is tested, and none reopens it.
		const unshared = roundAt("1", "2", [elsewhere], [first]);
		expect(standingOf(await readAfter([], [], [unshared]))).toEqual(dismissedOf(id));
	});

	// The reader cannot yet see that Y lacked h, since no record holds Y's hunks; the fix waits on the maintainer.
	it("reopens a dismissal a round since met at a revision that lacked a hunk it accepted, as the host does", async () => {
		// X changes both files and the dismissal accepts both hunks. Y reverts src/a.ts, so the host reopens the finding
		// when Y's sighting cites src/b.ts alone, and it stays live at Z, which changes both files again.
		rmSync(repo, { recursive: true, force: true });
		repo = baseAndHead(
			{ "src/a.ts": lines("export const a = 1;"), "src/b.ts": lines("export const b = 1;") },
			{ "src/a.ts": lines("export const a = 2;"), "src/b.ts": lines("export const b = 2;") },
		);
		const base = gitIn(repo, "rev-parse", "main");
		const z = gitIn(repo, "rev-parse", "feature");
		gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", "x");
		const x = gitIn(repo, "rev-parse", "HEAD");
		gitIn(repo, "reset", "--quiet", "--hard", z);
		writeFileSync(join(repo, "src/a.ts"), lines("export const a = 1;"));
		gitIn(repo, "commit", "--quiet", "--all", "-m", "y");
		const y = gitIn(repo, "rev-parse", "HEAD");
		gitIn(repo, "reset", "--quiet", "--hard", z);
		const chain = await citedAcross("lens", `${base}..${x}`);
		expect(chain.proof.map(({ file }) => file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
		const atX = chain.roundOn(base, x, [], []);
		const kept = chain.citingAt(
			`${base}..${y}`,
			chain.proof.filter(({ file }) => file === "src/b.ts"),
		);
		const atY = chain.roundOn(base, y, [kept], [atX]);
		const atZ = await chain.readAfter([atY], [atX, atY, kept], [atX]);
		expect([atZ.status, atZ.blocking]).toEqual(["findings", true]);
		expect(standingOf(atZ)).toEqual([[chain.id, "new", undefined]]);
	});

	// A repository whose head changes src/a.ts and src/b.ts, and a base beside main that also changes `file` to `text`,
	// as a pull request retargeted onto a branch that took one of its changes, or an unrelated one, would have.
	const retargeted = (file: string, text: string) => {
		rmSync(repo, { recursive: true, force: true });
		repo = baseAndHead(
			{ "src/a.ts": lines("export const a = 1;"), "src/b.ts": lines("export const b = 1;") },
			{ "src/a.ts": lines("export const a = 2;"), "src/b.ts": lines("export const b = 2;") },
		);
		const base = gitIn(repo, "rev-parse", "main");
		const head = gitIn(repo, "rev-parse", "feature");
		gitIn(repo, "checkout", "--quiet", "main");
		writeFileSync(join(repo, file), lines(text));
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "retarget");
		const other = gitIn(repo, "rev-parse", "HEAD");
		gitIn(repo, "checkout", "--quiet", "feature");
		return { base, head, other };
	};

	it.each([
		["took src/a.ts, so the hunk it accepted there is gone", "src/a.ts", "export const a = 2;", "new"],
		["changes an unrelated file, so every hunk it accepted is there", "src/c.ts", "export const c = 1;", "dismissed"],
	])("tests a round since on a base that %s at that base", async (_, file, text, standing) => {
		const { base, head, other } = retargeted(file, text);
		const chain = await citedAcross("lens", `${base}..${head}`);
		const atStart = chain.roundOn(base, head, [], []);
		const onOther = chain.citingAt(
			`${other}..${head}`,
			chain.proof.filter(({ file: cited }) => cited === "src/b.ts" || standing === "dismissed"),
		);
		const retarget = chain.roundOn(other, head, [onOther], [atStart]);
		const read = await chain.readAfter([retarget], [atStart, retarget, onOther], [atStart]);
		expect(standingOf(read).map(([id, status]) => [id, status])).toEqual([[chain.id, standing]]);
	});

	// The host's own lifecycle, over the same sightings at the same revisions, decides whether the finding still stands
	// dismissed once the read round sights it: the finding dismissed at `dismissedAt`, then each sighting in turn.
	async function hostStands(
		id: string,
		dismissedAt: { revision: string; sighting: StoredFinding; hunks: readonly { file: string; hash: string }[] },
		after: readonly { revision: string; sighting: StoredFinding; hunks: readonly { file: string; hash: string }[] }[],
	): Promise<boolean> {
		const fake = createFakeModels();
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
		try {
			const root = await harness.root(context, { agent: { model: fake.ref() } });
			const upsert = (seen: typeof dismissedAt) =>
				root.commit(
					(tx) => upsertFinding(tx, root.id, Finding.parse(seen.sighting), seen.revision, seen.hunks),
					context,
				);
			await upsert(dismissedAt);
			await root.commit(
				(tx) =>
					dismissFinding(
						tx,
						root.id,
						id,
						{ by: "maintainer", reason: "Accepted.", at: "2026-11-20T00:00:00.000Z" },
						dismissedAt.revision,
					),
				context,
			);
			for (const seen of after) await upsert(seen);
			const last = after.at(-1)?.revision ?? dismissedAt.revision;
			const read = await readFindings(harness, root.id, last, context);
			return read.find((each) => each.id === id)?.properties.status === "dismissed";
		} finally {
			await harness.close(context);
		}
	}

	// A seeded generator, so a failing history can be replayed from the seed the test prints.
	const random = (seed: number) => () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	it("never lets a dismissal stand over a random history where the host's own lifecycle reopened it", async () => {
		const outcomes = { both: 0, neither: 0, hostOnly: 0 };
		for (let seed = 1; seed <= 24; seed++) {
			await harness?.close(context);
			harness = undefined;
			const next = random(seed);
			const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
			const { base, head, other } = retargeted("src/a.ts", "export const a = 2;");
			const chain = await citedAcross("lens", `${base}..${head}`);
			const sightingOf = (record: SharedRecord) => (record.payload as { sightings: StoredFinding[] }).sightings[0]!;
			const atStart = chain.roundOn(base, head, [], []);
			const shared: SharedRecord[] = [atStart];
			const host: { revision: string; sighting: StoredFinding; hunks: { file: string; hash: string }[] }[] = [];
			let previous = atStart;
			for (let round = 0, rounds = 1 + Math.floor(next() * 3); round < rounds; round++) {
				const from = pick([base, base, other]);
				gitIn(repo, "checkout", "--quiet", "--detach", from);
				for (const file of ["src/a.ts", "src/b.ts"])
					writeFileSync(join(repo, file), lines(`export const ${file[4]} = ${pick([1, 2, 3])};`));
				gitIn(repo, "commit", "--quiet", "--allow-empty", "--all", "-m", `round ${round}`);
				const to = gitIn(repo, "rev-parse", "HEAD");
				gitIn(repo, "checkout", "--quiet", "feature");
				const revision = (await Changeset.resolve(repo, { mode: "twoDot", base: from, head: to })).revision;
				const hunks = reviewFiles(revision.files).flatMap((file) => file.hunks.map(provingHunk));
				const cited = hunks.filter(() => next() < 0.6);
				const key = Revision.key(revision);
				const read: SharedRecord[] = [];
				if (cited.length > 0) {
					const record = chain.citingAt(key, cited);
					read.push(record);
					shared.push(record);
					host.push({ revision: key, sighting: sightingOf(record), hunks });
				}
				previous = chain.roundOn(from, to, read, [previous]);
				shared.push(previous);
			}
			const readRound = chain.citingAt(`${base}..${head}`, chain.proof);
			const readerStands = standingOf(await chain.readAfter([previous], shared, [atStart]))[0]?.[1] === "dismissed";
			const hostHolds = await hostStands(
				chain.id,
				{ revision: `${base}..${head}`, sighting: sightingOf(readRound), hunks: chain.proof },
				[...host, { revision: `${base}..${head}`, sighting: sightingOf(readRound), hunks: chain.proof }],
			);
			expect({ seed, readerStands: readerStands && !hostHolds }).toEqual({ seed, readerStands: false });
			outcomes[readerStands ? "both" : hostHolds ? "hostOnly" : "neither"]++;
		}
		// Each outcome the histories reach is one the property was tested on, so neither kind of history is missing.
		expect(outcomes.both).toBeGreaterThan(0);
		expect(outcomes.neither).toBeGreaterThan(0);
	}, 120_000);

	it("refuses a round whose chain holds a revision the checkout lacks a commit of, and names it", async () => {
		const chain = await citedAcross("lens", revisionOf("0", "1"));
		const missing = "e".repeat(40);
		const absent = chain.citingAt(`${side("1")}..${missing}`, chain.proof);
		const since = chain.roundOn(side("1"), missing, [absent], [chain.first]);
		const read = await chain.readAfter([since], [chain.first, since, absent], [chain.first]);
		expect(read.status).toBe("not-reviewed");
		const reason = read.notRun.find(({ name }) => name === "records")?.reason;
		expect(reason).toContain(`${missing} does not name a commit`);
		expect(reason).toContain("shallow clone");
		expect(reason).toContain("dismiss the finding again with --records");
		// Dismissed again, its writer holds the round, so the reader never needs that round's revision.
		expect(standingOf(await chain.readAfter([since], [chain.first, since, absent], [chain.first, since]))).toEqual(
			dismissedOf(chain.id),
		);
		// The round since sights nothing of the finding, so nothing needs its revision, and the dismissal stands.
		const silent = chain.roundOn(side("1"), missing, [], [chain.first]);
		expect(standingOf(await chain.readAfter([silent], [chain.first, silent], [chain.first]))).toEqual(
			dismissedOf(chain.id),
		);
	});

	it("refuses a round whose chain needs a revision when it is read with no checkout", async () => {
		const chain = await citedAcross("lens", revisionOf("0", "1"));
		const cited = chain.citingAt(revisionOf("1", "2"), chain.proof);
		const since = chain.roundAt("1", "2", [cited], [chain.first]);
		const records = chain.after([since], [chain.first, since, cited], [chain.first]);
		const round = RecordedRound.of(...records, everyRecordCounts);
		expect(await round.contents(chain.revision)).toEqual({
			refused: `tests a dismissal at round ${since.id} of revision ${revisionOf("1", "2")}, and is read with no checkout to resolve it in`,
		});
		expect(await round.contents(chain.revision, repo)).toHaveProperty("dismissals");
	});

	it("reopens a dismissal once a round after it at the dismissal's own revision cited a hunk the revision lacks", async () => {
		const { id, proof, first, roundAt, citingAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		const cited = citingAt(revisionOf("0", "1"), [...proof, { file: "src/b.ts", hash: "0".repeat(64) }]);
		const again = roundAt("0", "1", [cited], [first]);
		const later = await readAfter([again], [first, again, cited]);
		expect([later.status, later.blocking]).toEqual(["findings", true]);
		expect(standingOf(later)).toEqual([[id, "new", undefined]]);
	});

	it("remembers no hunk a record no round names cited", async () => {
		const { id, elsewhere, first, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		expect(standingOf(await readAfter([first], [first, elsewhere], [first]))).toEqual(dismissedOf(id));
	});

	it("remembers no hunk a round its writer held cited, so a dismissal made again after it holds", async () => {
		const { id, elsewhere, first, second, roundAt, readAfter } = await citedAcross("lens", revisionOf("2", "3"));
		const third = roundAt("2", "3", [], [second]);
		const shared = [first, second, third, elsewhere];
		expect(standingOf(await readAfter([third], shared, [second]))).toEqual(dismissedOf(id));
		expect(standingOf(await readAfter([third], shared, [first]))).toEqual([[id, "new", undefined]]);
	});

	it("remembers nothing for a dismissal whose writer held the round the read round follows", async () => {
		const { id, elsewhere, first, second, readAfter } = await citedAcross("lens");
		expect(standingOf(await readAfter([second], [first, second, elsewhere], [second]))).toEqual(dismissedOf(id));
	});

	// A build before the frontier wrote no record of the rounds it held, so its record counts as no dismissal.
	it("applies no dismissal whose record names no frontier", async () => {
		const { id, first, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		expect(standingOf(await readAfter([first], [first], [first]))).toEqual(dismissedOf(id));
		const unbounded = await readAfter([first], [first], null);
		expect([unbounded.status, unbounded.blocking]).toEqual(["findings", true]);
		expect(standingOf(unbounded)).toEqual([[id, "new", undefined]]);
	});

	it.each([
		["a round the set does not hold", ({ first, elsewhere }: Chain) => [first, elsewhere]],
		["a round that reads a record the set does not hold", ({ first, second }: Chain) => [first, second]],
	])("applies no dismissal past a chain that names %s", async (_, shared) => {
		const chain = await citedAcross("lens", revisionOf("0", "1"));
		const broken = await chain.readAfter([chain.second], shared(chain));
		expect([broken.status, broken.blocking]).toEqual(["findings", true]);
		expect(standingOf(broken)).toEqual([[chain.id, "new", undefined]]);
		expect((await chain.handedAfter([chain.second], shared(chain))).dismissals).toEqual([]);
	});

	it("meets a round since at the revision read from that revision's own files, with no checkout to resolve it", async () => {
		const { first, roundOn, citingAt, handedAfter, proof, revision } = await citedAcross(
			"lens",
			revisionOf("0", "1"),
		);
		const cited = citingAt(Revision.key(revision), proof);
		const since = roundOn(revision.base, revision.head, [cited], [first]);
		const contents = await handedAfter([since], [first, since, cited], [first]);
		expect("refused" in contents ? contents.refused : contents.dismissals.length).toBe(1);
	});

	it("reopens a dismissal a round since at the revision read met citing a hunk that revision lacks, with no checkout", async () => {
		const { first, roundOn, citingAt, handedAfter, proof, revision } = await citedAcross(
			"lens",
			revisionOf("0", "1"),
		);
		const cited = citingAt(Revision.key(revision), [...proof, { file: "src/b.ts", hash: "0".repeat(64) }]);
		const since = roundOn(revision.base, revision.head, [cited], [first]);
		const contents = await handedAfter([since], [first, since, cited], [first]);
		expect("refused" in contents ? contents.refused : contents.dismissals).toEqual([]);
	});

	it("tests a round that follows none as one since the dismissal, and keeps the dismissal while it cites nothing new", async () => {
		const { id, elsewhere, first, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		const severed = roundAt("1", "2", [], []);
		const cited = roundAt("1", "2", [elsewhere], []);
		expect(standingOf(await readAfter([severed], [first, severed], [first]))).toEqual(dismissedOf(id));
		const reopened = await readAfter([cited], [first, cited, elsewhere], [first]);
		expect(standingOf(reopened)).toEqual([[id, "new", undefined]]);
	});

	it("keeps a dismissal past a fork one of whose branches follows none, while neither cites anything new", async () => {
		const { id, first, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		const quiet = roundAt("1", "3", [], [first]);
		const severed = roundAt("4", "5", [], []);
		const forked = await readAfter([quiet, severed], [first, quiet, severed], [first]);
		expect(standingOf(forked)).toEqual(dismissedOf(id));
	});

	// A round names no round of its own revision, so a chain that ends there, at the revision of every round the
	// writer held, was not cut, and its rounds count as since the dismissal.
	it("tests a chain that ends at the revision of every round its writer held, as one since the dismissal", async () => {
		const { id, elsewhere, first, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		const quiet = roundAt("0", "1", [], []);
		const cited = roundAt("0", "1", [elsewhere], []);
		expect(standingOf(await readAfter([quiet], [first, quiet], [first]))).toEqual(dismissedOf(id));
		const reopened = await readAfter([cited], [first, cited, elsewhere], [first]);
		expect(standingOf(reopened)).toEqual([[id, "new", undefined]]);
		const fresh = await readAfter([quiet], [quiet], []);
		expect(standingOf(fresh)).toEqual(dismissedOf(id));
	});

	it("remembers what a round of the set outside the frontier cited, whichever branch the round read follows", async () => {
		const { id, elsewhere, first, second, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		const quiet = roundAt("1", "3", [], [first]);
		expect(standingOf(await readAfter([quiet], [first, quiet], [first]))).toEqual(dismissedOf(id));
		const shared = [first, second, quiet, elsewhere];
		for (const before of [[quiet], [quiet, second]])
			expect(standingOf(await readAfter(before, shared, [first]))).toEqual([[id, "new", undefined]]);
	});

	it("applies no dismissal past a chain that names a record that is not a round", async () => {
		const { id, elsewhere, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		expect(standingOf(await readAfter([elsewhere], [elsewhere]))).toEqual([[id, "new", undefined]]);
	});

	it("applies no dismissal past a chain that names a round of another changeset", async () => {
		const { id, roundAt, readAfter } = await citedAcross("lens", revisionOf("0", "1"));
		const elsewhere = roundAt("1", "2", [], [], "f".repeat(64));
		expect(standingOf(await readAfter([elsewhere], [elsewhere]))).toEqual([[id, "new", undefined]]);
	});

	it("hands over a dismissal of a finding no shared round sights with no cited hunk", async () => {
		const { reviewed } = await dismissedAndReviewedAgain(blocks);
		const { sighting: seen } = redismissed(reviewed).payload as DismissalPayload;
		const { properties } = seen.finding as unknown as StoredFinding;
		const created = Finding.create({
			rule: "other-rule",
			message: "a is exported",
			file: "src/a.ts",
			startLine: 1,
			snippet: "export const a = 2;",
			occurrence: 0,
			cause: "introduced",
			severity: "P2",
			resolution: "block",
			explanation: { what: "a is exported.", whyHere: "This change exports it.", whatToDo: "Keep it." },
			source: properties.source,
		}).toJSON();
		const other = created.properties.id;
		const unsighted = redismissed(
			reviewed,
			{
				sighting: {
					...seen,
					finding: {
						...created,
						properties: {
							...created.properties,
							status: (seen.finding as unknown as StoredFinding).properties.status,
						},
					},
				},
			} as Partial<DismissalJson>,
			{ key: other },
		);
		const contents = (await RecordedRound.of(
			[...reviewed.stored, unsighted],
			roundOf(reviewed.stored),
			everyRecordCounts,
		).contents(reviewed.changeset.revision)) as RecordedRoundContents;
		expect(contents.dismissals.find(({ finding: each }) => each === other)?.cited).toEqual([]);
	});

	it("keeps a finding dismissed only while every producer's sighting meets the accepted trigger", async () => {
		const { reviewed, id } = await dismissedAndReviewedAgain(blocks);
		const records = reviewed.stored.map((each) => SharedRecord.parseEnvelope(each));
		const round = records.find(({ id: each }) => each === roundOf(reviewed.stored))!;
		const [seen] = (sighting(records, round).payload as { sightings: StoredFinding[] }).sightings;
		const source = { check: "lens.correctness", version: "other@careful" };
		const other = (hash: string) => ({
			...seen!,
			properties: { ...seen!.properties, source, trigger: { ...seen!.properties.trigger!, hash } },
		});
		const { by, reason, at, trigger } = redismissed(reviewed).payload as DismissalJson & { by: string };
		const dismissals = new Map([[id, [{ by, reason, at, trigger, cited: [] }]]]);
		const producers = [seen!.properties.source, source];
		const statusUnder = (hash: string) =>
			mergeSightings([seen!, other(hash)], [], producers, dismissals, []).map(({ properties }) => properties.status);
		expect(statusUnder(trigger.hash)).toEqual(["dismissed"]);
		expect(statusUnder("0".repeat(64))).toEqual(["new"]);
	});
});

describe("a round decided under another policy", () => {
	const accountOf = (reviewed: Reviewed) =>
		reviewed.stored.find(({ kind }) => kind === "account")!.payload as AccountPayload;
	const refusedWith = (verdict: Verdict, round: string, reason: string) => {
		expect(verdict.status).toBe("not-reviewed");
		expect(verdict.notRun).toEqual([{ name: "records", status: "failed", reason: `round ${round} ${reason}` }]);
	};

	it("decides as the review did when the reader holds the policy the review decided under", async () => {
		const reviewed = await review(exported(), { policy: worktree });
		expect(accountOf(reviewed).resolutionPolicy).toMatch(/^3:[0-9a-f]{16}$/);
		expect(reviewed.verdict.status).toBe("findings");
		expectSharedVerdict((await readUnder(reviewed, worktree)).toJSON(), reviewed.verdict.toJSON());
	});

	it("reads not reviewed once melian.yaml changes what blocks between the review and the read", async () => {
		const reviewed = await review(exported(), { policy: worktree });
		const decidedUnder = accountOf(reviewed).resolutionPolicy;
		writeFileSync(join(repo, "melian.yaml"), lines("resolution:", "  P2: advisory"));
		const verdict = await readUnder(reviewed, worktree);
		const readsUnder = verdict.notRun[0]?.reason?.match(/this checkout's reads (\S+)$/)?.[1];
		expect(readsUnder).toMatch(/^3:[0-9a-f]{16}$/);
		expect(readsUnder).not.toBe(decidedUnder);
		refusedWith(
			verdict,
			roundOf(reviewed.stored),
			`was decided under resolution policy ${decidedUnder}, and this checkout's reads ${readsUnder}`,
		);
	});

	it.each<[string, Partial<{ repoRoot: string; policy: RepositorySource }>, boolean]>([
		["no checkout and no policy source", {}, false],
		["a checkout and no policy source", { repoRoot: "." }, false],
		["a policy source and no checkout", { policy: worktree }, false],
		["no policy source, once melian.yaml makes P2 advisory", {}, true],
	])("reads not reviewed when the reader holds %s", async (_, given, advisory) => {
		writeFileSync(join(repo, "melian.yaml"), lines("resolution:", "  P2: block"));
		const reviewed = await review(exported());
		expect(reviewed.verdict.findings.block.map(({ ruleId }) => ruleId)).toEqual(["changed-return"]);
		if (advisory) writeFileSync(join(repo, "melian.yaml"), lines("resolution:", "  P2: advisory"));
		const verdict = await RecordedRound.of(reviewed.stored, roundOf(reviewed.stored), everyRecordCounts).verdict({
			revision: reviewed.changeset.revision,
			config: reviewed.config,
			...(given.repoRoot === undefined ? {} : { repoRoot: repo }),
			...(given.policy === undefined ? {} : { policy: given.policy }),
		});
		refusedWith(verdict, roundOf(reviewed.stored), "is read with no resolution policy to decide under");
	});

	it.each<[string, RepositorySource | undefined]>([
		["one", worktree],
		["none", undefined],
	])("reads not reviewed when the review read no policy source and the reader reads %s", async (_, policy) => {
		const reviewed = await review(exported(), { policy: null });
		expect(accountOf(reviewed).resolutionPolicy).toBeNull();
		const verdict = await RecordedRound.of(reviewed.stored, roundOf(reviewed.stored), everyRecordCounts).verdict({
			revision: reviewed.changeset.revision,
			config: reviewed.config,
			...(policy === undefined ? {} : { repoRoot: repo, policy }),
		});
		refusedWith(
			verdict,
			roundOf(reviewed.stored),
			"was decided under no resolution policy, so no reader can decide it",
		);
	});

	it("refuses an account main wrote before accounts named their resolution policy", () => {
		const { records } = JSON.parse(
			readFileSync(new URL("./fixtures/records-main/records.json", import.meta.url), "utf8"),
		) as { records: RecordEnvelope[] };
		const id = "54d57830";
		const round = records.find(
			(each) => each.kind === "round" && SharedRecord.parseEnvelope(each).id.startsWith(id),
		)!;
		const set = records.filter(({ changeset }) => changeset === round.changeset);
		const account = SharedRecord.parseEnvelope(set.find(({ kind }) => kind === "account")!);
		expect(account.payload).toMatchObject({ v: 1 });
		expect(account.payload).not.toHaveProperty("resolutionPolicy");
		expect(RecordedRound.of(set, SharedRecord.parseEnvelope(round).id, everyRecordCounts).refusal()).toBe(
			"names an account written before accounts named their resolution policy",
		);
	});

	it("refuses the records a build wrote before they withheld outside text", () => {
		const recorded = JSON.parse(
			readFileSync(new URL("./fixtures/account-v1/recorded.json", import.meta.url), "utf8"),
		) as { records: RecordEnvelope[] };
		const round = RecordedRound.of(recorded.records, roundOf(recorded.records), everyRecordCounts);
		expect(round.refusal()).toBe(
			"its records fail their checks: a verification record's payload does not match its schema at /outcomes/0/outcome: must have required properties model",
		);
	});
});

describe("a round its records cannot stand for", () => {
	it.each<[string, (reviewed: Reviewed, records: SharedRecord[], round: SharedRecord) => Rebuilt, string]>([
		[
			"a round the records do not hold",
			(_, records) => ({ records: records.map((each) => each.toJSON()), round: "0".repeat(64) }),
			"is not among the records",
		],
		[
			"a record the round names is missing",
			(_, records, round) => {
				const check = namedOf(records, round, "check");
				return { records: records.filter((each) => each !== check).map((each) => each.toJSON()), round: round.id };
			},
			"names records the set does not hold",
		],
		[
			"the round names no account",
			(reviewed, records, round) =>
				renamed(reviewed, records, round, (read) => read.filter(({ kind }) => kind !== "account")),
			"names no account, or more than one",
		],
		[
			"the round names two accounts",
			(reviewed, records, round) => {
				const account = namedOf(records, round, "account");
				const other = SharedRecord.parseEnvelope({
					...account.toJSON(),
					payload: { ...(account.payload as object), allowSkip: ["static.tsc"] },
				});
				const rebuilt = renamed(reviewed, [...records, other], round, (read) => [...read, other]);
				return rebuilt;
			},
			"names no account, or more than one",
		],
		[
			"the account is keyed for other records",
			(reviewed, records, round) => {
				const account = namedOf(records, round, "account");
				return rebuiltWith(
					reviewed,
					records,
					round,
					account,
					SharedRecord.parseEnvelope({ ...account.toJSON(), key: recordKey("another request") }),
				);
			},
			"names an account of other records than its own",
		],
		[
			"the account counts other records than the round names",
			(reviewed, records, round) => {
				const account = namedOf(records, round, "account");
				const payload = account.payload as AccountPayload;
				const counted = payload.records.slice(1);
				const key = accountKey(account.revision ?? null, { ...payload, records: counted });
				const other = SharedRecord.parseEnvelope({
					...account.toJSON(),
					key,
					payload: { ...payload, records: counted },
				});
				return rebuiltWith(reviewed, records, round, account, other);
			},
			"names an account of other records than its own",
		],
		[
			"a lens that stands for its run holds no check",
			(reviewed, records, round) => {
				const lens = namedOf(records, round, "lens");
				return rebuilt(reviewed, records, round, lens, { ...(lens.payload as object), check: null } as RecordJson);
			},
			"without the check its run decided",
		],
		[
			"a verification holds no check",
			(reviewed, records, round) => {
				const verification = namedOf(records, round, "verification");
				return rebuilt(reviewed, records, round, verification, {
					...(verification.payload as object),
					check: null,
				} as RecordJson);
			},
			"names a verification without the verifier's check",
		],
		[
			"a lens sights one finding twice",
			(reviewed, records, round) => {
				const lens = sighting(records, round);
				const payload = lens.payload as { sightings: { properties: object }[] };
				return rebuilt(reviewed, records, round, lens, {
					...payload,
					sightings: [...payload.sightings, lowered(payload.sightings[0]!)],
				} as unknown as RecordJson);
			},
			"names one finding twice from one producer",
		],
		[
			"two lens records of one producer sight one finding",
			(reviewed, records, round) => {
				const lens = sighting(records, round);
				const payload = lens.payload as { sightings: { properties: object }[] };
				const other = SharedRecord.parseEnvelope({
					...lens.toJSON(),
					key: recordKey("another request"),
					payload: { ...payload, sightings: [lowered(payload.sightings[0]!)] } as unknown as RecordJson,
				});
				return added(reviewed, records, round, other);
			},
			"names one finding twice from one producer",
		],
		[
			"a verification judges one finding twice for one producer",
			(reviewed, records, round) => {
				const verification = namedOf(records, round, "verification");
				const payload = verification.payload as { claims: { verification: object }[] };
				const [claim] = payload.claims;
				return rebuilt(reviewed, records, round, verification, {
					...payload,
					claims: [...payload.claims, { ...claim!, verification: { ...claim!.verification, verdict: "refuted" } }],
				} as unknown as RecordJson);
			},
			"judges one finding twice for one producer",
		],
		[
			"the account's payload is null",
			(reviewed, records, round) => rebuilt(reviewed, records, round, namedOf(records, round, "account"), null),
			"its records fail their checks",
		],
		[
			"a record fails its kind's check",
			(reviewed, records, round) => {
				const check = namedOf(records, round, "check");
				return rebuilt(reviewed, records, round, check, { ...(check.payload as object), result: 1 } as RecordJson);
			},
			"its records fail their checks",
		],
	])("reads not reviewed when %s, and says why", async (_, change, reason) => {
		const reviewed = await review(exported());
		expect(reviewed.verdict.status).toBe("findings");
		const records = reviewed.stored.map((each) => SharedRecord.parseEnvelope(each));
		const round = records.find(({ id }) => id === roundOf(reviewed.stored))!;
		const changed = change(reviewed, records, round);
		const recorded = RecordedRound.of(changed.records, changed.round, everyRecordCounts);
		expect(recorded.refusal()).toContain(reason);
		const verdict = await read(reviewed, changed.records, changed.round);
		expect(verdict.status).toBe("not-reviewed");
		expect(verdict.notRun).toEqual([
			{ name: "records", status: "failed", reason: `round ${changed.round} ${recorded.refusal()}` },
		]);
	});

	it("reads a round whose records do not count as not reviewed", async () => {
		const reviewed = await review(exported(), { contracts: [quiet, quiet] });
		const round = RecordedRound.of(reviewed.stored, roundOf(reviewed.stored), () => false);
		expect(round.refusal()).toBe("is not among the records, or does not count");
		expect(RecordedRound.of(reviewed.stored, roundOf(reviewed.stored), everyRecordCounts).refusal()).toBeUndefined();
	});

	it("lets an error that is not a record's refusal escape", async () => {
		const reviewed = await review(exported(), { contracts: [quiet, quiet] });
		const counts = () => {
			throw new Error("the writers could not be read");
		};
		expect(() => RecordedRound.of(reviewed.stored, roundOf(reviewed.stored), counts)).toThrow(
			"the writers could not be read",
		);
	});
});

// The first record of `kind` the round names.
function namedOf(records: readonly SharedRecord[], round: SharedRecord, kind: string): SharedRecord {
	const named = new Set(round.manifest()!.read.map(({ id }) => id));
	return records.find((record) => record.kind === kind && named.has(record.id))!;
}

type Rebuilt = { readonly records: RecordEnvelope[]; readonly round: string };

// The named lens record that holds a sighting.
function sighting(records: readonly SharedRecord[], round: SharedRecord): SharedRecord {
	const named = new Set(round.manifest()!.read.map(({ id }) => id));
	return records.find(
		(record) =>
			record.kind === "lens" &&
			named.has(record.id) &&
			(record.payload as { sightings: unknown[] }).sightings.length > 0,
	)!;
}

// A copy of `sighting` at P3, which alone would leave the finding advisory.
function lowered(sighting: { properties: object }): object {
	return { ...sighting, level: "note", properties: { ...sighting.properties, severity: "P3" } };
}

// The records with `other` added, and the account and the round written again to name it beside the rest.
function added(
	reviewed: Reviewed,
	records: readonly SharedRecord[],
	round: SharedRecord,
	other: SharedRecord,
): Rebuilt {
	const account = namedOf(records, round, "account");
	const payload = account.payload as AccountPayload;
	const counted = [...payload.records, other.id].sort();
	const key = accountKey(account.revision ?? null, { ...payload, records: counted });
	const next = SharedRecord.parseEnvelope({ ...account.toJSON(), key, payload: { ...payload, records: counted } });
	const all = [...records.filter((each) => each !== account), next, other];
	return renamed(reviewed, all, round, (read) => [...read.map((each) => (each === account ? next : each)), other], [
		...records,
		next,
		other,
	]);
}

function without(payload: RecordJson, field: string): RecordJson {
	const { [field]: _, ...rest } = payload as Record<string, RecordJson>;
	return rest;
}

// The records with `record`'s payload replaced, and the account and the round written again to name the new record,
// so only the change itself, never a stale ID, decides what the reader reads.
function rebuilt(
	reviewed: Reviewed,
	records: readonly SharedRecord[],
	round: SharedRecord,
	record: SharedRecord,
	payload: RecordJson,
): Rebuilt {
	return rebuiltWith(reviewed, records, round, record, SharedRecord.parseEnvelope({ ...record.toJSON(), payload }));
}

function rebuiltWith(
	reviewed: Reviewed,
	records: readonly SharedRecord[],
	round: SharedRecord,
	record: SharedRecord,
	changed: SharedRecord,
): Rebuilt {
	const swapped = records.map((each) => (each === record ? changed : each));
	let account = swapped.find(
		({ kind, id }) => kind === "account" && round.manifest()!.read.some((entry) => entry.id === id),
	);
	if (record.kind !== "account" && account !== undefined) {
		const payload = account.payload as AccountPayload;
		const counted = payload.records.map((id) => (id === record.id ? changed.id : id)).sort();
		const key = accountKey(account.revision ?? null, { ...payload, records: counted });
		const next = SharedRecord.parseEnvelope({ ...account.toJSON(), key, payload: { ...payload, records: counted } });
		swapped.splice(swapped.indexOf(account), 1, next);
		account = next;
	}
	return renamed(
		reviewed,
		swapped,
		round,
		(read) =>
			read.map((entry) => {
				if (entry.id === record.id) return changed;
				if (entry.kind === "account") return account!;
				return entry;
			}),
		records,
	);
}

// The records with the round written again over the records `names` gives for the ones it read.
function renamed(
	reviewed: Reviewed,
	records: readonly SharedRecord[],
	round: SharedRecord,
	names: (read: SharedRecord[]) => SharedRecord[],
	before: readonly SharedRecord[] = records,
): Rebuilt {
	const byId = new Map(before.map((each) => [each.id, each]));
	const manifest = round.manifest()!;
	const read = names(manifest.read.map(({ id }) => byId.get(id)!));
	const { base, head } = reviewed.changeset.revision;
	const next = ReviewRecords.of(reviewed.changeset.id, { base, head }).round(
		read,
		undefined,
		manifest.replaces,
		manifest.before,
	);
	return { records: [...records.filter((each) => each !== round), next].map((each) => each.toJSON()), round: next.id };
}
