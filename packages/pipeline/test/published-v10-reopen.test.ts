import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
import recorded from "./fixtures/stored-published-v10/published.json" with { type: "json" };

it("reopens main's version-10 publication unchanged, and a version-10 reader refuses what this build writes", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-published-v10-")));
	const database = join(directory, "state.sqlite");
	copyFileSync(new URL("./fixtures/stored-published-v10/state.sqlite", import.meta.url), database);
	const fake = createFakeModels();
	const open = async () =>
		openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
	const previous = defineDoc<JsonObject>({
		kind: "melian.published",
		version: recorded.version,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({}),
	});
	const harnesses: Harness[] = [];
	try {
		const first = await open();
		harnesses.push(first);
		const root = await first.root(context);
		expect(await first.snapshot(PublishedDocument, root.id, context)).toEqual(recorded.published);
		await root.commit(async (tx) => {
			await tx.doc(PublishedDocument, root.id);
		}, context);
		await expect(first.snapshot(previous, root.id, context)).rejects.toThrow(/newer version 11 than 10/);
		await first.close(context);
		const second = await open();
		harnesses.push(second);
		expect(await second.snapshot(PublishedDocument, root.id, context)).toEqual(recorded.published);
	} finally {
		for (const harness of harnesses) await harness.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});
