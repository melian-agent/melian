import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type StoredVerdictState, VerdictDocument } from "../src/adjudication.ts";
import {
	type ConversationId,
	backgroundContext as context,
	createRegistry,
	defineDoc,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { createReviewRegistry } from "../src/review.ts";
import { publishedWalkthrough } from "../src/summarize.ts";
import { createFakeModels } from "../src/testing.ts";

// Written by main at 799a54bf, before a walkthrough recorded its route; the README says how.
const fixture = new URL("./fixtures/verdicts-v13-main/", import.meta.url);
const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
	revision: string;
	root: number;
	document: StoredVerdictState;
};
const versionThirteen = defineDoc<StoredVerdictState>({
	kind: "melian.verdicts",
	version: 13,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ verdicts: {} }),
});

let directory: string | undefined;
afterEach(() => {
	if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

it("reopens main's version-13 verdict document, and a version-13 reader refuses it once this build writes it", async () => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-verdicts-v14-")));
	const file = join(directory, "state.sqlite");
	copyFileSync(new URL("previous.sqlite", fixture), file);
	const fake = createFakeModels({ models: [{ id: "scripted" }] });
	const root = recorded.root as ConversationId;

	const current = await openHarness(await openSqliteStorage(file), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	const reopened = await current.snapshot(VerdictDocument, root, context);
	expect(reopened).toEqual(recorded.document);
	expect(publishedWalkthrough(reopened, recorded.revision)).toEqual(
		recorded.document.walkthroughs?.[recorded.revision],
	);
	await (await current.root(context)).commit(async (tx) => {
		(await tx.doc(VerdictDocument, root)).walkthroughRoutes = { [recorded.revision]: "faux/scripted@" };
	}, context);
	await current.close(context);

	const older = await openHarness(await openSqliteStorage(file), { models: fake.models, registry: createRegistry() });
	try {
		await expect(older.snapshot(versionThirteen, root, context)).rejects.toThrow(/newer version/);
	} finally {
		await older.close(context);
	}
});
