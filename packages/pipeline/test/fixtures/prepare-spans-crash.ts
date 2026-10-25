import { DecisionDocument } from "../../src/decisions.ts";
import {
	backgroundContext as context,
	createRegistry,
	defineExtension,
	openHarness,
	openSqliteStorage,
} from "../../src/index.ts";
import { createFakeModels } from "../../src/testing.ts";
import { resumedTask } from "./resumed-task.ts";
import { record } from "./review-scenario.ts";

// Starts a timed task, records that it started, and parks until the test kills this process.
const [database, log] = process.argv.slice(2) as [string, string];
const task = resumedTask(async () => {
	record(log, { event: "started" });
	await new Promise<never>(() => setInterval(() => {}, 1000));
});
const registry = createRegistry();
registry.install(defineExtension({ name: "test.resumed", tasks: [task] }));
const harness = await openHarness(await openSqliteStorage(database), { models: createFakeModels().models, registry });
const root = await harness.root(context);
const id = await root.commit(async (tx) => {
	const created = await tx.createTask(task, null, { ownership: { kind: "conversation" } });
	(await tx.doc(DecisionDocument, root.id)).decisions["base..head"] = { triage: { task: created, key: "test" } };
	return created;
}, context);
await harness.waitForTask(id, context);
