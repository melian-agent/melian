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
import recorded from "./fixtures/published-versions/v1.json" with { type: "json" };
import expected from "./fixtures/published-versions/v1-expected.json" with { type: "json" };

it.each(recorded.rounds.map((round, index) => ({ ...round, expected: expected[index]!.state })))(
	"reopens version 1's recorded $phase publication and persists its upgraded value",
	async (round) => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-published-versions-")));
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
				initial: () => structuredClone(round.state) as JsonObject,
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
			const upgraded = round.expected;
			expect(await second.snapshot(PublishedDocument, root.id, context)).toEqual(upgraded);
			await (await second.root(context)).commit(async (tx) => {
				await tx.doc(PublishedDocument, root.id);
			}, context);
			await expect(second.snapshot(previous, root.id, context)).rejects.toThrow(/newer version 9 than 1/);
			await second.close(context);
			const third = await open();
			harnesses.push(third);
			expect(await third.snapshot(PublishedDocument, root.id, context)).toEqual(upgraded);
		} finally {
			for (const harness of harnesses) await harness.close(context);
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
