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
import recorded from "./fixtures/published-v1.json" with { type: "json" };

it.each(recorded.rounds)("reopens version-1 $phase publication with current evidence", async (round) => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-published-v1-")));
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
		const [head, record] = Object.entries(round.state.revisions)[0]!;
		const pending = record.pending;
		const oldFinding = Object.values(recorded.rounds[0]!.state.revisions)[0]!.pending!.post[0]!.finding;
		const finding = {
			...oldFinding,
			properties: {
				...oldFinding.properties,
				evidence: [
					{
						file: "src/user.ts",
						startLine: 7,
						snippet: "\treturn (user.manager as User).name;",
						role: "cause",
						revision: "head",
					},
				],
			},
		};
		const expected = {
			...round.state,
			revisions: {
				[head]: {
					...record,
					publishedBy: { trustedWriters: true },
					...(pending === undefined
						? {}
						: {
								pending: {
									...pending,
									post: [{ ...pending.post[0], finding }],
									verdict: {
										...pending.verdict,
										findings: { ...pending.verdict.findings, acknowledge: [finding] },
									},
								},
							}),
				},
			},
		};
		expect(migrated).toEqual(expected);
		const reopened = await second.root(context);
		await reopened.commit(async (tx) => {
			await tx.doc(PublishedDocument, root.id);
		}, context);
		await expect(second.snapshot(previous, root.id, context)).rejects.toThrow(/newer version 9 than 1/);
		await second.close(context);
		const third = await open();
		harnesses.push(third);
		expect(await third.snapshot(PublishedDocument, root.id, context)).toEqual(expected);
	} finally {
		for (const harness of harnesses) await harness.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});
