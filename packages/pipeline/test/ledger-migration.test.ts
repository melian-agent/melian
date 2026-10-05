import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Adjudication,
	defaultConfig,
	type LedgerRound,
	type PostedLedger,
	type PublicationDetails,
	type StoredVerdict,
	type Walkthrough,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type Harness,
	openHarness,
	openSqliteStorage,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { LedgerDocument, PublishedDocument } from "../src/publish.ts";

type OldPublication = {
	order: string[];
	revisions: Record<
		string,
		{
			reviews: string[];
			verdict: string;
			verdictRevision: string;
			rounds: number;
			open: Record<string, { ruleId: string; path: string; line: number; revision: string; thread: string }>;
			resolved: Record<string, { ruleId: string; path: string; line: number; revision: string; thread: string }>;
			replies: Record<string, string | null>;
		}
	>;
};
const PreviousPublished = defineDoc<OldPublication>({
	kind: "melian.published",
	version: 3,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ order: [], revisions: {} }),
});
const PreviousVerdicts = defineDoc<{ verdicts: Record<string, StoredVerdict> }>({
	kind: "melian.verdicts",
	version: 3,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ verdicts: {} }),
});
let dir: string;
let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe("ledger document migration", () => {
	it("reads version 3 records without inventing history or changing replies, and writes the current versions", async () => {
		dir = mkdtempSync(join(tmpdir(), "melian-ledger-migration-"));
		const database = join(dir, "state.sqlite");
		const fake = createFakeModels();
		const open = async () =>
			openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
		harness = await open();
		let root = await harness.root(context);
		const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
			.adjudicate()
			.toJSON();
		const head = "b".repeat(40);
		const revision = `${"a".repeat(40)}..${head}`;
		const record = {
			reviews: ["201"],
			verdict: "0123456789abcdef",
			verdictRevision: revision,
			rounds: 1,
			open: {},
			resolved: {},
			replies: { "0123456789abcdef 202": "203" },
		};
		await root.commit(async (tx) => {
			const published = await tx.doc(PreviousPublished, root.id);
			published.order = [head];
			published.revisions = { [head]: record };
			(await tx.doc(PreviousVerdicts, root.id)).verdicts = { [revision]: verdict };
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect(await harness.snapshot(PublishedDocument, root.id, context)).toEqual({
			order: [head],
			revisions: { [head]: record },
		});
		expect((await harness.snapshot(VerdictDocument, root.id, context))?.verdicts[revision]).toEqual(verdict);
		expect(await harness.snapshot(LedgerDocument, root.id, context)).toBeUndefined();
		await root.commit(async (tx) => {
			(await tx.doc(PublishedDocument, root.id)).ledgerRounds = [];
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect((await harness.snapshot(PublishedDocument, root.id, context))?.ledgerRounds).toEqual([]);
		expect((await harness.snapshot(PublishedDocument, root.id, context))?.revisions[head]?.replies).toEqual(
			record.replies,
		);
	});
	it("migrates version 4 fallback notes and prunes old ledger detail after reopening", async () => {
		dir = mkdtempSync(join(tmpdir(), "melian-ledger-migration-"));
		const database = join(dir, "state.sqlite");
		const fake = createFakeModels();
		const open = async () =>
			openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
		const oldVerdicts = defineDoc<{
			verdicts: Record<string, StoredVerdict>;
			walkthroughs: Record<string, Walkthrough>;
		}>({
			kind: "melian.verdicts",
			version: 4,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ verdicts: {}, walkthroughs: {} }),
		});
		const oldPublished = defineDoc<OldPublication & { ledgerRounds: LedgerRound[] }>({
			kind: "melian.published",
			version: 4,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ order: [], revisions: {}, ledgerRounds: [] }),
		});
		const oldLedger = defineDoc<{ comment?: PostedLedger }>({
			kind: "melian.ledger",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({}),
		});
		const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
			.adjudicate()
			.toJSON();
		const base = "a".repeat(40);
		const head = "b".repeat(40);
		const revision = `${base}..${head}`;
		const round = {
			base,
			head,
			round: 1,
			verdict,
			resolved: [],
			walkthrough: { summary: "Stored summary.", files: [] },
			details: { policy: "config", manifest: [], lenses: [], standards: [] },
		};
		const comment = {
			id: "17",
			url: "https://example.test/17",
			stamp: {
				version: 1 as const,
				base,
				head,
				round: 1,
				verdict: "0123456789abcdef",
				counts: { open: 0, blocking: 0, dismissed: 0 },
				lenses: [],
				plan: null,
				projection: "0123456789abcdef",
			},
		};
		harness = await open();
		let root = await harness.root(context);
		await root.commit(async (tx) => {
			const doc = await tx.doc(oldVerdicts, root.id);
			doc.verdicts = { [revision]: verdict };
			doc.walkthroughs = {
				[revision]: {
					summary: "No walkthrough available.",
					files: [],
					note: "The summariser done: private provider detail.",
				},
				success: { summary: "Real summary.", files: [] },
			};
			(await tx.doc(oldPublished, root.id)).ledgerRounds = [round, { ...round, round: 2 }];
			(await tx.doc(oldLedger, root.id)).comment = comment;
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		const doc = await harness.snapshot(VerdictDocument, root.id, context);
		expect(doc?.walkthroughs?.[revision]).toBeUndefined();
		expect(doc?.walkthroughs?.success?.summary).toBe("Real summary.");
		expect(doc?.walkthroughNotes?.[revision]).toBe("No walkthrough available. The summariser returned no summary.");
		expect(JSON.stringify(doc)).not.toContain("private provider detail");
		const rounds = (await harness.snapshot(PublishedDocument, root.id, context))?.ledgerRounds;
		expect(rounds?.[0]).toEqual({ base, head, round: 1, status: "passed" });
		expect(rounds?.[1]).toEqual({ ...round, round: 2 });
		expect((await harness.snapshot(LedgerDocument, root.id, context))?.comment).toEqual(comment);
	});
	it("reads version 5 lens details with standards absent and preserves them on upgrade", async () => {
		dir = mkdtempSync(join(tmpdir(), "melian-standards-migration-"));
		const database = join(dir, "state.sqlite");
		const fake = createFakeModels();
		const open = async () =>
			openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
		const old = defineDoc<{ verdicts: Record<string, StoredVerdict>; details: Record<string, PublicationDetails> }>({
			kind: "melian.verdicts",
			version: 5,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ verdicts: {}, details: {} }),
		});
		const oldPublished = defineDoc<OldPublication & { ledgerRounds: LedgerRound[] }>({
			kind: "melian.published",
			version: 5,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ order: [], revisions: {}, ledgerRounds: [] }),
		});
		const details = {
			policy: "config",
			manifest: ["lens.correctness"],
			standards: ["AGENTS.md"],
			lenses: [
				{ name: "correctness", version: "1", level: "careful", models: ["fake/model"], budget: { findings: 8 } },
			],
		};
		harness = await open();
		let root = await harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(old, root.id)).details.head = details;
			(await tx.doc(oldPublished, root.id)).ledgerRounds = [
				{
					base: "a".repeat(40),
					head: "b".repeat(40),
					round: 1,
					verdict: new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
						.adjudicate()
						.toJSON(),
					resolved: [],
					details,
				},
			];
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect((await harness.snapshot(VerdictDocument, root.id, context))?.details?.head).toEqual(details);
		expect((await harness.snapshot(PublishedDocument, root.id, context))?.ledgerRounds?.at(-1)).toMatchObject({
			details,
		});
		expect(
			(await harness.snapshot(VerdictDocument, root.id, context))?.details?.head?.lenses[0]?.standards,
		).toBeUndefined();
		await root.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).details!.head!.lenses[0]!.standards = ["AGENTS.md"];
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect((await harness.snapshot(VerdictDocument, root.id, context))?.details?.head?.lenses[0]?.standards).toEqual([
			"AGENTS.md",
		]);
	});
});
