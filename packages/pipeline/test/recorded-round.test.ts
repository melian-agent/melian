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
	type StoredFinding,
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
import { mergeSightings } from "../src/findings.ts";
import { provingHunk, reviewFiles } from "../src/lens-tools.ts";
import { accountKey, ReviewRecords } from "../src/review-records.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers, withBudget } from "./fixtures/review-scenario.ts";

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

// Asks the same of the reader as of the host, for one end state: the whole verdict, and a record for every check.
async function decidesAsTheHost(scenario: Scenario): Promise<Verdict> {
	const reviewed = await review(exported(), scenario);
	expect(unexported(reviewed)).toEqual([]);
	expect((await read(reviewed)).toJSON()).toEqual(reviewed.verdict.toJSON());
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
		expect(verdict.toJSON()).toEqual(reviewed.verdict.toJSON());
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
		expect(unverified(verdict)).toEqual(unverified(reviewed.verdict));
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
				const each = redismissed(reviewed, { reason: "later", at: `2026-11-17T00:00:0${n % 10}.${n}Z` });
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
		const dismissals = new Map([[id, { by, reason, at, trigger }]]);
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
		expect(accountOf(reviewed).resolutionPolicy).toMatch(/^2:[0-9a-f]{16}$/);
		expect(reviewed.verdict.status).toBe("findings");
		expect((await readUnder(reviewed, worktree)).toJSON()).toEqual(reviewed.verdict.toJSON());
	});

	it("reads not reviewed once melian.yaml changes what blocks between the review and the read", async () => {
		const reviewed = await review(exported(), { policy: worktree });
		const decidedUnder = accountOf(reviewed).resolutionPolicy;
		writeFileSync(join(repo, "melian.yaml"), lines("resolution:", "  P2: advisory"));
		const verdict = await readUnder(reviewed, worktree);
		const readsUnder = verdict.notRun[0]?.reason?.match(/this checkout's reads (\S+)$/)?.[1];
		expect(readsUnder).toMatch(/^2:[0-9a-f]{16}$/);
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
