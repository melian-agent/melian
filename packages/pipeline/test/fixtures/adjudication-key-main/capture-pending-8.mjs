// Copy this file to the root of the 56f7fb059 source tree before running it, and pass the absolute output directory
// that holds decided.sqlite and recorded.json. It copies decided.sqlite to pending-8.sqlite, then creates an adjudication
// task there, with main's own task definition, from the input main stored plus main's own `code`, and points the review
// index at it under main's own key. The harness installs no extension, so the task stays pending, as after a crash.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdjudicationTask, adjudicationKey } from "./packages/pipeline/src/adjudication.ts";
import { codeVersion } from "./packages/pipeline/src/code-version.ts";
import { createRegistry } from "./packages/pipeline/src/harness.ts";
import { backgroundContext as context, openHarness, openSqliteStorage } from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";

const out = process.argv[2];
const recorded = JSON.parse(readFileSync(join(out, "recorded.json"), "utf8"));
copyFileSync(join(out, "decided.sqlite"), join(out, "pending-8.sqlite"));
const fake = createFakeModels();
const harness = await openHarness(await openSqliteStorage(join(out, "pending-8.sqlite")), {
	models: fake.models,
	registry: createRegistry(),
});
const root = await harness.root(context);
const parsed = { ...JSON.parse(recorded.adjudication.input), code: codeVersion("adjudication") };
const input = adjudicationKey(parsed);
const task = await root.commit(async (tx) => {
	const created = await tx.createTask(AdjudicationTask, parsed, { ownership: { kind: "conversation" } });
	(await tx.doc(ReviewIndex, root.id)).reviews[recorded.key].adjudication = { task: created, input };
	return created;
}, context);
const record = (await harness.inspect(context)).tasks.find((each) => each.record.id === task).record;
await harness.close(context);
writeFileSync(
	join(out, "pending-8.json"),
	`${JSON.stringify({ commit: "56f7fb059", task, version: record.version, status: record.state.status, input }, null, 2)}\n`,
);
