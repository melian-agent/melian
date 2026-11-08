import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { backgroundContext as context, createRegistry, openHarness, openSqliteStorage } from "../src/harness.ts";
import { ReviewHarness } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { createFakeModels } from "../src/testing.ts";
import { VerificationTask } from "../src/verification.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "melian-resumed-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

// A crash between the commit that creates a verification task and its spawn commit leaves it at spawn, with no attempts.
it("names a verification task's providers when a crash left it before its spawn commit", async () => {
	const file = join(directory, "state.sqlite");
	const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
	const judge = fake.ref("judge");
	// No task is installed, so the task stays at its first checkpoint.
	const first = await openHarness(await openSqliteStorage(file), { models: fake.models, registry: createRegistry() });
	const root = await first.root(context, { agent: { model: fake.ref("finder") } });
	await root.commit(async (tx) => {
		const input = {
			root: root.id,
			revision: { repoRoot: directory, nonce: "a".repeat(24), base: "b", head: "h", files: [] },
			version: "v",
			candidates: [{ key: "k", route: [judge] }],
		} as never;
		const task = await tx.createTask(VerificationTask, input, { ownership: { kind: "conversation" } });
		(await tx.doc(ReviewIndex, root.id)).reviews["b..h"] = { lenses: [], verification: { task, input: "{}" } };
	}, context);
	await first.close(context);
	const reopened = await ReviewHarness.open(await openSqliteStorage(file), fake.review, { retry: false });
	try {
		expect(await reopened.resumedProviders(context)).toEqual([judge.provider]);
	} finally {
		await reopened.close();
	}
});
