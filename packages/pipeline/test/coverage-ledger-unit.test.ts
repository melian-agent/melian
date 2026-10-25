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
	type UnitField,
} from "@melian-agent/core";
import {
	CoverageDocument,
	CoverageLedger,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	dismissFinding,
	type Harness,
	openHarness,
	upsertFinding,
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
let steps = 0;
// Moves the head by one line, so a round about to run sits at a head no decided round reviewed, and carries from it.
const stepped = async () => {
	commit(repo, { "src/step.ts": lines(`step ${++steps}`) });
	return head();
};

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
		const changeset = await stepped();
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

	it("owes only the hunks of an omitted file the prompt did not render", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "A 9\n") });
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		const [first] = changeset.revision.files.find((file) => file.path === "src/a.ts")!.hunks;
		const lens: LedgerLens = {
			...round(changeset, adjudication).lenses[0]!,
			delivered: { hunks: { "src/a.ts": [first!.index] }, fields: {}, omitted: ["src/a.ts"] },
		};
		await ledgerWrite(round(changeset, adjudication, { lenses: [lens] }));
		expect((await record("r1")).checks["lens.correctness"]!.omitted).toEqual({
			head: { "src/a.ts": [[9, 9]] },
			base: { "src/a.ts": [[9, 9]] },
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

describe("the ledger at its edges", () => {
	const changed = () => numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "A 9\n");
	const writeAt = async (changeset: Changeset, at: string, overrides: Partial<LedgerRound> = {}) =>
		ledgerWrite(round(changeset, await mint(changeset, at), overrides));

	it("stores its records under one durable kind, kept at their latest value and forked as they stand", () => {
		expect(CoverageDocument.definition).toMatchObject({
			kind: "melian.coverage",
			version: 1,
			history: "latest",
			fork: "current",
		});
	});

	it("tells apart tool pins and policy sources that differ only where a separator would sit", async () => {
		commit(repo, { "src/a.ts": changed() });
		const changeset = await head();
		const policy = async (overrides: Partial<LedgerRound>) =>
			(await record((await writeAt(changeset, `2026-10-25T00:00:${String(task).slice(-2)}.000Z`, overrides))!))
				.policy;
		expect(await policy({ tools: { b: [1, 23] } })).not.toBe(await policy({ tools: { b: [12, 3] } }));
		expect(await policy({ policy: { kind: "revision", commit: "a".repeat(40) } })).not.toBe(
			await policy({ policy: { kind: "revision", commit: "b".repeat(40) } }),
		);
	});

	it("counts only the hunks the prompt rendered, of a file with several", async () => {
		commit(repo, { "src/a.ts": changed() });
		const changeset = await head();
		const [first] = changeset.revision.files.find((file) => file.path === "src/a.ts")!.hunks;
		const lens = (adjudication: number): LedgerLens => ({
			...round(changeset, adjudication).lenses[0]!,
			delivered: { hunks: { "src/a.ts": [first!.index], "src/missing.ts": [0] }, fields: {}, omitted: [] },
		});
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		await ledgerWrite(round(changeset, adjudication, { lenses: [lens(adjudication)] }));
		expect((await record("r1")).checks["lens.correctness"]!.covered[0]).toEqual({
			level: "careful",
			head: { "src/a.ts": [[3, 3]] },
			base: { "src/a.ts": [[3, 3]] },
			units: {},
		});
	});

	it("gives a pure insertion no base lines to need or cover", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "a 3\nnew\n") });
		const changeset = await head();
		await writeAt(changeset, "2026-10-25T00:00:01.000Z");
		const coverage = (await record("r1")).checks["lens.correctness"]!;
		expect(coverage.needs).toEqual({ head: { "src/a.ts": [[4, 4]] }, base: {}, units: {} });
		expect(coverage.covered[0]).toEqual({ level: "careful", head: { "src/a.ts": [[4, 4]] }, base: {}, units: {} });
	});

	it("takes, at the head of the last decided round, what that round carried from", async () => {
		commit(repo, { "src/a.ts": changed() });
		const changeset = await head();
		const first = await mint(changeset, "2026-10-25T00:00:05.000Z");
		const second = await mint(changeset, "2026-10-25T00:00:05.000Z");
		expect(await ledgerWrite(round(changeset, second))).toBe("r2");
		expect((await record("r2")).carriedFrom).toBeUndefined();
		expect(await ledgerWrite(round(changeset, first))).toBe("r1");
		// The last decided round, r2, reviewed this head too, so r1 carries from what r2 carried from: nothing.
		expect((await record("r1")).carriedFrom).toBeUndefined();
	});

	it("carries a round at a decided round's head from the round that one carried from", async () => {
		commit(repo, { "src/a.ts": changed() });
		await writeAt(await stepped(), "2026-10-25T00:00:01.000Z");
		const second = await stepped();
		await writeAt(second, "2026-10-25T00:00:02.000Z");
		expect((await record("r2")).carriedFrom).toBe("r1");
		await writeAt(second, "2026-10-25T00:00:03.000Z");
		expect((await record("r3")).carriedFrom).toBe("r1");
	});

	it("carries from the highest-numbered of rounds minted at one time", async () => {
		commit(repo, { "src/a.ts": changed() });
		const changeset = await head();
		for (let index = 0; index < 4; index++) await writeAt(await stepped(), "2026-10-25T00:00:05.000Z");
		expect((await record("r4")).carriedFrom).toBe("r3");
	});

	it("carries from no undecided round, even one holding a record", async () => {
		commit(repo, { "src/a.ts": changed() });
		const changeset = await head();
		await writeAt(changeset, "2026-10-25T00:00:01.000Z");
		await mint(changeset, "2026-10-25T00:00:02.000Z", false);
		await (await harness.root(context)).commit(async (tx) => {
			const document = await tx.doc(CoverageDocument, root);
			document.records.r2 = {
				...(JSON.parse(JSON.stringify(document.records.r1)) as StoredCoverageRecord),
				round: "r2",
			};
		}, context);
		await writeAt(await stepped(), "2026-10-25T00:00:03.000Z");
		expect((await record("r3")).carriedFrom).toBe("r1");
	});

	it("lists injected files in code-unit order, and needs a file unit's fields for a whole-range check", async () => {
		commit(repo, { "src/a.ts": changed() });
		chmodSync(join(repo, "src/gone.ts"), 0o755);
		commit(repo, {});
		const changeset = await head();
		const finding = (file: string) =>
			Finding.create({
				rule: "melian/injection-attempt",
				message: "m",
				file,
				startLine: 1,
				snippet: "x",
				occurrence: 0,
				cause: "introduced",
				severity: "P1",
				explanation: { what: "w", whyHere: "h", whatToDo: "t" },
				source: { check: "lens.correctness", version: "1" },
			});
		await writeAt(changeset, "2026-10-25T00:00:01.000Z", { findings: [finding("src/z.ts"), finding("src/a.ts")] });
		const stored = await record("r1");
		expect(stored.checks["lens.correctness"]!.injected).toEqual(["src/a.ts", "src/z.ts"]);
		expect(stored.checks.guardrails!.needs.units).toEqual({
			"src/gone.ts": ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary"],
		});
	});

	it("needs nothing of a renamed file a lens covers under neither path", async () => {
		gitIn(repo, "mv", "src/gone.ts", "src/kept.ts");
		commit(repo, { "src/kept.ts": numbered(4, "g").replace("g 2\n", "G 2\n") });
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		const lens = { ...round(changeset, adjudication).lenses[0]!, covers: ["src/a.ts"] };
		await ledgerWrite(round(changeset, adjudication, { lenses: [lens] }));
		expect((await record("r1")).checks["lens.correctness"]!.needs).toEqual({ head: {}, base: {}, units: {} });
	});

	it("owes only the omitted file's lines when the diff holds several", async () => {
		commit(repo, { "src/a.ts": changed(), "src/gone.ts": numbered(4, "g").replace("g 2\n", "G 2\n") });
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		const lens: LedgerLens = {
			...round(changeset, adjudication).lenses[0]!,
			delivered: { hunks: {}, fields: {}, omitted: ["src/gone.ts"] },
		};
		await ledgerWrite(round(changeset, adjudication, { lenses: [lens] }));
		expect((await record("r1")).checks["lens.correctness"]!.omitted).toEqual({
			head: { "src/gone.ts": [[2, 2]] },
			base: { "src/gone.ts": [[2, 2]] },
			units: {},
		});
	});

	it("records a lens that left no record as absent, and no leave for a check that ran", async () => {
		commit(repo, { "src/a.ts": changed() });
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		const { record: _, ...lens } = round(changeset, adjudication).lenses[0]!;
		await ledgerWrite(
			round(changeset, adjudication, { lenses: [lens], allowSkip: ["guardrails", "lens.correctness"] }),
		);
		const stored = await record("r1");
		expect(stored.checks["lens.correctness"]!.status).toBe("absent");
		expect(stored.checks["lens.correctness"]!.leave).toBeUndefined();
		expect(stored.checks.guardrails).toMatchObject({ status: "ran" });
		expect(stored.checks.guardrails!.leave).toBeUndefined();
		const moved = await stepped();
		const unrecorded = await mint(moved, "2026-10-25T00:00:02.000Z");
		await ledgerWrite(round(moved, unrecorded, { manifest: ["guardrails", "static.tsc", "lens.correctness"] }));
		expect((await record("r2")).checks["static.tsc"]).toMatchObject({ status: "absent", covered: [] });
	});

	it("carries nothing for a lens the earlier round ran and this one does not", async () => {
		commit(repo, { "src/a.ts": changed() });
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		const correctness = round(changeset, adjudication).lenses[0]!;
		await ledgerWrite(
			round(changeset, adjudication, {
				lenses: [
					correctness,
					{ ...correctness, name: "design", record: { ...correctness.record!, name: "lens.design" } },
				],
				manifest: ["guardrails", "lens.correctness", "lens.design"],
			}),
		);
		expect(await writeAt(await stepped(), "2026-10-25T00:00:02.000Z")).toBe("r2");
		const stored = await record("r2");
		expect(stored.carriedFrom).toBe("r1");
		expect(stored.checks["lens.design"]).toBeUndefined();
	});

	it("counts a lens's prompt alone when its conversation is gone", async () => {
		commit(repo, { "src/a.ts": changed() });
		const changeset = await head();
		const adjudication = await mint(changeset, "2026-10-25T00:00:01.000Z");
		const lens = { ...round(changeset, adjudication).lenses[0]!, conversation: "c-missing" as never };
		await ledgerWrite(round(changeset, adjudication, { lenses: [lens] }));
		expect((await record("r1")).checks["lens.correctness"]!.covered[0]!.head).toEqual({
			"src/a.ts": [
				[3, 3],
				[9, 9],
			],
		});
	});
});

describe("what voids the carry", () => {
	const changed = () => numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "A 9\n");
	let at = 0;
	const next = async (overrides: Partial<LedgerRound> = {}) => {
		const changeset = await stepped();
		const adjudication = await mint(changeset, `2026-10-25T00:01:${String(++at).padStart(2, "0")}.000Z`);
		const id = (await ledgerWrite(round(changeset, adjudication, overrides)))!;
		return record(id);
	};
	const edit = async (id: string, change: (stored: StoredCoverageRecord) => void) =>
		(await harness.root(context)).commit(async (tx) => {
			change((await tx.doc(CoverageDocument, root)).records[id]!);
		}, context);

	beforeEach(() => {
		commit(repo, { "src/a.ts": changed() });
	});

	it.each([
		[
			{ name: "melian.coverage", algorithm: 0 },
			"r1 was recorded by coverage algorithm 0, so nothing carries from it",
		],
		[{ name: "other", algorithm: 1 }, "r1 was recorded by coverage algorithm 1, so nothing carries from it"],
	])("carries nothing from a record another producer wrote: %o", async (producer, reason) => {
		await next();
		await edit("r1", (stored) => {
			stored.producer = producer;
		});
		const second = await next();
		expect(second.voids).toEqual([{ reason }]);
		expect(second.checks["lens.correctness"]!.covered).toHaveLength(1);
	});

	it("carries nothing from a refused round, nor across a tier or policy change, and says why", async () => {
		await next({ refused: "coverage is not recorded for a fork's head" });
		expect((await next()).voids).toEqual([
			{ reason: "r1 recorded no coverage: coverage is not recorded for a fork's head" },
		]);
		expect((await next({ tier: "fast" })).voids).toEqual([{ reason: "the tier changed since r2" }]);
		expect((await next({ tier: "fast", tools: { pinned: 1 } })).voids).toEqual([
			{ reason: "the policy changed since r3" },
		]);
		const carried = await next({ tier: "fast", tools: { pinned: 1 } });
		expect(carried.voids).toEqual([]);
		expect(carried.checks["lens.correctness"]!.covered.map((segment) => segment.round)).toEqual([undefined, "r4"]);
	});

	it("voids the lenses a changed standards file reaches: by name for a lens with none recorded, by path otherwise", async () => {
		const lens = (changeset: Changeset, adjudication: number, name: string, standards?: string[]): LedgerLens => {
			const base = round(changeset, adjudication).lenses[0]!;
			return {
				...base,
				name,
				record: { ...base.record!, name: `lens.${name}` },
				...(standards === undefined ? {} : { standards }),
			};
		};
		const three = async () => {
			const changeset = await head();
			const adjudication = await mint(changeset, `2026-10-25T00:01:${String(++at).padStart(2, "0")}.000Z`);
			const id = (await ledgerWrite(
				round(changeset, adjudication, {
					lenses: [
						lens(changeset, adjudication, "correctness"),
						lens(changeset, adjudication, "contracts", []),
						lens(changeset, adjudication, "design", ["docs/guide.md"]),
					],
					manifest: ["guardrails", "lens.correctness", "lens.contracts", "lens.design"],
				}),
			))!;
			return record(id);
		};
		commit(repo, { "docs/guide.md": lines("guide") });
		await three();
		commit(repo, { "pkg/sub/Agents.MD": lines("be careful") });
		expect((await three()).voids).toEqual([
			{ reason: "pkg/sub/Agents.MD changed since r1, a standard lens.correctness reads", lens: "correctness" },
			{ reason: "pkg/sub/Agents.MD changed since r1, a standard lens.contracts reads", lens: "contracts" },
		]);
		commit(repo, { "CLAUDE.md": lines("@AGENTS.md") });
		expect((await three()).voids.map((each) => each.lens)).toEqual(["correctness", "contracts"]);
		commit(repo, { "docs/guide.md": lines("guide, edited") });
		expect((await three()).voids).toEqual([
			{ reason: "docs/guide.md changed since r3, a standard lens.design reads", lens: "design" },
		]);
	});

	it("lets a whole-range check that failed this round cover nothing, whatever an earlier round covered", async () => {
		await next();
		const failed = await next({ checks: [{ name: "guardrails", status: "failed", reason: "crashed" }] });
		expect(failed.checks.guardrails!.covered).toEqual([]);
	});
});

describe("a finding the earlier round raised", () => {
	const finding = (line: number, rule: string, evidence?: Parameters<typeof Finding.create>[0]["evidence"]) =>
		Finding.create({
			rule,
			message: `m ${rule}`,
			file: "src/a.ts",
			startLine: line,
			snippet: `A ${line}`,
			occurrence: 0,
			cause: "introduced",
			severity: "P1",
			explanation: { what: "w", whyHere: "h", whatToDo: "t" },
			source: { check: "lens.correctness", version: "1" },
			...(evidence === undefined ? {} : { evidence }),
		});

	it("takes its lines and evidence out of the carried coverage until it is sighted again or dismissed", async () => {
		const changed = numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "A 9\n").replace("a 15\n", "A 15\n");
		commit(repo, { "src/a.ts": changed });
		const first = await head();
		const lost = finding(3, "null-dereference", [
			{ file: "src/a.ts", startLine: 9, role: "cause", revision: "base", snippet: "a 9" },
			{ file: "src/a.ts", startLine: 14, endLine: 15, role: "context", revision: "head", snippet: "a 14" },
			{ file: "src/0.ts", startLine: 1, role: "context", revision: "base", snippet: "z" },
		]);
		const dismissed = finding(9, "wrong-result");
		const kept = finding(9, "unhandled-error");
		const key = Revision.key(first.revision);
		await (await harness.root(context)).commit(async (tx) => {
			for (const each of [lost, dismissed, kept]) await upsertFinding(tx, root, each, key);
			await dismissFinding(tx, root, dismissed.id, { by: "Ada", reason: "fine", at: "2026-10-25T00:00:00.000Z" });
		}, context);
		await ledgerWrite(round(first, await mint(first, "2026-10-25T00:00:01.000Z")));
		commit(repo, { "src/gone.ts": numbered(4, "g").replace("g 2\n", "G 2\n") });
		const second = await head();
		await ledgerWrite(round(second, await mint(second, "2026-10-25T00:00:02.000Z"), { findings: [kept] }));
		const stored = await record("r2");
		expect(stored.voids).toEqual([
			{ reason: "a finding r1 raised has no sighting at this head", files: ["src/0.ts", "src/a.ts"] },
		]);
		const carried = stored.checks["lens.correctness"]!.covered.filter((segment) => segment.round === "r1");
		expect(carried).toEqual([
			{
				round: "r1",
				level: "careful",
				head: { "src/a.ts": [[9, 9]] },
				base: {
					"src/a.ts": [
						[3, 3],
						[15, 15],
					],
				},
				units: {},
			},
		]);
	});
});

describe("the coverage a round carries", () => {
	let at = 0;
	const next = async (
		overrides: (changeset: Changeset, adjudication: number) => Partial<LedgerRound> = () => ({}),
	) => {
		const changeset = await head();
		const adjudication = await mint(changeset, `2026-10-25T00:02:${String(++at).padStart(2, "0")}.000Z`);
		return record((await ledgerWrite(round(changeset, adjudication, overrides(changeset, adjudication))))!);
	};
	const carried = (stored: StoredCoverageRecord) =>
		stored.checks["lens.correctness"]!.covered.filter((segment) => segment.round !== undefined);

	it("drops a line the move changed, and a finding's location there, without voiding the file", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "A 9\n") });
		const first = await head();
		const lost = Finding.create({
			rule: "null-dereference",
			message: "m",
			file: "src/a.ts",
			startLine: 3,
			snippet: "A 3",
			occurrence: 0,
			cause: "introduced",
			severity: "P1",
			explanation: { what: "w", whyHere: "h", whatToDo: "t" },
			source: { check: "lens.correctness", version: "1" },
		});
		await (await harness.root(context)).commit(
			(tx) => upsertFinding(tx, root, lost, Revision.key(first.revision)),
			context,
		);
		await next();
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "B 3\n").replace("a 9\n", "A 9\n") });
		const second = await next((_, __) => ({
			lenses: [{ ...round(first, 0).lenses[0]!, delivered: { hunks: {}, fields: {}, omitted: [] } }],
		}));
		expect(second.voids).toEqual([]);
		expect(carried(second)).toEqual([
			{
				round: "r1",
				level: "careful",
				head: { "src/a.ts": [[9, 9]] },
				base: {
					"src/a.ts": [
						[3, 3],
						[9, 9],
					],
				},
				units: {},
			},
		]);
	});

	it("carries a file unit the move left alone, and none the move lists or an injection attempt sits in", async () => {
		chmodSync(join(repo, "src/gone.ts"), 0o755);
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "A 9\n") });
		const fields: UnitField[] = ["status", "path", "oldMode", "newMode", "oldKind", "newKind", "binary"];
		const delivering = (changeset: Changeset, adjudication: number) => ({
			lenses: [
				{
					...round(changeset, adjudication).lenses[0]!,
					delivered: {
						hunks: Object.fromEntries(
							changeset.revision.files.map((file) => [file.path, file.hunks.map((hunk) => hunk.index)]),
						),
						fields: { "src/gone.ts": fields },
						omitted: [],
					},
				},
			],
		});
		await next(delivering);
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "B 9\n") });
		expect(carried(await next(delivering))[0]!.units).toEqual({ "src/gone.ts": fields });
		commit(repo, { "src/gone.ts": numbered(4, "g").replace("g 2\n", "G 2\n") });
		const listed = await next();
		expect(listed.checks["lens.correctness"]!.covered.find((segment) => segment.round === "r2")!.units).toEqual({});
	});
});
