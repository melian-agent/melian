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

// Each was written by main before a walkthrough recorded its route; its README says how.
const fixtures = [
	{ version: 13, directory: "verdicts-v13-main" },
	{ version: 14, directory: "verdicts-v14-main" },
];

let directory: string | undefined;
afterEach(() => {
	if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

it.each(fixtures)(
	"reopens main's version-$version verdict document, and a version-$version reader refuses it once this build writes it",
	async ({ version, directory: name }) => {
		const fixture = new URL(`./fixtures/${name}/`, import.meta.url);
		const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
			revision: string;
			root: number;
			document: StoredVerdictState;
		};
		const older = defineDoc<StoredVerdictState>({
			kind: "melian.verdicts",
			version,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ verdicts: {} }),
		});
		directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-verdicts-v15-")));
		const file = join(directory, "state.sqlite");
		copyFileSync(new URL("previous.sqlite", fixture), file);
		const fake = createFakeModels({ models: [{ id: "scripted" }] });
		const root = recorded.root as ConversationId;

		const current = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createReviewRegistry(),
		});
		try {
			const reopened = await current.snapshot(VerdictDocument, root, context);
			expect(reopened).toEqual(recorded.document);
			expect(publishedWalkthrough(reopened, recorded.revision)).toEqual(
				recorded.document.walkthroughs?.[recorded.revision],
			);
			await (await current.root(context)).commit(async (tx) => {
				(await tx.doc(VerdictDocument, root)).routedWalkthroughs = {
					[recorded.revision]: { "faux/scripted@": { summary: "Written by this build.", files: [] } },
				};
			}, context);
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
	},
);
