import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubProvider } from "@melian-agent/github";
import { expect, it } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { pullRequestState } from "../../github/test/fixtures/scenario.ts";
import {
	backgroundContext as context,
	createRegistry,
	defineTask,
	type JsonObject,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { openPublishHarness } from "../src/publish.ts";
import { createFakeModels } from "../src/testing.ts";

// Written by main at 460f68f0, before a publish input could carry a run; the fixture's README says how.
const recorded = JSON.parse(
	readFileSync(new URL("./fixtures/quiet-output-main/recorded.json", import.meta.url), "utf8"),
) as { tasks: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject }[] };

it("reopens main's version-6 publish input as version 7, unchanged and with no run", async () => {
	const previous = recorded.tasks.find((task) => task.kind === "melian.publish")!;
	expect(previous.version).toBe(6);
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-publish-run-")));
	const file = join(directory, "state.sqlite");
	const fake = createFakeModels();
	try {
		const first = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createRegistry(),
		});
		const token = defineTask<JsonObject, { phase: string } & JsonObject, null>({
			name: "melian.publish",
			version: 6,
			initial: () => previous.initial,
			abort: async (_task, runtime, abortContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
			phases: {
				publish: async () => {
					throw new Error("old definition must not execute");
				},
			},
		});
		const id = await (await first.root(context)).commit(
			(tx) => tx.createTask(token, previous.input, { ownership: { kind: "conversation" } }),
			context,
		);
		await first.close(context);
		const state = pullRequestState();
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		const second = await openPublishHarness(await openSqliteStorage(file), fake.review, provider);
		try {
			second.harness.resume();
			await second.harness.waitForTask(id, context);
			const migrated = await second.harness.getTask(id, context);
			expect(migrated).toMatchObject({ version: 7, input: previous.input });
			expect(migrated!.input).not.toHaveProperty("run");
			expect(state.reviews).toEqual([]);
		} finally {
			await second.close(context);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
