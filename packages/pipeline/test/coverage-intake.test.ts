import {
	Adjudication,
	Changeset,
	coverageProducer,
	defaultConfig,
	Revision,
	type StoredCheckCoverage,
	type StoredCoverageRecord,
} from "@melian-agent/core";
import {
	CoverageLedger,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	GapDismissalError,
	type Harness,
	openHarness,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoverageIntake, GapDismissalDocument, type LedgerLens, type LedgerRound } from "../src/coverage-ledger.ts";
import { RoundWriter } from "../src/rounds.ts";
import { commit, createRepository, gitIn, lines, removeRepository } from "./fixtures/repo.ts";

const numbered = (count: number, label: string) =>
	lines(...Array.from({ length: count }, (_, index) => `${label} ${index + 1}`));

const lens = (overrides: Partial<StoredCheckCoverage> = {}): StoredCheckCoverage => ({
	kind: "lens",
	version: "1",
	status: "ran",
	required: {},
	needs: { head: { "a.ts": [[1, 2]] }, base: { "a.ts": [[1, 2]] }, units: { "bin/run": ["status", "oldMode"] } },
	covered: [],
	...overrides,
});
const stored = (checks: Record<string, StoredCheckCoverage>): StoredCoverageRecord => ({
	producer: { ...coverageProducer },
	round: "",
	base: "a".repeat(40),
	head: "b".repeat(40),
	tier: "full",
	policy: "p",
	source: "revision",
	melian: "0.0.0",
	leave: "writer",
	voids: [],
	units: { "bin/run": "mode" },
	checks,
});

describe("CoverageIntake", () => {
	it("carries only when a lens holds coverage from an earlier round", () => {
		const own = { level: "careful" as const, head: {}, base: {}, units: {} };
		expect(new CoverageIntake(stored({ "lens.a": lens({ covered: [own] }) }), undefined).carries()).toBe(false);
		const range: StoredCheckCoverage = { ...lens(), kind: "range", covered: [{ ...own, round: "r1" }] };
		expect(
			new CoverageIntake(stored({ "lens.a": lens({ covered: [own] }), guardrails: range }), undefined).carries(),
		).toBe(false);
		const carried = lens({ covered: [own, { ...own, round: "r1" }] });
		expect(new CoverageIntake(stored({ "lens.a": lens(), "lens.b": carried }), undefined).carries()).toBe(true);
	});

	it("names what each lens has left on each side and in each unit, and nothing of another lens", () => {
		const half = lens({
			covered: [{ level: "careful", head: { "a.ts": [[1, 1]] }, base: {}, units: { "bin/run": ["status"] } }],
		});
		const intake = new CoverageIntake(stored({ "lens.a": half, "lens.b": lens({ covered: [] }) }), undefined);
		expect(intake.delta("a")).toEqual({
			head: { "a.ts": [[2, 2]] },
			base: { "a.ts": [[1, 2]] },
			units: { "bin/run": ["oldMode"] },
		});
		expect(intake.empty("a")).toBe(false);
		expect(intake.delta("c")).toEqual({ head: {}, base: {}, units: {} });
		expect(intake.empty("c")).toBe(true);
		const even = lens({
			needs: { head: { "a.ts": [[1, 1]] }, base: { "a.ts": [[1, 1]] }, units: {} },
			covered: [],
		});
		expect(new CoverageIntake(stored({ "lens.a": even }), undefined).empty("a")).toBe(false);
		const lineAndUnit = lens({
			needs: { head: { "a.ts": [[1, 1]] }, base: {}, units: { "bin/run": ["status"] } },
			covered: [],
		});
		expect(new CoverageIntake(stored({ "lens.a": lineAndUnit }), undefined).empty("a")).toBe(false);
		const unitOnly = lens({ needs: { head: {}, base: {}, units: { "bin/run": ["status"] } }, covered: [] });
		expect(new CoverageIntake(stored({ "lens.a": unitOnly }), undefined).empty("a")).toBe(false);
	});

	it("takes a lens's level from the earlier round's own run, not from what it carried", () => {
		const prior = stored({
			"lens.a": lens({
				covered: [
					{ round: "r0", level: "deep", head: {}, base: {}, units: {} },
					{ level: "quick", head: {}, base: {}, units: {} },
				],
			}),
		});
		const intake = new CoverageIntake(stored({}), prior);
		expect(intake.level("a")).toBe("quick");
		expect(intake.level("b")).toBeUndefined();
		expect(new CoverageIntake(stored({}), undefined).level("a")).toBeUndefined();
	});
});

describe("gap dismissals", () => {
	let repo: string;
	let harness: Harness;
	let root: Awaited<ReturnType<Harness["root"]>>["id"];
	let base: string;
	let task = 100;
	const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
		.adjudicate()
		.toJSON();

	beforeEach(async () => {
		repo = createRepository();
		base = commit(repo, { "src/a.ts": numbered(20, "a") });
		gitIn(repo, "checkout", "--quiet", "-b", "feature");
		const fake = createFakeModels();
		harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createReviewRegistry() });
		root = (await harness.root(context, { agent: { model: fake.ref() } })).id;
	});

	afterEach(async () => {
		await harness.close(context);
		removeRepository(repo);
	});

	// Writes a decided round at the head whose one lens delivered nothing, so every changed line is a gap.
	async function decided(): Promise<{ changeset: Changeset; key: string }> {
		const changeset = await Changeset.resolve(repo, `${base}..feature`);
		const key = Revision.key(changeset.revision);
		const adjudication = ++task;
		await (await harness.root(context)).commit(async (tx) => {
			const rounds = new RoundWriter(tx, root);
			await rounds.mint(key, adjudication, `2026-10-25T00:00:${String(task).slice(-2)}.000Z`);
			await rounds.record(key, adjudication, verdict, {
				kind: "range",
				policy: "c",
				manifest: [],
				lenses: [],
			} as never);
		}, context);
		const silent: LedgerLens = {
			name: "correctness",
			version: "1",
			covers: changeset.revision.paths(),
			required: {},
			record: { name: "lens.correctness", status: "ran", level: "careful" },
			level: "careful",
			delivered: { hunks: {}, fields: {}, omitted: [] },
		};
		const round: LedgerRound = {
			changeset,
			config: defaultConfig,
			tier: "full",
			leave: "none",
			lenses: [silent],
			checks: [],
			manifest: ["lens.correctness"],
			allowSkip: [],
			nonce: "n".repeat(24),
			findings: [],
			tools: {},
		};
		const ledger = new CoverageLedger(harness, root);
		await ledger.write(await ledger.compute(round, context), adjudication, context);
		return { changeset, key };
	}
	const ledger = () => new CoverageLedger(harness, root);
	const dismissal = (lines: [number, number][], overrides: Record<string, unknown> = {}) => ({
		check: "lens.correctness",
		file: "src/a.ts",
		lines,
		reason: "read",
		by: "Ada",
		at: "t",
		...overrides,
	});
	const items = async () => (await harness.snapshot(GapDismissalDocument, root, context))?.items ?? {};

	it("stores dismissals under one durable kind, and refuses with an error that has a code", async () => {
		expect(GapDismissalDocument.definition).toMatchObject({
			kind: "melian.coverage-dismissals",
			version: 1,
			history: "latest",
			fork: "current",
		});
		const error = new GapDismissalError("x");
		expect(error).toMatchObject({ code: "notAGap", name: "GapDismissalError", message: "x" });
	});

	it("refuses a dismissal no gap answers: before any round, another check, no lines, or lines past the gap", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 4\n", "A 4\n") });
		const changeset = await Changeset.resolve(repo, `${base}..feature`);
		const early = Revision.key(changeset.revision);
		await expect(ledger().dismiss(early, dismissal([[3, 3]]), context)).rejects.toBeInstanceOf(GapDismissalError);
		const { key } = await decided();
		for (const refused of [
			dismissal([[3, 3]], { check: "lens.design" }),
			dismissal([]),
			dismissal([[3, 5]]),
			dismissal([[3, 3]], { file: "src/b.ts" }),
		])
			await expect(ledger().dismiss(key, refused, context)).rejects.toThrow(
				`the review names no gap for ${refused.check} at those lines of ${refused.file}; melian findings lists its gaps`,
			);
		expect(await items()).toEqual({});
		await ledger().dismiss(key, dismissal([[3, 4]]), context);
		await ledger().dismiss(key, dismissal([[3, 4]], { revision: "base" }), context);
		expect((await items())[key]).toHaveLength(2);
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 4\n", "A 4\na 4b\n") });
		const inserted = await decided();
		await expect(
			ledger().dismiss(inserted.key, dismissal([[5, 5]], { revision: "base" }), context),
		).rejects.toBeInstanceOf(GapDismissalError);
		await ledger().dismiss(inserted.key, dismissal([[5, 5]]), context);
	});

	it("carries a dismissal to the next head when the move left its lines alone, moved, and drops one it changed", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n").replace("a 9\n", "A 9\n") });
		const first = await decided();
		await ledger().dismiss(first.key, dismissal([[3, 3]]), context);
		await ledger().dismiss(first.key, dismissal([[9, 9]]), context);
		await ledger().dismiss(first.key, dismissal([[3, 3]], { revision: "base" }), context);
		commit(repo, {
			"src/a.ts": numbered(20, "a")
				.replace("a 1\n", "a 0\na 1\n")
				.replace("a 3\n", "A 3\n")
				.replace("a 9\n", "B 9\n"),
		});
		const second = await Changeset.resolve(repo, `${base}..feature`);
		const to = Revision.key(second.revision);
		const move = Revision.from({
			base: first.changeset.revision.head,
			head: second.revision.head,
			files: (
				await Changeset.resolve(repo, {
					base: first.changeset.revision.head,
					head: second.revision.head,
					mode: "twoDot",
				})
			).revision.files,
		});
		await ledger().carryDismissals(first.key, to, move, context);
		expect((await items())[to]).toEqual([
			{ ...dismissal([[4, 4]]) },
			{ ...dismissal([[3, 3]], { revision: "base" }) },
		]);
		await ledger().carryDismissals(first.key, to, move, context);
		expect((await items())[to]).toHaveLength(2);
		expect((await items())[first.key]).toHaveLength(3);
		const nothing = Revision.key({ base, head: "e".repeat(40) });
		await ledger().carryDismissals(nothing, to, move, context);
		expect((await items())[to]).toHaveLength(2);
		const unseen = Revision.key({ base, head: "f".repeat(40) });
		await ledger().carryDismissals(nothing, unseen, move, context);
		expect(Object.hasOwn(await items(), unseen)).toBe(false);
		gitIn(repo, "mv", "src/a.ts", "src/moved.ts");
		commit(repo, {});
		const third = await Changeset.resolve(repo, `${base}..feature`);
		const renamed = Revision.from({
			base: second.revision.head,
			head: third.revision.head,
			files: (
				await Changeset.resolve(repo, { base: second.revision.head, head: third.revision.head, mode: "twoDot" })
			).revision.files,
		});
		const after = Revision.key(third.revision);
		await ledger().carryDismissals(to, after, renamed, context);
		expect((await items())[after]).toEqual([
			{ ...dismissal([[4, 4]], { file: "src/moved.ts" }) },
			{ ...dismissal([[3, 3]], { revision: "base" }) },
		]);
	});
});
