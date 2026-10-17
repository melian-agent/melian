import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dismissalVersion, type FindingDismissal, replyKey } from "@melian-agent/core";
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
import recorded from "./fixtures/published-v8-main.json" with { type: "json" };

type OldEntry = {
	ruleId: string;
	path: string;
	line: number;
	revision: string;
	thread?: string;
	dismissal: FindingDismissal;
};

it.each(recorded.rounds)("reopens main's version-8 $phase resolutions and trust-floor snapshots", async (round) => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-published-v8-")));
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
		const expected = {
			...round.state,
			revisions: Object.fromEntries(
				Object.entries(round.state.revisions).map(([head, record]) => {
					const resolutions: Record<string, OldEntry> =
						"pending" in record ? record.pending.resolved : record.resolved;
					const resolved = Object.fromEntries(
						Object.entries(resolutions).map(([id, entry]) => [
							entry.thread === undefined ? id : replyKey(id, entry.thread, dismissalVersion(entry.dismissal)),
							{ ...entry, id },
						]),
					);
					return [
						head,
						"pending" in record
							? { ...record, pending: { ...record.pending, resolved } }
							: { ...record, resolved },
					];
				}),
			),
		};
		expect(migrated).toEqual(expected);
		expect(JSON.stringify(migrated)).toContain('"trustFloor"');
		expect(Object.values(migrated.revisions).map((record) => record.publishedBy?.trustedWriters)).toEqual([false]);
		const reopened = await second.root(context);
		await reopened.commit(async (tx) => {
			await tx.doc(PublishedDocument, root.id);
		}, context);
		await expect(second.snapshot(previous, root.id, context)).rejects.toThrow(/newer version 9 than 8/);
		await second.close(context);
		const third = await open();
		harnesses.push(third);
		expect(await third.snapshot(PublishedDocument, root.id, context)).toEqual(expected);
	} finally {
		for (const harness of harnesses) await harness.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});
