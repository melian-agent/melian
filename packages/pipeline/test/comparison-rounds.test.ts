import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Adjudication,
	Comparison,
	ComparisonExport,
	ComparisonSet,
	defaultConfig,
	ExternalFinding,
	Finding,
} from "@melian-agent/core";
import {
	CompareHarness,
	ComparisonReader,
	backgroundContext as context,
	createMemoryStorage,
	openSqliteStorage,
	ROOT_CONVERSATION_ID,
	RoundReader,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { ComparisonDocument } from "../src/compare.ts";
import { legacyKey, RoundsDocument, RoundWriter } from "../src/rounds.ts";

const changeset = "range-0123456789abcdef";
const revision = { base: "a".repeat(40), head: "b".repeat(40) };
const key = revisionKey(revision);
const finding = Finding.create({
	rule: "wrong",
	message: "wrong",
	file: "a.ts",
	startLine: 1,
	snippet: "wrong()",
	occurrence: 0,
	cause: "introduced",
	severity: "P2",
	explanation: { what: "wrong", whyHere: "here", whatToDo: "fix" },
	source: { check: "static.test", version: "1" },
});
const external = ExternalFinding.create({
	reviewer: { name: "codex" },
	file: "a.ts",
	line: 1,
	title: "wrong",
	body: "wrong",
	source: { kind: "file", path: "review.json", position: 0 },
});
const verdict = new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig })
	.adjudicate()
	.toJSON();
const sources = [{ source: "file:review.json", imported: { findings: [external], skippedBodies: 0 } }];
const at = "2026-10-21T00:00:00Z";
const opened: CompareHarness[] = [];
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of opened.splice(0)) await harness.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function memory() {
	const storage = createMemoryStorage();
	const harness = await CompareHarness.open(storage, createFakeModels().review, changeset, context);
	opened.push(harness);
	return { harness, storage };
}
async function mint(harness: CompareHarness, decided = true) {
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		await new RoundWriter(tx, root.id).mint(key, 1, at);
		if (decided) {
			const rounds = await tx.doc(RoundsDocument, root.id);
			rounds.items[rounds.current[key]!]!.verdict = verdict;
			(await tx.doc(VerdictDocument, root.id)).verdicts[key] = verdict;
		}
	}, context);
}

it("keeps two comparisons at one revision and reads their own frozen verdicts", async () => {
	const { harness, storage } = await memory();
	await mint(harness);
	await harness.importFindings(revision, sources, at);
	await harness.adjudicate(revision, finding.id, { verdict: "valid", by: "M", at });
	await mint(harness);
	await harness.importFindings(revision, [], at);
	await harness.adjudicate(revision, finding.id, { verdict: "valid", by: "M", at });
	const entries = await ComparisonReader.open(storage).read(changeset);
	expect(entries.map((entry) => entry.round)).toEqual([`${changeset}.r1`, `${changeset}.r2`]);
	expect(entries.map((entry) => entry.comparison.externalFindings().length)).toEqual([1, 0]);
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(VerdictDocument, root.id)).verdicts = {};
	}, context);
	expect((await ComparisonReader.open(storage).read(changeset)).map((entry) => entry.verdict?.all().length)).toEqual([
		1, 1,
	]);
	expect(Object.keys(JSON.parse(new ComparisonExport(entries, "range").renderJson()).comparisons)).toEqual([
		`${changeset}.r1`,
		`${changeset}.r2`,
	]);
	expect(new ComparisonSet(entries).stats().reviewers.find((each) => each.reviewer === "melian")?.total).toBe(2);
});

it.each(["import", "match", "unmatch", "adjudicate"])(
	"%s writes the explicitly named earlier round alone",
	async (operation) => {
		const { harness } = await memory();
		await mint(harness);
		await harness.importFindings(revision, sources, at);
		await mint(harness);
		await harness.importFindings(revision, [], at);
		const selected = { ...revision, round: `${changeset}.r1` };
		const before = (await harness.read(revision))!.toJSON();
		if (operation === "import")
			await harness.importFindings(
				selected,
				[{ source: "file:review.json", imported: { findings: [], skippedBodies: 0 } }],
				"later",
			);
		if (operation === "match")
			await harness.match(selected, { external: external.id, melian: finding.id }, { by: "M", at });
		if (operation === "unmatch")
			await harness.unmatch(selected, { external: external.id, melian: finding.id }, { by: "M", at });
		if (operation === "adjudicate")
			await harness.adjudicate(selected, external.id, { verdict: "noise", by: "M", at });
		expect((await harness.read(revision))!.toJSON()).toEqual(before);
		const earlier = (await harness.read(selected))!;
		if (operation === "adjudicate") expect(earlier.adjudication(external.id)?.current.verdict).toBe("noise");
		if (operation === "match") expect(earlier.toJSON().matches).not.toEqual(before.matches);
		if (operation === "unmatch") expect(earlier.effectiveMatches()).toEqual([]);
		if (operation === "import") expect(earlier.externalFindings()).toHaveLength(0);
	},
);

it.each(["import", "match", "unmatch", "adjudicate"])(
	"%s refuses an undecided current round without changing comparisons",
	async (operation) => {
		const { harness } = await memory();
		await mint(harness);
		await harness.importFindings(revision, sources, at);
		await mint(harness, false);
		const before = await harness.all(changeset);
		const write = () =>
			operation === "import"
				? harness.importFindings(revision, sources, at)
				: operation === "adjudicate"
					? harness.adjudicate(revision, external.id, { verdict: "noise", by: "M", at })
					: harness[operation as "match" | "unmatch"](
							revision,
							{ external: external.id, melian: finding.id },
							{ by: "M", at },
						);
		await expect(write()).rejects.toMatchObject({ code: "notReviewed" });
		expect(await harness.all(changeset)).toEqual(before);
	},
);

it("adjudication targets the current round even when only an older round holds the finding", async () => {
	const { harness } = await memory();
	await mint(harness);
	await harness.importFindings(revision, sources, at);
	await mint(harness);
	await harness.importFindings(revision, [], at);
	await expect(harness.adjudicate(revision, external.id, { verdict: "noise", by: "M", at })).rejects.toMatchObject({
		code: "unknownFinding",
	});
});

it.each([`${changeset}.r3`, "range-ffffffffffffffff.r1"])(
	"refuses an absent or other storage's round %s",
	async (round) => {
		const { harness } = await memory();
		await mint(harness);
		await expect(harness.importFindings({ ...revision, round }, sources, at)).rejects.toMatchObject({
			code: "notReviewed",
		});
	},
);

it("refuses an earlier undecided round even after the current round decides", async () => {
	const { harness } = await memory();
	await mint(harness, false);
	await mint(harness);
	const selected = { ...revision, round: `${changeset}.r1` };
	expect(await harness.reviewed(selected)).toBe(false);
	await expect(harness.importFindings(selected, [], at)).rejects.toMatchObject({ code: "notReviewed" });
});

it("writes a frozen decided round while the current round has no verdict", async () => {
	const { harness } = await memory();
	await mint(harness);
	await harness.importFindings(revision, sources, at);
	await mint(harness, false);
	const selected = { ...revision, round: `${changeset}.r1` };
	expect(await harness.reviewed(selected)).toBe(true);
	await harness.adjudicate(selected, external.id, { verdict: "noise", by: "M", at });
	expect((await harness.read(selected))!.adjudication(external.id)?.current.verdict).toBe("noise");
});

it("carries the latest judgement by time rather than insertion order", async () => {
	const { harness } = await memory();
	for (const [index, golden] of ["tests", "correctness"].entries()) {
		await mint(harness);
		await harness.importFindings(revision, [], at);
		await harness.adjudicate(revision, finding.id, {
			verdict: "noise",
			golden,
			by: "M",
			at: `2026-10-21T0${index + 1}:00:00Z`,
		});
	}
	await mint(harness);
	const comparison = await harness.adjudicate(revision, finding.id, {
		verdict: "valid",
		by: "M",
		at: "2026-10-21T03:00:00Z",
	});
	expect(comparison.adjudication(finding.id)?.current.golden).toBe("correctness");
});

it("synthesises and preserves a round-keyed comparison whose legacy verdict was deleted", async () => {
	const { harness, storage } = await memory();
	const root = await harness.harness.root(context);
	const legacy = `${changeset}.${legacyKey(key)}`;
	await root.commit(async (tx) => {
		const document = await tx.doc(ComparisonDocument, root.id);
		document.comparisons[legacy] = Comparison.of(revision).toJSON();
	}, context);
	expect((await new RoundReader(storage).read(changeset)).map((round) => round.id)).toEqual([legacy]);
	await mint(harness);
	const rounds = await new RoundReader(storage).read(changeset);
	expect(rounds.map((round) => round.id)).toEqual([legacy, `${changeset}.r1`]);
	expect(rounds[0]!.verdict()).toBeUndefined();
});

it("attributes a legacy comparison when minted rounds exist only at another revision", async () => {
	const { harness, storage } = await memory();
	await mint(harness);
	const other = { ...revision, head: "c".repeat(40) };
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(ComparisonDocument, root.id)).unattributed[revisionKey(other)] = Comparison.of(other).toJSON();
		(await tx.doc(VerdictDocument, root.id)).verdicts[revisionKey(other)] = verdict;
	}, context);
	const entries = await ComparisonReader.open(storage).read(changeset);
	expect(entries).toHaveLength(1);
	expect(entries[0]!.round).toBe(`${changeset}.${legacyKey(revisionKey(other))}`);
	expect(entries[0]!.unattributed).toBeUndefined();
});

it("does not synthesise an explicit missing round from a legacy live verdict", async () => {
	const { harness } = await memory();
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(VerdictDocument, root.id)).verdicts[key] = verdict;
	}, context);
	expect(await harness.reviewed({ ...revision, round: `${changeset}.r9` })).toBe(false);
});

it("refuses a lost recorded round instead of rebuilding it from the live verdict", async () => {
	const { harness } = await memory();
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(VerdictDocument, root.id)).verdicts[key] = verdict;
		(await tx.doc(RoundsDocument, root.id)).recorded[key] = true;
	}, context);
	expect(await harness.reviewed(revision)).toBe(false);
});

it.each(["main-36122eb2", "build1-0ee97219"])(
	"reopens genuine version-1 comparisons from %s without guessing",
	async (fixture) => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-comparison-rounds-")));
		directories.push(directory);
		const base = join(import.meta.dirname, "fixtures/comparison-rounds", fixture);
		const recorded = JSON.parse(readFileSync(join(base, "recorded.json"), "utf8")) as {
			revisions: { base: string; head: string }[];
			external: string;
		};
		const path = join(directory, "copy.sqlite");
		copyFileSync(join(base, "comparisons.sqlite"), path);
		const storage = await openSqliteStorage(path);
		const before = await storage.findDocument(
			{ kind: "melian.comparisons", scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } },
			"current",
			context,
		);
		expect((await storage.document(before!.id, "current", context))!.version).toBe(1);
		const entries = await ComparisonReader.open(storage).read(changeset);
		if (fixture.startsWith("build1")) {
			const rounds = await new RoundReader(storage).read(changeset);
			expect(rounds.map((round) => round.id)).toEqual([`${changeset}.r1`, `${changeset}.r2`]);
			expect(rounds.every((round) => round.stored.head === recorded.revisions[0]!.head)).toBe(true);
		}
		expect(
			await storage.findDocument(
				{ kind: "melian.comparisons", scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } },
				"current",
				context,
			),
		).toEqual(before);
		expect(entries).toHaveLength(fixture.startsWith("main") ? 2 : 1);
		for (const entry of entries) {
			expect(entry.comparison.adjudication(recorded.external)?.history).toHaveLength(1);
			if (fixture.startsWith("main")) {
				expect(entry.round).toBe(`${changeset}.${legacyKey(revisionKey(entry.comparison))}`);
				expect(entry.verdict?.status).toBe("passed");
			} else {
				expect(entry.round).toBeUndefined();
				expect(entry.unattributed).toBe(revisionKey(recorded.revisions[1]!));
				expect(entry.verdict).toBeUndefined();
				expect(new ComparisonExport(entries, "range").render()).toContain("Unattributed");
				expect(new ComparisonSet(entries).renderStats()).toContain("Unattributed comparisons: 1");
			}
		}
		const harness = await CompareHarness.open(storage, createFakeModels().review, changeset, context);
		opened.push(harness);
		const prior = await harness.read(recorded.revisions[1]!);
		if (fixture.startsWith("main")) expect(prior?.externalFindings()[0]?.id).toBe(recorded.external);
		else expect(prior).toBeUndefined();
		await harness.importFindings(recorded.revisions[1]!, [], at);
		const root = await harness.harness.root(context);
		const state = await harness.harness.snapshot(ComparisonDocument, root.id, context);
		expect(Object.keys(state!.comparisons).every((id) => id.startsWith(`${changeset}.`))).toBe(true);
		await harness.close();
		const reopened = await openSqliteStorage(path);
		try {
			const after = await ComparisonReader.open(reopened).read(changeset);
			expect(after.filter((entry) => entry.unattributed !== undefined)).toHaveLength(
				fixture.startsWith("main") ? 0 : 1,
			);
		} finally {
			await reopened.close(context);
		}
	},
);

it("preserves a proven legacy comparison when its first upgraded review mints a round", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-comparison-transition-")));
	directories.push(directory);
	const base = join(import.meta.dirname, "fixtures/comparison-rounds/main-36122eb2");
	const recorded = JSON.parse(readFileSync(join(base, "recorded.json"), "utf8")) as {
		revisions: { base: string; head: string }[];
	};
	const path = join(directory, "copy.sqlite");
	copyFileSync(join(base, "comparisons.sqlite"), path);
	const storage = await openSqliteStorage(path);
	const harness = await CompareHarness.open(storage, createFakeModels().review, changeset);
	opened.push(harness);
	const root = await harness.harness.root(context);
	const key = revisionKey(recorded.revisions[1]!);
	await root.commit((tx) => new RoundWriter(tx, root.id).mint(key, 999, at), context);
	const entries = await ComparisonReader.open(storage).read(changeset);
	expect(entries.filter((entry) => entry.unattributed !== undefined)).toEqual([]);
	expect(entries.map((entry) => entry.round)).toContain(`${changeset}.${legacyKey(key)}`);
	await harness.importFindings({ ...recorded.revisions[1]!, round: `${changeset}.${legacyKey(key)}` }, [], at);
	expect((await harness.harness.snapshot(ComparisonDocument, root.id, context))!.legacy).toEqual({});
});

it("marks only pending legacy comparisons observed before a minted round exists", async () => {
	const { harness } = await memory();
	await mint(harness);
	const root = await harness.harness.root(context);
	expect((await harness.harness.snapshot(ComparisonDocument, root.id, context))!.legacy).toEqual({});
	await root.commit(async (tx) => {
		(await tx.doc(ComparisonDocument, root.id)).unattributed[key] = Comparison.of(revision).toJSON();
		await new RoundWriter(tx, root.id).preserve(key);
	}, context);
	expect((await harness.harness.snapshot(ComparisonDocument, root.id, context))!.legacy).toEqual({});
	expect((await harness.all(changeset))[0]!.unattributed).toBe(key);
});

it("retries a detached SQLite read when mint commits between comparisons and rounds", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-comparison-race-")));
	directories.push(directory);
	const base = join(import.meta.dirname, "fixtures/comparison-rounds/main-36122eb2");
	const recorded = JSON.parse(readFileSync(join(base, "recorded.json"), "utf8")) as {
		revisions: { base: string; head: string }[];
	};
	const path = join(directory, "copy.sqlite");
	copyFileSync(join(base, "comparisons.sqlite"), path);
	const harness = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review, changeset);
	opened.push(harness);
	const root = await harness.harness.root(context);
	const revision = recorded.revisions[1]!;
	const key = revisionKey(revision);
	const storage = await openSqliteStorage(path);
	const document = storage.document.bind(storage);
	let interleaved = false;
	let reads = 0;
	vi.spyOn(storage, "document").mockImplementation(async (...args) => {
		expect(++reads).toBeLessThan(40);
		const stored = await document(...args);
		if (stored?.record.kind === "melian.comparisons" && !interleaved) {
			interleaved = true;
			await root.commit((tx) => new RoundWriter(tx, root.id).mint(key, 999, at), context);
		}
		return stored;
	});
	try {
		const entries = await ComparisonReader.open(storage).read(changeset);
		expect(interleaved).toBe(true);
		expect(entries.filter((entry) => entry.unattributed !== undefined)).toEqual([]);
		expect(entries.map((entry) => entry.round)).toContain(`${changeset}.${legacyKey(key)}`);
	} finally {
		await storage.close(context);
	}
});
