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
	readFileSync(new URL("./fixtures/probing-previous/recorded.json", import.meta.url), "utf8"),
) as {
	repoRoot: string;
	tasks: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject }[];
};

// Main's verification input carries its wave's judgement in `reused`, so it asks no model again.
it.each([
	["melian.lenses", 5, 6, true],
	["melian.verification", 3, 4, false],
] as const)(
	"reopens main's %s task from version %s under version %s, with no probing invented",
	async (kind, from, to, asks) => {
		const previous = recorded.tasks.find((task) => task.kind === kind)!;
		expect(previous.version).toBe(from);
		const repo = crashRepository();
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-probing-reopen-")));
		const file = join(directory, "state.sqlite");
		const changeset = await Changeset.resolve(repo, "main...feature");
		const old = recorded.tasks.find((task) => task.kind === "melian.lenses")!.input.revision as {
			base: string;
			head: string;
		};
		const input = JSON.parse(
			JSON.stringify(previous.input)
				.replaceAll(recorded.repoRoot, repo)
				.replaceAll(old.base, changeset.revision.base)
				.replaceAll(old.head, changeset.revision.head),
		) as JsonObject;
		const revision = `${changeset.revision.base}..${changeset.revision.head}`;
		const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
		let asked = 0;
		fake.provider.setResponses(
			Array.from({ length: 8 }, () => () => {
				asked += 1;
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
				name: kind,
				version: from,
				initial: () => previous.initial,
				abort: async (_task, runtime, abortContext) => {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
				},
				phases: {
					[previous.initial.phase]: async () => {
						throw new Error("old definition must not execute");
					},
				},
			});
			const id = await root.commit(async (tx) => {
				const task = await tx.createTask(token, input, { ownership: { kind: "conversation" } });
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
				const migrated = await second.getTask(id, context);
				expect(migrated).toMatchObject({
					version: to,
					input,
					state: { status: "terminal", outcome: { status: "completed" } },
				});
				expect(JSON.stringify(migrated!.input)).not.toContain('"probe"');
				expect(asked > 0).toBe(asks);
			} finally {
				await second.close(context);
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
