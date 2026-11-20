// Copy this file to the root of the a69fac993 source tree before running it, and pass the absolute output directory that
// capture.mjs wrote. It copies decided.sqlite to pending.sqlite, then creates a second adjudication task there from the
// input main stored, with main's own task definition, and points the review index at it. The harness installs no
// extension, so nothing runs the task before it closes: it stays pending, as after a crash before its phase.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdjudicationTask } from "./packages/pipeline/src/adjudication.ts";
import { createRegistry } from "./packages/pipeline/src/harness.ts";
import { backgroundContext as context, openHarness, openSqliteStorage } from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";

const out = process.argv[2];
const recorded = JSON.parse(readFileSync(join(out, "recorded.json"), "utf8"));
copyFileSync(join(out, "decided.sqlite"), join(out, "pending.sqlite"));
const fake = createFakeModels();
const harness = await openHarness(await openSqliteStorage(join(out, "pending.sqlite")), {
	models: fake.models,
	registry: createRegistry(),
});
const root = await harness.root(context);
const task = await root.commit(async (tx) => {
	const input = recorded.adjudication.input;
	const created = await tx.createTask(AdjudicationTask, JSON.parse(input), { ownership: { kind: "conversation" } });
	(await tx.doc(ReviewIndex, root.id)).reviews[recorded.key].adjudication = { task: created, input };
	return created;
}, context);
const status = (await harness.inspect(context)).tasks.find((each) => each.record.id === task).record.state.status;
await harness.close(context);
writeFileSync(join(out, "pending.json"), `${JSON.stringify({ commit: "a69fac993", task, status }, null, 2)}\n`);
