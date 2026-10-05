import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, defaultConfig, type StoredVerdict } from "@melian-agent/core";
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
	it("reads version 3 records without inventing history or changing replies, and writes version 4", async () => {
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
});
