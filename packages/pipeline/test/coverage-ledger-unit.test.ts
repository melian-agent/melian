import { chmodSync } from "node:fs";
import { join } from "node:path";
import {
	Adjudication,
	Changeset,
	defaultConfig,
	Finding,
	type MelianConfig,
	Revision,
	type StoredCoverageRecord,
} from "@melian-agent/core";
import {
	CoverageDocument,
	CoverageLedger,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerLens, LedgerRound } from "../src/coverage-ledger.ts";
import { RoundsDocument, RoundWriter } from "../src/rounds.ts";
import { commit, createRepository, gitIn, lines, removeRepository } from "./fixtures/repo.ts";

const numbered = (count: number, label: string) =>
	lines(...Array.from({ length: count }, (_, index) => `${label} ${index + 1}`));

let repo: string;
let harness: Harness;
let root: Awaited<ReturnType<Harness["root"]>>["id"];
let base: string;
let task = 100;

beforeEach(async () => {
	repo = createRepository();
	base = commit(repo, { "src/a.ts": numbered(20, "a"), "src/gone.ts": numbered(4, "g") });
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	const fake = createFakeModels();
	harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createReviewRegistry() });
	root = (await harness.root(context, { agent: { model: fake.ref() } })).id;
});

afterEach(async () => {
	await harness.close(context);
	removeRepository(repo);
});

const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
	.adjudicate()
	.toJSON();
const provenance = { kind: "range" as const, policy: "config", manifest: [], lenses: [] };

// Mints a round at the head of `changeset` for a fresh adjudication task, and decides it unless `decided` is false.
async function mint(changeset: Changeset, at: string, decided = true): Promise<number> {
	const id = ++task;
	const key = Revision.key(changeset.revision);
	await (await harness.root(context)).commit(async (tx) => {
		const rounds = new RoundWriter(tx, root);
		await rounds.mint(key, id, at);
		if (decided) await rounds.record(key, id, verdict, provenance as never);
	}, context);
	return id;
}

function round(
	changeset: Changeset,
	adjudication: number,
	overrides: Partial<LedgerRound> = {},
): LedgerRound & { adjudication: number } {
	const lens: LedgerLens = {
		name: "correctness",
		version: "1",
		covers: changeset.revision.paths(),
		required: {},
		record: { name: "lens.correctness", status: "ran", level: "careful" },
		level: "careful",
		delivered: {
			hunks: Object.fromEntries(
				changeset.revision.files.map((file) => [file.path, file.hunks.map((hunk) => hunk.index)]),
			),
			fields: {},
			omitted: [],
		},
	};
	return {
		changeset,
		config: defaultConfig,
		tier: "full",
		leave: "none",
		lenses: [lens],
		checks: [{ name: "guardrails", status: "ran" }],
		manifest: ["guardrails", "lens.correctness"],
		allowSkip: [],
		nonce: "n".repeat(24),
		adjudication,
		findings: [],
		tools: {},
		...overrides,
	};
}

async function record(id: string): Promise<StoredCoverageRecord> {
	return (await harness.snapshot(CoverageDocument, root, context))!.records[id]!;
}

const ledger = () => new CoverageLedger(harness, root);

// Computes a round's record and writes it for the adjudication task that decided it.
async function ledgerWrite({ adjudication, ...rest }: LedgerRound & { adjudication: number }) {
	return ledger().write(await ledger().compute(rest, context), adjudication, context);
}
const head = async () => Changeset.resolve(repo, `${base}..feature`);

describe("CoverageLedger.write", () => {
	it("writes nothing for a task no round holds, and keeps a round's first record", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const changeset = await head();
		expect(await ledgerWrite(round(changeset, 9999))).toBeUndefined();
		expect((await harness.snapshot(CoverageDocument, root, context))?.records ?? {}).toEqual({});
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		expect(await ledgerWrite(round(changeset, adjudication))).toBe("r1");
		const first = await record("r1");
		expect(await ledgerWrite(round(changeset, adjudication, { tier: "other" }))).toBe("r1");
		expect(await record("r1")).toEqual(first);
		expect((await harness.snapshot(RoundsDocument, root, context))!.items.r1).toMatchObject({
			scope: { kind: "diff" },
			coverage: "r1",
		});
	});

	it("fingerprints the configuration, the policy source and the tool pins, whatever the order of their keys", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const changeset = await head();
		const fingerprint = async (overrides: Partial<LedgerRound>) => {
			const adjudication = await mint(changeset, `2026-10-25T00:00:${String(task).slice(-2)}.000Z`);
			const id = (await ledgerWrite(round(changeset, adjudication, overrides)))!;
			return (await record(id)).policy;
		};
		const plain = await fingerprint({ tools: { a: 1, b: [1, 2] } });
		expect(await fingerprint({ tools: { b: [1, 2], a: 1 } })).toBe(plain);
		expect(await fingerprint({ tools: { b: [1, 2], a: 1, c: undefined } as unknown })).toBe(plain);
		expect(await fingerprint({ tools: { a: 1, b: [2, 1] } })).not.toBe(plain);
		expect(await fingerprint({ tools: { a: 1, b: { 0: 1, 1: 2 } } })).not.toBe(plain);
		expect(await fingerprint({ tools: { a: 1, b: [1, 2], c: null } })).not.toBe(plain);
		expect(await fingerprint({ tools: { a: 1, b: [1, 2] }, policy: { kind: "worktree" } })).not.toBe(plain);
		const config: MelianConfig = { ...defaultConfig, review: { delta: { maxLines: 7 } } };
		expect(await fingerprint({ tools: { a: 1, b: [1, 2] }, config })).not.toBe(plain);
		expect(plain).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("the round a record carries from", () => {
	async function decidedAt(at: string, overrides: Partial<LedgerRound> = {}, decided = true) {
		const changeset = await head();
		const adjudication = await mint(changeset, at, decided);
		return ledgerWrite(round(changeset, adjudication, overrides));
	}

	it("is the last decided round by mint time and then by round number", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		expect(await decidedAt("2026-10-25T00:00:03.000Z")).toBe("r1");
		expect(await decidedAt("2026-10-25T00:00:01.000Z")).toBe("r2");
		expect(await decidedAt("2026-10-25T00:00:02.000Z")).toBe("r3");
		expect((await record("r1")).carriedFrom).toBeUndefined();
		expect((await record("r2")).carriedFrom).toBe("r1");
		// The last decided round by mint time, r1, stands, though r3 was minted later at an earlier time.
		expect((await record("r3")).carriedFrom).toBe("r1");
		expect(await decidedAt("2026-10-25T00:00:03.000Z")).toBe("r4");
		expect((await record("r4")).carriedFrom).toBe("r1");
		expect(await decidedAt("2026-10-25T00:00:09.000Z")).toBe("r5");
		expect((await record("r5")).carriedFrom).toBe("r4");
	});

	it("skips a round that recorded nothing", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		expect(await decidedAt("2026-10-25T00:00:01.000Z")).toBe("r1");
		const changeset = await head();
		await mint(changeset, "2026-10-25T00:00:02.000Z");
		expect(await decidedAt("2026-10-25T00:00:03.000Z")).toBe("r3");
		expect((await record("r3")).carriedFrom).toBe("r1");
	});
});

describe("what a lens's own run delivered", () => {
	it("counts the rendered hunks' lines on each side, and a pure deletion's on the base alone", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "") }, ["src/gone.ts"]);
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		await ledgerWrite(round(changeset, adjudication));
		const own = (await record("r1")).checks["lens.correctness"]!.covered[0]!;
		expect(own.head).toEqual({ "src/a.ts": [[3, 3]] });
		expect(own.base).toEqual({
			"src/a.ts": [
				[3, 3],
				[9, 9],
			],
			"src/gone.ts": [[1, 4]],
		});
	});

	it("counts only the hunks the prompt rendered, and names an omitted file's lines as owed", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "A 9\n") });
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		const lens: LedgerLens = {
			...round(changeset, adjudication).lenses[0]!,
			delivered: { hunks: {}, fields: {}, omitted: ["src/a.ts", "src/missing.ts"] },
		};
		await ledgerWrite(round(changeset, adjudication, { lenses: [lens] }));
		const coverage = (await record("r1")).checks["lens.correctness"]!;
		expect(coverage.covered[0]!.head).toEqual({});
		expect(coverage.omitted).toEqual({
			head: {
				"src/a.ts": [
					[3, 3],
					[9, 9],
				],
			},
			base: {
				"src/a.ts": [
					[3, 3],
					[9, 9],
				],
			},
			units: {},
		});
	});

	it("leaves a file with no lines out of a check's needs", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		await ledgerWrite(round(changeset, adjudication));
		expect(Object.keys((await record("r1")).checks["lens.correctness"]!.needs.head)).toEqual(["src/a.ts"]);
	});

	it("marks only a melian/injection-attempt finding's file as injected", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		const finding = (rule: string, file: string) =>
			Finding.create({
				rule,
				message: "m",
				file,
				startLine: 3,
				snippet: "A 3",
				occurrence: 0,
				cause: "introduced",
				severity: "P1",
				explanation: { what: "w", whyHere: "h", whatToDo: "t" },
				source: { check: "lens.correctness", version: "1" },
			});
		await ledgerWrite(
			round(changeset, adjudication, {
				findings: [finding("melian/injection-attempt", "src/a.ts"), finding("null-dereference", "src/gone.ts")],
			}),
		);
		expect((await record("r1")).checks["lens.correctness"]!.injected).toEqual(["src/a.ts"]);
	});
});

describe("CoverageLedger.section", () => {
	it("says a round that wrote no record covers nothing, naming the round, or the review when there is none", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const changeset = await head();
		const key = Revision.key(changeset.revision);
		expect(await ledger().section(key, context)).toEqual({
			summary: {
				complete: false,
				rounds: [],
				gaps: [
					{
						check: "review.coverage",
						file: "",
						lines: [],
						reason: "this review recorded no coverage, so it covers nothing",
					},
				],
				dismissed: [],
			},
			text: "Coverage: incomplete.\n  review.coverage: this review recorded no coverage, so it covers nothing\n",
		});
		await mint(changeset, "2026-10-25T00:00:01.000Z");
		expect((await ledger().section(key, context)).summary.gaps[0]!.reason).toBe(
			"r1 recorded no coverage, so it covers nothing",
		);
	});
});

describe("each check's entry in the record", () => {
	async function written(overrides: (changeset: Changeset, adjudication: number) => Partial<LedgerRound>) {
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		await ledgerWrite(round(changeset, adjudication, overrides(changeset, adjudication)));
		return record("r1");
	}

	it("needs the lines of the files the lens covers, a renamed file's under both paths, each side at its own level", async () => {
		gitIn(repo, "mv", "src/gone.ts", "src/kept.ts");
		commit(repo, {
			"src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n"),
			"src/kept.ts": numbered(4, "g").replace("g 2\n", "G 2\n"),
		});
		chmodSync(join(repo, "src/a.ts"), 0o755);
		commit(repo, {});
		const lens =
			(covers: string[], required: LedgerLens["required"]) => (changeset: Changeset, adjudication: number) => ({
				lenses: [{ ...round(changeset, adjudication).lenses[0]!, covers, required }],
			});
		const byOld = await written(lens(["src/gone.ts"], {}));
		expect(byOld.checks["lens.correctness"]!.needs).toEqual({
			head: { "src/kept.ts": [[2, 2]] },
			base: { "src/gone.ts": [[2, 2]] },
			units: {},
		});
		expect(byOld.checks["lens.correctness"]!.required).toEqual({
			"src/kept.ts": "careful",
			"src/gone.ts": "careful",
		});
		await harness.close(context);
		const fake = createFakeModels();
		harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createReviewRegistry() });
		root = (await harness.root(context, { agent: { model: fake.ref() } })).id;
		const sided = await written(
			lens(["src/kept.ts", "src/a.ts"], { "src/kept.ts": "skip", "src/gone.ts": "quick", "src/a.ts": "deep" }),
		);
		const coverage = sided.checks["lens.correctness"]!;
		expect(coverage.needs.head).toEqual({ "src/a.ts": [[3, 3]] });
		expect(coverage.needs.base).toEqual({ "src/a.ts": [[3, 3]], "src/gone.ts": [[2, 2]] });
		expect(Object.keys(coverage.needs.units)).toEqual(["src/a.ts"]);
		expect(coverage.required).toEqual({ "src/a.ts": "deep", "src/gone.ts": "quick" });
	});

	it("takes a base side's level from its head path when only that is set", async () => {
		gitIn(repo, "mv", "src/gone.ts", "src/kept.ts");
		commit(repo, { "src/kept.ts": numbered(4, "g").replace("g 2\n", "G 2\n") });
		const record = await written((changeset, adjudication) => ({
			lenses: [
				{
					...round(changeset, adjudication).lenses[0]!,
					covers: ["src/kept.ts"],
					required: { "src/kept.ts": "skip" },
				},
			],
		}));
		expect(record.checks["lens.correctness"]!.needs).toEqual({ head: {}, base: {}, units: {} });
	});

	it("records a lens's status, leave, reason and standards as its record says", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const record = await written((changeset, adjudication) => {
			const { record: _, level: __, ...base } = round(changeset, adjudication).lenses[0]!;
			const lenses: LedgerLens[] = [
				{
					...base,
					name: "skipped",
					level: "careful",
					record: { name: "lens.skipped", status: "skipped", reason: "triage skipped it" },
				},
				{ ...base, name: "unleaved", level: "careful", record: { name: "lens.unleaved", status: "skipped" } },
				{
					...base,
					name: "failed",
					level: "careful",
					record: { name: "lens.failed", status: "failed", reason: "no model" },
				},
				{ ...base, name: "absent", level: "careful", standards: ["AGENTS.md"] },
				{ ...base, name: "levelless", record: { name: "lens.levelless", status: "ran" } },
			];
			return { lenses, allowSkip: ["lens.skipped", "lens.failed"] };
		});
		const entry = (name: string) => {
			const { needs: _, required: __, ...rest } = record.checks[`lens.${name}`]!;
			return rest;
		};
		expect(entry("skipped")).toEqual({
			kind: "lens",
			version: "1",
			status: "skipped",
			leave: true,
			reason: "triage skipped it",
			covered: [],
		});
		expect(entry("unleaved")).toEqual({ kind: "lens", version: "1", status: "skipped", covered: [] });
		expect(entry("failed")).toEqual({
			kind: "lens",
			version: "1",
			status: "failed",
			reason: "no model",
			covered: [],
		});
		expect(entry("absent")).toEqual({
			kind: "lens",
			version: "1",
			standards: ["AGENTS.md"],
			status: "absent",
			covered: [],
		});
		expect(entry("levelless")).toEqual({ kind: "lens", version: "1", status: "ran", covered: [] });
	});

	it("covers the whole range for a check that ran or skipped with leave, and leaves out a check the manifest does not name", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const record = await written(() => ({
			checks: [
				{ name: "guardrails", status: "ran" },
				{ name: "static.tsc", status: "skipped", reason: "no TypeScript" },
				{ name: "static.biome", status: "skipped", reason: "off" },
				{ name: "static.enola", status: "ran" },
			],
			manifest: ["guardrails", "static.tsc", "static.biome", "lens.correctness"],
			allowSkip: ["static.tsc"],
		}));
		const whole = { head: { "src/a.ts": [[3, 3]] }, base: { "src/a.ts": [[3, 3]] }, units: {} };
		expect(record.checks.guardrails).toEqual({
			kind: "range",
			status: "ran",
			required: {},
			needs: whole,
			covered: [whole],
		});
		expect(record.checks["static.tsc"]).toEqual({
			kind: "range",
			status: "skipped",
			leave: true,
			reason: "no TypeScript",
			required: {},
			needs: whole,
			covered: [whole],
		});
		expect(record.checks["static.biome"]).toMatchObject({ status: "skipped", reason: "off", covered: [] });
		expect(record.checks["static.biome"]!.leave).toBeUndefined();
		expect(record.checks["static.enola"]).toBeUndefined();
	});

	it("records no omitted lines and no injected file when there are none", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const record = await written(() => ({}));
		expect(Object.keys(record.checks["lens.correctness"]!).sort()).toEqual([
			"covered",
			"kind",
			"needs",
			"required",
			"status",
			"version",
		]);
	});
});
