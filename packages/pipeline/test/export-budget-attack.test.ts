import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Adjudication,
	Changeset,
	canonicalJson,
	DirectoryRecordStore,
	defaultConfig,
	Finding,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	pullRequestChangesetId,
	type RecordStore,
	recordLimit,
	reviewPayloads,
	type SharedRecord,
	SightingBudget,
	snippetHash,
	TierAccount,
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
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import type { CheckRunRecord } from "../src/checks.ts";
import { clearVerifications, FindingsDocument, upsertFinding, upsertVerification } from "../src/findings.ts";
import { defineDoc, type JsonObject, openJsonlStorage, openSqliteStorage } from "../src/harness.ts";
import { RelayBatch, RelayRefusal, relayLimits } from "../src/record-relay.ts";
import { ReviewRecords } from "../src/review-records.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const changeset = pullRequestChangesetId("github", { owner: "octo", name: "repo" }, 7);
const request = "d".repeat(64);
const records = () => ReviewRecords.of(changeset, { base, head });
const bytes = (record: SharedRecord) => Buffer.byteLength(record.bytes);
const arrayBytes = (findings: readonly Finding[]) => Buffer.byteLength(canonicalJson(findings.map((f) => f.toJSON())));

// A Biome finding as the static runner stores it locally: the tool's short text, which the shared projection replaces
// with fixed, longer sentences.
function biome(index: number, text = "This is an unexpected 'debugger' statement.", fix = "Remove it."): Finding {
	const path = `src/f${Math.floor(index / 200)}.ts`;
	return Finding.create({
		rule: "lint/suspicious/noDebugger",
		message: text,
		file: path,
		startLine: (index % 200) + 1,
		discriminator: "biome",
		cause: "introduced",
		trigger: { file: path, index: 0, hash: snippetHash(`blob:${index}`) },
		severity: "P2",
		explanation: { what: text, whyHere: text, whatToDo: fix },
		source: { check: "static.biome", version: "2.5.0" },
	});
}

function guardrail(index: number, pad: string): Finding {
	const path = `packages/p${index}/package.json`;
	return Finding.create({
		rule: "guardrail/policy-change-review",
		message: `Review the change to ${path}.`,
		file: path,
		startLine: 1,
		discriminator: "analyser",
		cause: "introduced",
		trigger: { file: path, index: 0, hash: snippetHash(`blob:${index}`) },
		severity: "P1",
		explanation: { what: `Changes ${path}. ${pad}`, whyHere: "Policy.", whatToDo: "Read it." },
		source: { check: "guardrails" },
		guardrail: { notice: "analyser" },
	});
}

const ran = (name: string, findings: number, version?: string): CheckRunRecord => ({
	name,
	status: "ran",
	...(version === undefined ? {} : { version }),
	findings,
	notes: [],
});

describe("case 3: a projection larger than the local findings", () => {
	it("never lets local findings that pass the budget export a record past the store's limit", () => {
		const bare = bytes(records().check(request, ran("static.biome", 0, "2.5.0"), []));
		const projectedOne = bytes(records().check(request, ran("static.biome", 1, "2.5.0"), [biome(0).toJSON()])) - bare;
		const localOne = arrayBytes([biome(0)]) - 2;
		expect(projectedOne).toBeGreaterThan(localOne);
		// As many findings as the local budget allows, every one kept whole.
		const findings = Array.from(
			{ length: Math.floor((SightingBudget.checkRecord.bytes - 1) / (localOne + 1)) + 200 },
			(_, index) => biome(index),
		);
		while (arrayBytes(findings) > SightingBudget.checkRecord.bytes) findings.pop();
		const count = findings.length;
		expect(SightingBudget.checkRecord.fit(findings)).toEqual(findings);
		const record = records().check(
			request,
			ran("static.biome", count, "2.5.0"),
			findings.map((f) => f.toJSON()),
		);
		// The design's promise: what passes the budget is what the store keeps.
		expect(bytes(record)).toBeLessThanOrEqual(recordLimit);
	});
});

describe("case 2: a projection smaller than the local findings", () => {
	it("does not fail a static check whose projected record fits", () => {
		const fix = "f".repeat(2048);
		const findings = Array.from({ length: 3000 }, (_, index) => biome(index, "x", fix));
		expect(arrayBytes(findings)).toBeGreaterThan(6 * 1024 * 1024);
		const record = records().check(
			request,
			ran("static.biome", findings.length, "2.5.0"),
			findings.map((f) => f.toJSON()),
		);
		expect(bytes(record)).toBeLessThan(recordLimit);
		// Today runCheck fits the local findings first, and the local fit fails closed.
		expect(() => SightingBudget.checkRecord.fit(findings)).not.toThrow();
	});
});

describe("the room measured from a record with no sightings", () => {
	const findings = Array.from({ length: 1234 }, (_, index) => guardrail(index, "pad"));

	it("is exact when the record carries the count it will hold", () => {
		const bare = bytes(records().check(request, ran("guardrails", findings.length), []));
		const full = bytes(
			records().check(
				request,
				ran("guardrails", findings.length),
				findings.map((f) => f.toJSON()),
			),
		);
		expect(full).toBe(bare - 2 + arrayBytes([...findings].sort((a, b) => (a.id < b.id ? -1 : 1))));
	});

	it("is exact for a host record that leaves out the count, as exportRound fills it from the sightings", () => {
		// exportRound builds `{ findings: sightings.length, ...given }`; with no count given and no sightings the bare
		// record says 0, and the real one says 1234, four digits longer.
		const fill = (sightings: number) =>
			({ findings: sightings, notes: [], name: "guardrails", status: "ran" }) as never;
		const bare = bytes(records().check(request, fill(0), []));
		const full = bytes(
			records().check(
				request,
				fill(findings.length),
				findings.map((f) => f.toJSON()),
			),
		);
		expect(full).toBe(bare - 2 + arrayBytes([...findings].sort((a, b) => (a.id < b.id ? -1 : 1))));
	});

	it("fits a record of exactly the limit untrimmed, and trims one a byte past", () => {
		const bare = bytes(records().check(request, ran("guardrails", findings.length), []));
		const exact = recordLimit - bare + 2;
		// Pad the last finding so the whole array is exactly the room.
		const short = arrayBytes(findings);
		const padded = [...findings.slice(0, -1), guardrail(findings.length - 1, `pad${"y".repeat(exact - short)}`)];
		expect(arrayBytes(padded)).toBe(exact);
		const fitted = new SightingBudget(exact).fit(padded);
		expect(fitted).toEqual(padded);
		const at = records().check(
			request,
			ran("guardrails", padded.length),
			fitted.map((f) => f.toJSON()),
		);
		expect(bytes(at)).toBe(recordLimit);
		const over = [...findings.slice(0, -1), guardrail(findings.length - 1, `pad${"y".repeat(exact - short + 1)}`)];
		const trimmed = new SightingBudget(exact).fit(over);
		expect(trimmed).not.toEqual(over);
		const past = records().check(
			request,
			ran("guardrails", over.length),
			trimmed.map((f) => f.toJSON()),
		);
		expect(bytes(past)).toBeLessThanOrEqual(recordLimit);
	});
});

describe("a check the measure fails keeps its local findings", () => {
	it("gives the local verdict the groups and blocking the shared record, which holds none of them, gives", () => {
		const findings = Array.from({ length: 3 }, (_, index) => guardrail(index, "pad"));
		// The design fails the check in the adjudication input and exports its record with no sightings, but nothing
		// removes its sightings from the findings document, which adjudication reads.
		const local = new Adjudication({
			findings,
			manifest: ["guardrails"],
			checks: [{ name: "guardrails", status: "failed", reason: "recordTooLarge" }],
			config: defaultConfig,
		}).adjudicate();
		const shared = new Adjudication({
			findings: [],
			manifest: ["guardrails"],
			checks: [{ name: "guardrails", status: "failed", reason: "recordTooLarge" }],
			config: defaultConfig,
		}).adjudicate();
		expect(local.status).toBe("not-reviewed");
		expect({ blocking: local.blocking, all: local.all().length }).toEqual({
			blocking: shared.blocking,
			all: shared.all().length,
		});
	});
});

describe("the findings version the builder reads", () => {
	it("is the version adjudication decides from, even when the verifier was refused", async () => {
		const harness = await openHarness(createMemoryStorage(), {
			models: createFakeModels().models,
			registry: createReviewRegistry(),
		});
		try {
			const root = await harness.root(context);
			const revision = `${base}..${head}`;
			const finding = guardrail(0, "pad");
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, finding, revision);
				await upsertVerification(tx, root.id, revision, finding.id, finding.properties.source, {
					verdict: "confirmed",
					reason: "Seen.",
					executor: "llm",
					model: "fake/light",
					version: "1",
				} as never);
			}, context);
			// The builder reads here, before adjudicationInput.
			const read = (await harness.snapshot(FindingsDocument, root.id, context))!.versions[revision] ?? 0;
			// startAdjudication with verificationRefused clears verifications in its own commit (review.ts:2115).
			await root.commit(async (tx) => {
				await clearVerifications(tx, root.id, revision);
			}, context);
			const decided = (await harness.snapshot(FindingsDocument, root.id, context))!.versions[revision] ?? 0;
			expect(decided).toBe(read);
		} finally {
			await harness.close(context);
		}
	});
});

describe("the relay's sum and the record bytes", () => {
	const names = ["guardrails", "static.biome", "static.tsc"];
	const tier = TierAccount.of({ ...defaultConfig, tiers: { relay: names } }, "relay", { loaded: [], selected: [] });
	const writer = { changeset, revision: `${base}..${head}`, fork: false, tier, handedOver: [] };
	const directories: string[] = [];
	afterEach(async () => {
		for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
	});

	const guardrailsOf = (pad: number) =>
		records().check(request, ran("guardrails", 1), [guardrail(0, "x".repeat(pad)).toJSON()]);
	const staticOf = (name: string, count: number) => {
		const findings = Array.from({ length: count }, (_, index) =>
			Finding.parse({
				...biome(index).toJSON(),
				properties: { ...biome(index).properties, source: { check: name, version: "2.5.0" } },
			} as never),
		);
		return records().check(
			request,
			ran(name, count, "2.5.0"),
			findings.map((f) => f.toJSON()),
		);
	};
	const batchOf = (checks: SharedRecord[]) => {
		const made = records().account({
			checks: names,
			records: checks,
			filled: [],
			allowSkip: [],
			producers: names.map((check) => ({ check })),
			resolutionPolicy: null,
		});
		return [...checks, made, records().round([...checks, made], undefined, [], [])];
	};
	const sum = (all: readonly SharedRecord[]) => all.reduce((total, record) => total + bytes(record), 0);
	async function written(all: readonly SharedRecord[]) {
		const directory = await mkdtemp(join(tmpdir(), "melian-export-budget-"));
		directories.push(directory);
		const store = await DirectoryRecordStore.open(directory, reviewPayloads);
		await store.add(all.map((record) => record.toJSON()));
		await store.close();
		return directory;
	}

	it("sums what the relay sums, takes a batch of exactly 8 MiB and refuses one a byte past", async () => {
		const statics = [staticOf("static.biome", 3000), staticOf("static.tsc", 3000)];
		const small = batchOf([guardrailsOf(1), ...statics]);
		// The account and round name records by ID, so their bytes do not move when a check grows.
		const grown = batchOf([guardrailsOf(1000), ...statics]);
		expect(bytes(grown.at(-1)!) + bytes(grown.at(-2)!)).toBe(bytes(small.at(-1)!) + bytes(small.at(-2)!));
		const pad = 1 + relayLimits.bytes - sum(small);
		const at = batchOf([guardrailsOf(pad), ...statics]);
		expect(sum(at)).toBe(relayLimits.bytes);
		expect(Math.max(...at.map(bytes))).toBeLessThanOrEqual(recordLimit);
		const batch = await RelayBatch.read(await written(at), writer);
		expect(batch.records).toHaveLength(5);
		const past = batchOf([guardrailsOf(pad + 1), ...statics]);
		expect(sum(past)).toBe(relayLimits.bytes + 1);
		await expect(RelayBatch.read(await written(past), writer)).rejects.toSatisfy(
			(error: unknown) => error instanceof RelayRefusal && error.code === "batchTooLarge",
		);
	});
});

describe("the local store's limits", () => {
	const big = defineDoc<JsonObject>({
		kind: "attack.big",
		version: 1,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({}),
	});
	const value = (n: number) => ({ items: Array.from({ length: n }, (_, i) => `${i}-${"z".repeat(500)}`) });

	it.each(["memory", "sqlite", "jsonl"] as const)(
		"holds a 6 MB document through %s storage and a reopen",
		async (kind) => {
			const directory = await mkdtemp(join(tmpdir(), "melian-export-budget-store-"));
			try {
				const open = async () =>
					kind === "memory"
						? createMemoryStorage()
						: kind === "sqlite"
							? await openSqliteStorage(join(directory, "state.sqlite"))
							: await openJsonlStorage(join(directory, "jsonl"));
				const memory = kind === "memory" ? createMemoryStorage() : undefined;
				const fake = createFakeModels();
				const first = await openHarness(memory ?? (await open()), {
					models: fake.models,
					registry: createReviewRegistry(),
				});
				const root = await first.root(context);
				for (const n of [12_000, 12_001]) {
					await first.commit(async (tx) => {
						Object.assign(await tx.doc(big, root.id), value(n));
					}, context);
				}
				expect(Buffer.byteLength(JSON.stringify(await first.snapshot(big, root.id, context)))).toBeGreaterThan(
					6_000_000,
				);
				await first.close(context);
				if (memory !== undefined) return;
				const second = await openHarness(await open(), { models: fake.models, registry: createReviewRegistry() });
				try {
					const again = (await second.snapshot(big, root.id, context)) as { items: string[] };
					expect(again.items).toHaveLength(12_001);
				} finally {
					await second.close(context);
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
});

// A lens can report findings of any length: report_finding bounds no explanation field, and a lens whose LENS.md sets
// no token budget is unbounded.
describe("lens records no trim can shrink", { timeout: 120_000 }, () => {
	let repo: string;
	let harness: Harness | undefined;
	beforeEach(() => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		repo = baseAndHead(
			{ "src/a.ts": lines("export const a = 1;", "export const b = 1;", "export const c = 1;") },
			{ "src/a.ts": lines("export const a = 2;", "export const b = 2;", "export const c = 2;") },
		);
	});
	afterEach(async () => {
		await harness?.close(context);
		harness = undefined;
		vi.unstubAllEnvs();
		rmSync(repo, { recursive: true, force: true });
	});

	// Each named lens reports `count` findings, one a turn, each with `size` bytes of text.
	async function review(store: RecordStore, size: number, count: number, named: readonly string[]) {
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }, { id: "light" }] });
		const heavy = fake.ref("heavy");
		const light = fake.ref("light");
		const config: MelianConfig = {
			...defaultConfig,
			tiers: twoLensTiers,
			checks: { allowSkip: ["static.tsc", "decisions.fast"] },
			models: {
				heavy: { model: `${heavy.provider}/${heavy.modelId}` },
				light: { model: `${light.provider}/${light.modelId}` },
			},
		} as MelianConfig;
		harness = await openHarness(createMemoryStorage(), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const report = (line: number) => ({
			file: "src/a.ts",
			line,
			rule: "changed-return",
			severity: "P2",
			explanation: { what: `It is 2 now. ${"w".repeat(size)}`, why: "This change rewrote it.", fix: "Restore 1." },
			failureScenario: "A caller that reads it expects 1 and gets 2.",
			evidence: [{ file: "src/a.ts", line, role: "cause" }],
		});
		const answer = (messages: readonly Message[]) => {
			const done = messages.filter((message) => message.role === "toolResult").length;
			return done < count
				? fauxAssistantMessage(fauxToolCall("report_finding", report(done + 1)), { stopReason: "toolUse" })
				: fauxAssistantMessage("No findings.");
		};
		const replies = Array.from({ length: count + 3 }, () => answer);
		scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [() => fauxAssistantMessage("No findings.")] },
			{ match: "You are the contracts reviewer", replies },
		]);
		const resolved = await Changeset.resolve(repo, "main...feature");
		let thrown: unknown;
		let verdict: { status: string; notRun?: readonly { name: string; reason?: string }[] } | undefined;
		try {
			verdict = (
				await reviewChangeset({
					harness,
					changeset: resolved,
					config,
					lenses: (
						await Lens.builtins()
					)
						.filter(({ name }) => named.includes(name))
						.map((lens) =>
							Object.assign(Object.create(Object.getPrototypeOf(lens)), lens, {
								levels: { ...lens.levels, careful: { ...lens.levels.careful, budget: { findings: 8 } } },
							}),
						),
					standards: [],
					models: fake.review,
					checks: [
						{ name: "guardrails", status: "ran", findings: 0, notes: [] },
						{ name: "static.biome", status: "ran", version: "2.5.0", findings: 0, notes: [] },
						{ name: "static.tsc", status: "skipped", reason: "no TypeScript project" },
						{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
					],
					records: store,
				})
			).verdict as never;
		} catch (error) {
			thrown = error;
		}
		const root = await harness.root(context);
		const listed = await store.list(resolved.id);
		const sizes = listed.map((each) => Buffer.byteLength(canonicalJson(each)));
		const stored = Object.values((await harness.snapshot(VerdictDocument, root.id, context))?.verdicts ?? {});
		return { thrown, verdict, stored, listed, sizes };
	}

	it("past 4 MiB in one lens fails the round before the verdict commits, with no store error", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const { thrown, verdict, stored, listed } = await review(store, 1_100_000, 2, ["correctness", "contracts"]);
		expect((thrown as { code?: string } | undefined)?.code).toBeUndefined();
		expect(verdict?.status).toBe("not-reviewed");
		expect(verdict?.notRun?.map(({ name }) => name)).toContain("records");
		expect(stored.map(({ status }) => status)).toEqual(["not-reviewed"]);
		expect(listed.filter(({ kind }) => kind === "round")).toEqual([]);
	});

	async function relayed(size: number) {
		const directory = await mkdtemp(join(tmpdir(), "melian-export-budget-lens-"));
		try {
			const store = await DirectoryRecordStore.open(directory, reviewPayloads);
			const result = await review(store, size, 2, ["correctness", "contracts"]);
			await store.close();
			const tier = TierAccount.of(
				{ ...defaultConfig, tiers: twoLensTiers, checks: { allowSkip: ["static.tsc", "decisions.fast"] } } as never,
				"fast",
				{ loaded: [], selected: [] },
			);
			const relay = await RelayBatch.read(directory, {
				changeset: (await Changeset.resolve(repo, "main...feature")).id,
				revision: "",
				fork: false,
				tier,
				handedOver: [],
			}).then(
				() => "taken",
				(error: unknown) => (error instanceof RelayRefusal ? error.code : String(error)),
			);
			return { ...result, relay };
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	it("whose batch is under 8 MiB reviews and exports, with each record under 4 MiB", async () => {
		const { thrown, verdict, sizes } = await relayed(1_000_000);
		expect(thrown).toBeUndefined();
		expect(Math.max(...sizes)).toBeLessThanOrEqual(recordLimit);
		expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(relayLimits.bytes);
		expect(verdict?.notRun?.map(({ name }) => name) ?? []).not.toContain("records");
	});

	it("whose batch passes 8 MiB, each record under 4 MiB, fails the round naming the bound and the batch's size", async () => {
		const { thrown, verdict, sizes, relay } = await relayed(1_047_600);
		const total = sizes.reduce((a, b) => a + b, 0);
		// Today the review stands with findings, and the relay then refuses the batch.
		void relay;
		expect(Math.max(...sizes)).toBeLessThanOrEqual(recordLimit);
		expect(total).toBeGreaterThan(relayLimits.bytes);
		expect(thrown).toBeUndefined();
		expect(verdict?.status).toBe("not-reviewed");
		const reason = verdict?.notRun?.find(({ name }) => name === "records")?.reason ?? "";
		expect(reason).toContain("8 MiB");
		expect(reason).toContain(String(total));
	});
});
