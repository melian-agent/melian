import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import { expect, it } from "vitest";
import {
	backgroundContext as context,
	createRegistry,
	defineTask,
	type JsonObject,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { createReviewRegistry } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { createFakeModels, fauxAssistantMessage } from "../src/testing.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

const recorded = JSON.parse(
	readFileSync(new URL("./fixtures/verification-v2/recorded.json", import.meta.url), "utf8"),
) as {
	repoRoot: string;
	tasks: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject }[];
};

it("reopens main's version-2 verification task under version 3, asking for every candidate", async () => {
	const [previous] = recorded.tasks;
	expect(previous).toMatchObject({ kind: "melian.verification", version: 2 });
	const repo = crashRepository();
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-verification-v2-")));
	const file = join(directory, "state.sqlite");
	const changeset = await Changeset.resolve(repo, "main...feature");
	const old = previous!.input.revision as { base: string; head: string };
	const input = JSON.parse(
		JSON.stringify(previous!.input)
			.replaceAll(recorded.repoRoot, repo)
			.replaceAll(old.base, changeset.revision.base)
			.replaceAll(old.head, changeset.revision.head),
	) as JsonObject;
	const revision = `${changeset.revision.base}..${changeset.revision.head}`;
	const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
	const asked: unknown[] = [];
	fake.provider.setResponses(
		Array.from({ length: 4 }, () => (request: unknown) => {
			asked.push(request);
			return fauxAssistantMessage("Done.");
		}),
	);
	try {
		const first = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createRegistry(),
		});
		const root = await first.root(context);
		const token = defineTask<JsonObject, { phase: string } & JsonObject, null>({
			name: previous!.kind,
			version: previous!.version,
			initial: () => previous!.initial,
			abort: async (_task, runtime, abortContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
			phases: {
				[previous!.initial.phase]: async () => {
					throw new Error("old definition must not execute");
				},
			},
		});
		const id = await root.commit(async (tx) => {
			const task = await tx.createTask(token, input, { ownership: { kind: "conversation" } });
			(await tx.doc(ReviewIndex, root.id)).reviews[revision] = { lenses: [], verification: { task, input: "old" } };
			return task;
		}, context);
		await first.close(context);
		const second = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		try {
			second.resume();
			await second.waitForTask(id, context);
			const migrated = await second.getTask(id, context);
			expect(migrated).toMatchObject({ version: 3, input, state: { status: "terminal" } });
			expect(migrated!.input).not.toHaveProperty("reused");
			// No outcome is reused from a task that has none, so its one candidate asks the model.
			expect(asked).toHaveLength(1);
			const result = (migrated!.state as unknown as { outcome: { status: string; result: Record<string, unknown> } })
				.outcome;
			expect(result.status).toBe("completed");
			expect(Object.keys(result.result)).toEqual(
				(previous!.input.candidates as { key: string }[]).map((candidate) => candidate.key),
			);
		} finally {
			await second.close(context);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(directory, { recursive: true, force: true });
	}
});
