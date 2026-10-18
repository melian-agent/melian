import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createGitHubProvider } from "@melian-agent/github";
import { type FakeState, fakeGitHub } from "../../../github/test/fixtures/fake-github.ts";
import {
	backgroundContext,
	createRegistry,
	defineTask,
	openHarness,
	openSqliteStorage,
	publishExtension,
} from "../../src/index.ts";
import { createFakeModels } from "../../src/testing.ts";

const [database, stateFile, log] = process.argv.slice(2) as [string, string, string];
const state = JSON.parse(readFileSync(stateFile, "utf8")) as FakeState;
const provider = createGitHubProvider({
	owner: state.owner,
	repo: state.repo,
	token: "test-token",
	fetch: fakeGitHub(state),
});
const extension = publishExtension(provider);
const task = extension.tasks![0]!;
const registry = createRegistry();
registry.install({
	...extension,
	tasks: [
		defineTask({
			name: task.definition.name,
			version: task.definition.version,
			initial: () => ({ phase: "publish" }),
			abort: async () => {},
			phases: {
				publish: async () => {
					appendFileSync(log, "before-verdict\n");
					await sleep(30_000);
					throw new Error("parent did not kill the parked publisher");
				},
			},
		}),
	],
});
const harness = await openHarness(await openSqliteStorage(database), { models: createFakeModels().models, registry });
try {
	await harness.waitForIdle(backgroundContext);
} finally {
	await harness.close(backgroundContext);
}
