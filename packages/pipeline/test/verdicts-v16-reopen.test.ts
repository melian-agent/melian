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
import { createFakeModels } from "../src/testing.ts";

let directory: string | undefined;
afterEach(() => {
	if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

it("reopens main's version-15 verdict document unchanged, and a version-15 reader refuses the level a lineage names", async () => {
	const fixture = new URL("./fixtures/verdicts-v15-main/", import.meta.url);
	const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
		revision: string;
		root: number;
		document: StoredVerdictState;
	};
	const older = defineDoc<StoredVerdictState>({
		kind: "melian.verdicts",
		version: 15,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({ verdicts: {} }),
	});
	directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-verdicts-v16-")));
	const file = join(directory, "state.sqlite");
	copyFileSync(new URL("previous.sqlite", fixture), file);
	const fake = createFakeModels({ models: [{ id: "scripted" }] });
	const root = recorded.root as ConversationId;
	const lineage = {
		model: "faux/second",
		wanted: "faux/first",
		by: "melian.yaml",
		outside: true,
		answeredAt: "medium" as const,
	};

	const current = await openHarness(await openSqliteStorage(file), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	try {
		expect(await current.snapshot(VerdictDocument, root, context)).toEqual(recorded.document);
		await (await current.root(context)).commit(async (tx) => {
			const verdict = (await tx.doc(VerdictDocument, root)).verdicts[recorded.revision]!;
			verdict.ran = verdict.ran!.map((check) => ({ ...check, lineage }));
		}, context);
		const written = (await current.snapshot(VerdictDocument, root, context))!.verdicts[recorded.revision]!;
		expect(written.ran!.map((check) => check.lineage)).toEqual(
			recorded.document.verdicts[recorded.revision]!.ran!.map(() => lineage),
		);
	} finally {
		await current.close(context);
	}

	const reader = await openHarness(await openSqliteStorage(file), {
		models: fake.models,
		registry: createRegistry(),
	});
	try {
		await expect(reader.snapshot(older, root, context)).rejects.toThrow(/newer version/);
	} finally {
		await reader.close(context);
	}
});
