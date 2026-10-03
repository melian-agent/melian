// Runs the first half of a spike scenario in its own process; the parent test kills it with SIGKILL while it is parked.
import { backgroundContext, createFakeModels } from "../../src/harness.ts";
import { openSpikeHarness, phasedTask, record, type Scenario, spikeRegistry, toolCallReply } from "./spike.ts";

const [scenario, database, log] = process.argv.slice(2) as [Scenario, string, string];
const fake = createFakeModels();
const harness = await openSpikeHarness(database, spikeRegistry(scenario, "crash", log), fake);
const root = await harness.root(backgroundContext, { agent: { model: fake.ref() } });

if (scenario === "task") {
	const taskId = await root.commit(
		(tx) => tx.createTask(phasedTask("crash", log), {}, { ownership: { kind: "conversation" } }),
		backgroundContext,
	);
	record(log, { event: "task-created", taskId });
	await harness.waitForTask(taskId, backgroundContext);
} else {
	fake.provider.setResponses([
		toolCallReply(...(scenario === "replay" ? ["safe_probe", "unsafe_probe"] : ["publish_once"])),
	]);
	const submission = await root.submit({ type: "input", content: `run the ${scenario} scenario` }, backgroundContext);
	record(log, { event: "submitted", submissionId: submission.id });
	await submission.wait(backgroundContext);
}
