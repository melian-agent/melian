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

type Recorded = {
	repoRoot: string;
	task: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject };
};

const recorded = (version: number) =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/fallback-levels-previous/v${version}.json`, import.meta.url), "utf8"),
	) as Recorded;

// Each version's own code stored a route whose entries name no level, so its fallback runs at the run's, as it did.
it.each([7, 8])(
	"reopens a version %s lens task under version 9, its bare fallback at the run's level",
	async (from) => {
		const previous = recorded(from).task;
		expect(previous.version).toBe(from);
		const repo = crashRepository();
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-fallback-levels-")));
		const file = join(directory, "state.sqlite");
		const changeset = await Changeset.resolve(repo, "main...feature");
		const old = previous.input.revision as { base: string; head: string };
		const input = JSON.parse(
			JSON.stringify(previous.input)
				.replaceAll(recorded(from).repoRoot, repo)
				.replaceAll(old.base, changeset.revision.base)
				.replaceAll(old.head, changeset.revision.head),
		) as JsonObject;
		const revision = `${changeset.revision.base}..${changeset.revision.head}`;
		const fake = createFakeModels({ models: [{ id: "unavailable" }, { id: "finder" }] });
		const asked: [string, unknown][] = [];
		fake.provider.setResponses(
			Array.from({ length: 8 }, () => (_request, options, _state, model) => {
				asked.push([model.id, options?.reasoning]);
				return model.id === "unavailable"
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit exceeded" })
					: fauxAssistantMessage("Done.");
			}),
		);
		try {
			const first = await openHarness(await openSqliteStorage(file), {
				models: fake.models,
				registry: createRegistry(),
			});
			const root = await first.root(context);
			const token = defineTask<JsonObject, { phase: string } & JsonObject, null>({
				name: previous.kind,
				version: from,
				initial: () => previous.initial,
				phases: {
					[previous.initial.phase]: async () => {
						throw new Error("old definition must not execute");
					},
				},
			});
			const id = await root.commit(async (tx) => {
				const task = await tx.createTask(token, input, { ownership: { kind: "conversation" } });
				(await tx.doc(ReviewIndex, root.id)).reviews[revision] = { task, lenses: [] };
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
					version: 9,
					input,
					state: { status: "terminal", outcome: { status: "completed" } },
				});
				expect(asked).toEqual([
					["unavailable", "low"],
					["finder", "low"],
				]);
			} finally {
				await second.close(context);
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
