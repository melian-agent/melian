import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dismissalVersion, replyKey } from "@melian-agent/core";
import { expect, it } from "vitest";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type Harness,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { PublishedDocument } from "../src/publish.ts";
import { createFakeModels } from "../src/testing.ts";
import recorded from "./fixtures/published-v2.json" with { type: "json" };

it("reopens version-2 dismissal replies under their thread and dismissal keys", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-published-v2-")));
	const database = join(directory, "state.sqlite");
	const fake = createFakeModels();
	const open = async () =>
		openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
	const harnesses: Harness[] = [];
	try {
		const previous = defineDoc({
			kind: "melian.published",
			version: recorded.version,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => structuredClone(recorded.state),
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
		const expected = {
			...recorded.state,
			revisions: Object.fromEntries(
				Object.entries(recorded.state.revisions).map(([head, record]) => {
					const [id, entry] = Object.entries(record.resolved)[0]!;
					const key = replyKey(id, entry.thread, dismissalVersion(entry.dismissal));
					return [
						head,
						{
							...record,
							resolved: { [key]: { ...entry, id } },
							replies: { [key]: Object.values(record.replies)[0] },
							publishedBy: { trustedWriters: true },
						},
					];
				}),
			),
		};
		expect(await second.snapshot(PublishedDocument, root.id, context)).toEqual(expected);
		const reopened = await second.root(context);
		await reopened.commit(async (tx) => {
			await tx.doc(PublishedDocument, root.id);
		}, context);
		await second.close(context);
		const third = await open();
		harnesses.push(third);
		expect(await third.snapshot(PublishedDocument, root.id, context)).toEqual(expected);
	} finally {
		for (const harness of harnesses) await harness.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});
