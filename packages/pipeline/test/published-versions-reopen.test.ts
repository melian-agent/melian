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
import recorded1 from "./fixtures/published-versions/v1.json" with { type: "json" };
import expected1 from "./fixtures/published-versions/v1-expected.json" with { type: "json" };
import recorded2 from "./fixtures/published-versions/v2.json" with { type: "json" };
import expected2 from "./fixtures/published-versions/v2-expected.json" with { type: "json" };
import recorded3 from "./fixtures/published-versions/v3.json" with { type: "json" };
import expected3 from "./fixtures/published-versions/v3-expected.json" with { type: "json" };
import recorded4 from "./fixtures/published-versions/v4.json" with { type: "json" };
import expected4 from "./fixtures/published-versions/v4-expected.json" with { type: "json" };
import recorded6 from "./fixtures/published-versions/v6.json" with { type: "json" };
import expected6 from "./fixtures/published-versions/v6-expected.json" with { type: "json" };
import recorded7 from "./fixtures/published-versions/v7.json" with { type: "json" };
import expected7 from "./fixtures/published-versions/v7-expected.json" with { type: "json" };

const versions = [
	{ recorded: recorded1, expected: expected1 },
	{ recorded: recorded2, expected: expected2 },
	{ recorded: recorded3, expected: expected3 },
	{ recorded: recorded4, expected: expected4 },
	{ recorded: recorded6, expected: expected6 },
	{ recorded: recorded7, expected: expected7 },
];
const cases = versions.flatMap(({ recorded, expected }) =>
	recorded.rounds.map((round, index) => ({ ...round, version: recorded.version, expected: expected[index]!.state })),
);

it.each(cases)(
	"reopens version $version's recorded $phase publication and persists its upgraded value",
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
				version: round.version,
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
			const upgraded = round.expected;
			expect(await second.snapshot(PublishedDocument, root.id, context)).toEqual(upgraded);
			await (await second.root(context)).commit(async (tx) => {
				await tx.doc(PublishedDocument, root.id);
			}, context);
			await expect(second.snapshot(previous, root.id, context)).rejects.toThrow(
				`newer version 10 than ${round.version}`,
			);
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
