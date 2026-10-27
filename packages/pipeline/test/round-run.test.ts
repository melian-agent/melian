import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, defaultConfig } from "@melian-agent/core";
import { afterEach, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { ChecksDocument } from "../src/checks.ts";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	type Harness,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { legacyKey, RoundsDocument, RoundWriter } from "../src/rounds.ts";
import { PrepareSpans } from "../src/spans.ts";
import { TelemetryReader } from "../src/telemetry.ts";
import { createFakeModels } from "../src/testing.ts";
import { RecordedReview, recordedReviewTask } from "./fixtures/recorded-review.ts";

let harness: Harness | undefined;
let directory: string | undefined;
afterEach(async () => {
	await harness?.close(context);
	if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
	harness = undefined;
	directory = undefined;
});

const revision = "base..head";
const roundId = legacyKey(revision);
const expected = {
	roundId,
	durationMs: 200,
	stages: [
		{ name: "preparation", models: [], durationMs: 200, outcome: "ran" },
		{ name: "adjudication", models: [], outcome: "ran" },
	],
};

async function setup(path?: string) {
	const storage = path === undefined ? createMemoryStorage() : await openSqliteStorage(path);
	const registry = createRegistry();
	registry.install({ name: "test.recorded-review", tasks: [recordedReviewTask] });
	harness = await openHarness(storage, { models: createFakeModels().models, registry });
	const root = await harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(VerdictDocument, root.id)).verdicts[revision] = new Adjudication({
			findings: [],
			manifest: [],
			checks: [],
			config: defaultConfig,
		})
			.adjudicate()
			.toJSON();
	}, context);
	await new RecordedReview(harness).record(revision);
	const task = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[revision]!.adjudication!.task;
	await root.commit(async (tx) => {
		await new RoundWriter(tx, root.id).keep(revision, task);
	}, context);
	const spans = PrepareSpans.start("prepare", 100, () => 300);
	expect(spans.roundId).toBeUndefined();
	spans.bindRound(roundId);
	expect(spans.roundId).toBe(roundId);
	const prepare = await spans.record(harness, revision, context);
	return { root, storage, prepare, reader: TelemetryReader.open(storage) };
}

it.each([
	"current",
	"wrong round",
	"undecided",
	"other adjudication",
	"no adjudication",
	"no review",
	"matched checks",
	"absent check owner",
	"other check owner",
	"unbound checks",
	"other preparation",
])("captures only the round's own sources (%s)", async (mode) => {
	const { root, reader, prepare } = await setup();
	await root.commit(async (tx) => {
		const rounds = await tx.doc(RoundsDocument, root.id);
		const round = rounds.items[roundId]!;
		round.tasks.push(777);
		const index = await tx.doc(ReviewIndex, root.id);
		const checks = await tx.doc(ChecksDocument, root.id);
		if (mode === "wrong round") rounds.current[revision] = "r2";
		if (mode === "undecided") delete round.verdict;
		if (mode === "other adjudication") index.reviews[revision]!.adjudication!.task = 999;
		if (mode === "no adjudication") delete index.reviews[revision]!.adjudication;
		if (mode === "no review") delete index.reviews[revision];
		if (["matched checks", "absent check owner", "other check owner"].includes(mode))
			round.checkRun = JSON.stringify({ base: "base", head: "head", tier: "full", policy: "policy", task: 123 });
		if (["matched checks", "other check owner", "unbound checks"].includes(mode))
			checks.owners = { [revision]: `base head full policy ${mode === "matched checks" ? 123 : 124}` };
	}, context);
	if (mode === "other preparation")
		await PrepareSpans.start("another", 400, () => 500).record(harness!, revision, context);
	await reader.recordRun(harness!, revision, roundId, 100, prepare);
	expect(await reader.runDetails(roundId)).toEqual(
		["current", "matched checks"].includes(mode) ? expected : undefined,
	);
	expect(await reader.runDetails("r999")).toBeUndefined();
});

it("reopens the frozen run twice without changing its round or measured values", async () => {
	directory = mkdtempSync(join(tmpdir(), "melian-round-run-"));
	const path = join(directory, "state.sqlite");
	const { reader, prepare, storage: writerStorage } = await setup(path);
	await reader.recordRun(harness!, revision, roundId, 100, prepare);
	const document = await writerStorage.findDocument(
		{
			kind: "melian.run-details",
			scope: { kind: "conversation", conversationId: (await harness!.root(context)).id },
			key: roundId,
		},
		"current",
		context,
	);
	expect(document).toMatchObject({ kind: "melian.run-details", key: roundId, history: "latest", fork: "current" });
	expect((await writerStorage.document(document!.id, "current", context))!.version).toBe(1);
	await harness!.close(context);
	harness = undefined;
	for (let pass = 0; pass < 2; pass++) {
		const storage = await openSqliteStorage(path);
		try {
			expect(await TelemetryReader.open(storage).runDetails(roundId)).toEqual(expected);
		} finally {
			await storage.close(context);
		}
	}
});
