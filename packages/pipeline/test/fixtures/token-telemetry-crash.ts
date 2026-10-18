import { appendFileSync, writeFileSync } from "node:fs";
import { FallbackDecider } from "@melian-agent/decisions";
import { DecisionDocument, decisionExtension, decisionTask } from "../../src/decisions.ts";
import {
	backgroundContext as context,
	createRegistry,
	openHarness,
	openSqliteStorage,
	RouteTextModel,
	TelemetryReader,
} from "../../src/index.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
} from "../../src/testing.ts";

const [database, log, mode, ready, output] = process.argv.slice(2) as [string, string, string, string, string];
const watchdog = setTimeout(() => process.exit(3), 15_000);
const fake = createFakeModels({ models: [{ id: "triage" }] });
scriptConversations(fake, [
	{
		match: "You answer typed questions",
		replies: [
			(messages) => {
				const questions = messages
					.filter((message) => message.role === "user")
					.map(textOf)
					.join("\n");
				if ([...questions.matchAll(/^### (.+)$/gm)].map((match) => match[1]).join(",") !== "lens")
					throw new Error("fixture was asked another question");
				appendFileSync(log, "asked\n");
				return fauxAssistantMessage(
					fauxToolCall("answer", {
						answers: [{ question: "lens", probabilities: [{ option: "careful", probability: 1 }] }],
					}),
					{ stopReason: "toolUse" },
				);
			},
		],
	},
]);
const decider = new FallbackDecider((await RouteTextModel.create(fake.review, [fake.ref("triage")]))!);
const registry = createRegistry();
registry.install(decisionExtension(decider));
const storage = await openSqliteStorage(database);
const commit = storage.commit.bind(storage);
storage.commit = async (writes, commitContext) => {
	const terminal = writes.some(
		(write) =>
			write.type === "task" &&
			write.value.kind === "melian.decision" &&
			(write.value.state.status === "completing" || write.value.state.status === "terminal") &&
			write.value.state.outcome.status === "completed",
	);
	if (terminal && mode === "before") {
		writeFileSync(ready, "before");
		await new Promise(() => {});
	}
	const sequence = await commit(writes, commitContext);
	if (terminal && mode === "after") {
		writeFileSync(ready, "after");
		await new Promise(() => {});
	}
	return sequence;
};
const harness = await openHarness(storage, { models: fake.models, registry });
const root = await harness.root(context);
const revision = "base..head";
const existing = (await harness.snapshot(DecisionDocument, root.id, context))?.decisions[revision]?.triage;
const id =
	existing?.task ??
	(await root.commit(async (tx) => {
		const input = {
			root: root.id,
			revision,
			key: JSON.stringify({ decider: decider.name }),
			request: {
				questionSet: { name: "triage", version: "1" },
				state: "change",
				questions: [{ id: "lens", text: "level?", options: ["careful"] }],
			},
		};
		const id = await tx.createTask(decisionTask(decider), input, { ownership: { kind: "conversation" } });
		(await tx.doc(DecisionDocument, root.id)).decisions[revision] = { triage: { task: id, key: input.key } };
		return id;
	}, context));
const stored = await harness.getTask(id as Parameters<typeof harness.waitForTask>[0], context);
if (stored?.state.status !== "terminal")
	await harness.waitForTask(id as Parameters<typeof harness.waitForTask>[0], context);
writeFileSync(output, JSON.stringify((await TelemetryReader.open(storage).read(revision)).toJSON()));
await harness.close(context);
clearTimeout(watchdog);
