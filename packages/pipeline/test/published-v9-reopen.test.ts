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
import recorded from "./fixtures/published-v9-build-2/published.json" with { type: "json" };

it("reopens the version-9 publication build 2 wrote unchanged, its ledger rounds without coverage", async () => {
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
			initial: () => JSON.parse(JSON.stringify(recorded.state)) as JsonObject,
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
		const migrated = await second.snapshot(PublishedDocument, root.id, context);
		expect(migrated).toEqual(recorded.state);
		expect(migrated?.ledgerRounds?.some((round) => "coverage" in round)).toBe(false);
		await (await second.root(context)).commit(async (tx) => {
			await tx.doc(PublishedDocument, root.id);
		}, context);
		await expect(second.snapshot(previous, root.id, context)).rejects.toThrow(/newer version 10 than 9/);
		await second.close(context);
		const third = await open();
		harnesses.push(third);
		expect(await third.snapshot(PublishedDocument, root.id, context)).toEqual(recorded.state);
	} finally {
		for (const harness of harnesses) await harness.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});
