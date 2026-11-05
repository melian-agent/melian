import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type Harness,
	type JsonObject,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { PublishedDocument } from "../src/publish.ts";
import { createFakeModels } from "../src/testing.ts";
import recorded from "./fixtures/published-v9-main.json" with { type: "json" };

it.each(recorded.rounds)("reopens main's version-9 $phase resolutions and receipts unchanged", async (round) => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-published-v9-")));
	const database = join(directory, "state.sqlite");
	const fake = createFakeModels();
	const open = async () =>
		openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
	const harnesses: Harness[] = [];
	try {
		const previous = defineDoc<JsonObject>({
			kind: "melian.published",
			version: recorded.version,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => JSON.parse(JSON.stringify(round.state)) as JsonObject,
		});
		const first = await open();
		harnesses.push(first);
		const root = await first.root(context);
		await root.commit(async (tx) => {
			await tx.doc(previous, root.id);
		}, context);
		await first.close(context);
		const second = await open();
		harnesses.push(second);
		const migrated = (await second.snapshot(PublishedDocument, root.id, context))!;
		const expected = round.state;
		expect(migrated).toEqual(expected);
		expect(Object.values(migrated.revisions).map((record) => record.publishedBy?.trustedWriters)).toEqual([true]);
		const reopened = await second.root(context);
		await reopened.commit(async (tx) => {
			await tx.doc(PublishedDocument, root.id);
		}, context);
		await expect(second.snapshot(previous, root.id, context)).rejects.toThrow(/newer version 10 than 9/);
		await second.close(context);
		const third = await open();
		harnesses.push(third);
		expect(await third.snapshot(PublishedDocument, root.id, context)).toEqual(expected);
	} finally {
		for (const harness of harnesses) await harness.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});
