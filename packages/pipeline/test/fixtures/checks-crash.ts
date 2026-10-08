// Runs the mutation check for a trusted writer in its own process and parks inside Stryker; the parent test kills it with SIGKILL.
import { appendFileSync } from "node:fs";
import { Changeset, loadConfig, type RepositorySource } from "@melian-agent/core";
import {
	backgroundContext,
	checksExtension,
	createNodeExecutionEnv,
	createReviewRegistry,
	type ExecutionEnv,
	openHarness,
	openSqliteStorage,
	runChecks,
} from "../../src/index.ts";
import { MutationProcess } from "../../src/mutation-process.ts";
import { Sandbox } from "../../src/sandbox.ts";
import { createFakeModels } from "../../src/testing.ts";
import { unconfinedSandbox } from "./sandbox.ts";

const [repo, base, head, database, log] = process.argv.slice(2) as [string, string, string, string, string];
Object.defineProperty(Sandbox, "detect", { value: () => unconfinedSandbox });
MutationProcess.prototype.execute = async () => {
	appendFileSync(log, "parked\n");
	return new Promise(() => setInterval(() => {}, 1000));
};
const env = createNodeExecutionEnv(repo);
const parking: ExecutionEnv = Object.create(env);
parking.exec = (command, options, context) => {
	if (!command.includes("--reporters json")) return env.exec(command, options, context);
	appendFileSync(log, "parked\n");
	// A timer keeps the process alive while it waits to be killed.
	return new Promise(() => setInterval(() => {}, 1000));
};
const fake = createFakeModels();
const registry = createReviewRegistry();
registry.install(checksExtension);
const harness = await openHarness(await openSqliteStorage(database), {
	models: fake.models,
	registry,
	env: () => parking,
});
const root = await harness.root(backgroundContext, { agent: { model: fake.ref() } });
const source: RepositorySource = { kind: "revision", commit: base };
const { config } = await loadConfig(repo, source, "");
await runChecks(
	harness,
	{
		rootConversationId: root.id,
		changeset: await Changeset.resolve(repo, `${base}..${head}`),
		config,
		source,
		tier: "full",
		writer: { trusted: true },
	},
	backgroundContext,
);
