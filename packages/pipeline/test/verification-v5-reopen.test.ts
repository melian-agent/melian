import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import { expect, it } from "vitest";
import {
	backgroundContext as context,
	createRegistry,
	defineExtension,
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
	readFileSync(new URL("./fixtures/verification-v4-main/v4.json", import.meta.url), "utf8"),
) as {
	repoRoot: string;
	task: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject };
};

const older = (version: number) =>
	defineTask<JsonObject, { phase: string } & JsonObject, null>({
		name: "melian.verification",
		version,
		initial: () => recorded.task.initial,
		abort: async () => {
			throw new Error("an older build must not abort this task");
		},
		phases: {
			[recorded.task.initial.phase]: async () => {
				throw new Error("an older build must not run this task");
			},
		},
	});

async function scenario(run: (input: JsonObject, revision: string, file: string) => Promise<void>) {
	const repo = crashRepository();
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-verification-v5-")));
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const old = recorded.task.input.revision as { base: string; head: string };
		const input = JSON.parse(
			JSON.stringify(recorded.task.input)
				.replaceAll(recorded.repoRoot, repo)
				.replaceAll(old.base, changeset.revision.base)
				.replaceAll(old.head, changeset.revision.head),
		) as JsonObject;
		await run(input, `${changeset.revision.base}..${changeset.revision.head}`, join(directory, "state.sqlite"));
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(directory, { recursive: true, force: true });
	}
}

it("reopens main's version-4 verification task under version 5, its bare fallback at the candidate's level", async () => {
	expect(recorded.task).toMatchObject({ kind: "melian.verification", version: 4 });
	await scenario(async (input, revision, file) => {
		const fake = createFakeModels({ models: [{ id: "judge-unavailable" }, { id: "judge" }] });
		const asked: [string, unknown][] = [];
		fake.provider.setResponses(
			Array.from({ length: 4 }, () => (_request, options, _state, model) => {
				asked.push([model.id, options?.reasoning]);
				return model.id === "judge-unavailable"
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit exceeded" })
					: fauxAssistantMessage("Done.");
			}),
		);
		const first = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createRegistry(),
		});
		const root = await first.root(context);
		const id = await root.commit(async (tx) => {
			const task = await tx.createTask(older(4), input, { ownership: { kind: "conversation" } });
			(await tx.doc(ReviewIndex, root.id)).reviews[revision] = {
				task,
				lenses: [],
				verification: { task, input: "old" },
			};
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
			expect(await second.getTask(id, context)).toMatchObject({
				version: 5,
				input,
				state: { status: "terminal", outcome: { status: "completed" } },
			});
			expect(asked).toEqual([
				["judge-unavailable", "low"],
				["judge", "low"],
			]);
		} finally {
			await second.close(context);
		}
	});
});

it("leaves a version-5 verification task to a build that knows version 5", async () => {
	await scenario(async (input, _revision, file) => {
		const fake = createFakeModels();
		const first = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createRegistry(),
		});
		const root = await first.root(context);
		const id = await root.commit(
			(tx) =>
				tx.createTask(createReviewRegistry().snapshot().task("melian.verification") as never, input, {
					ownership: { kind: "conversation" },
				}),
			context,
		);
		await first.close(context);
		const registry = createRegistry();
		registry.install(defineExtension({ name: "melian.verification", tasks: [older(4)] }));
		const second = await openHarness(await openSqliteStorage(file), { models: fake.models, registry });
		try {
			const states = (await second.inspect(context)).tasks
				.filter((each) => each.record.id === id)
				.map((each) => each.state);
			expect(states).toEqual([{ kind: "blocked", reason: "task_too_old" }]);
			expect(fake.provider.state.callCount).toBe(0);
		} finally {
			await second.close(context);
		}
	});
});
