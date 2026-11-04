import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type Harness,
	openHarness,
	openSqliteStorage,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it } from "vitest";
import { ReviewIndex, type ReviewIndexState } from "../src/review-index.ts";

const opened: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([1, 2])("reopens a version-%i review index without rewriting its stale selection", async (version) => {
	const recorded = JSON.parse(
		readFileSync(new URL(`./fixtures/migrations-from-version/index-v${version}.json`, import.meta.url), "utf8"),
	) as { version: number; revision: { base: string; head: string }; index: ReviewIndexState };
	expect(recorded.version).toBe(version);
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-review-index-reopen-")));
	directories.push(directory);
	const path = join(directory, "state.sqlite");
	const fake = createFakeModels();
	const token = defineDoc<ReviewIndexState>({
		kind: ReviewIndex.definition.kind,
		version,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({ reviews: {} }),
	});
	const first = await openHarness(await openSqliteStorage(path), { models: fake.models, registry: createRegistry() });
	opened.push(first);
	const root = await first.root(context);
	await root.commit(async (tx) => {
		Object.assign(await tx.doc(token, root.id), recorded.index);
	}, context);
	await first.close(context);

	const second = await openHarness(await openSqliteStorage(path), { models: fake.models, registry: createRegistry() });
	opened.push(second);
	const migrated = await second.snapshot(ReviewIndex, root.id, context);
	expect(migrated).toEqual(recorded.index);
	const key = version === 1 ? recorded.revision.head : revisionKey(recorded.revision);
	expect(Object.keys(migrated!.reviews)).toEqual([key]);
	expect(migrated!.reviews[key]!.lenses).toHaveLength(1);
	expect(migrated!.reviews[key]!.lenses[0]).toMatch(/^correctness@[^@\s]+(?: on \S+)?$/);
	const reopenedRoot = await second.root(context);
	await reopenedRoot.commit(async (tx) => {
		(await tx.doc(ReviewIndex, root.id)).reviews["new-base..new-head"] = { lenses: [] };
	}, context);
	await second.close(context);

	const storage = await openSqliteStorage(path);
	const third = await openHarness(storage, { models: fake.models, registry: createRegistry() });
	opened.push(third);
	expect(await third.snapshot(ReviewIndex, root.id, context)).toEqual({
		reviews: { ...recorded.index.reviews, "new-base..new-head": { lenses: [] } },
	});
	const document = await storage.findDocument(
		{ kind: ReviewIndex.definition.kind, scope: { kind: "conversation", conversationId: root.id } },
		"current",
		context,
	);
	expect((await storage.document(document!.id, "current", context))!.version).toBe(4);
	expect(fake.provider.state.callCount).toBe(0);
});
