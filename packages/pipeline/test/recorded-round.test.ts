import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AccountPayload,
	Changeset,
	defaultConfig,
	everyRecordCounts,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	type RecordJson,
	type RepositorySource,
	reviewPayloads,
	SharedRecord,
	Standards,
	type Verdict,
} from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import {
	type CheckRunRecord,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	decisionExtension,
	type Harness,
	type Message,
	openHarness,
	RecordedRound,
	ReviewError,
	recordDismissal,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountKey, ReviewRecords } from "../src/review-records.ts";
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
		checks: [...(scenario.given ?? checks)],
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
		const recorded = JSON.parse(
			readFileSync(new URL("./fixtures/account-v1/recorded.json", import.meta.url), "utf8"),
		) as { records: RecordEnvelope[] };
		const account = recorded.records.find(({ kind }) => kind === "account")!;
		expect(account.payload).toMatchObject({ v: 1 });
		expect(account.payload).not.toHaveProperty("resolutionPolicy");
		const round = RecordedRound.of(recorded.records, roundOf(recorded.records), everyRecordCounts);
		expect(round.refusal()).toBe("names an account written before accounts named their resolution policy");
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
					SharedRecord.parseEnvelope({ ...account.toJSON(), key: "k".repeat(64) }),
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
					key: "k".repeat(64),
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
