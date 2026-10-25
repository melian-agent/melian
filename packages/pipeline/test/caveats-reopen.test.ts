import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import { expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	defineTask,
	type JsonObject,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { createReviewRegistry } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { createFakeModels, fauxAssistantMessage } from "../src/testing.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

// Written by main at 460f68f0 before caveats existed; the README says how.
const fixture = new URL("./fixtures/quiet-output-main/", import.meta.url);
const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
	tasks: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject }[];
};

it.each([
	["melian.lenses", 4, 5],
	["melian.adjudication", 5, 6],
] as const)("reopens main's version-%s %s input unchanged, with no caveat", async (kind, from, to) => {
	const repo = crashRepository();
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-caveats-reopen-")));
	const file = join(directory, "state.sqlite");
	const previous = recorded.tasks.find((task) => task.kind === kind)!;
	expect(previous.version).toBe(from);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const old = recorded.tasks.find((task) => task.kind === "melian.lenses")!.input.revision as {
		repoRoot: string;
		base: string;
		head: string;
	};
	const input = JSON.parse(
		JSON.stringify(previous.input)
			.replaceAll(old.repoRoot, repo)
			.replaceAll(old.base, changeset.revision.base)
			.replaceAll(old.head, changeset.revision.head),
	) as JsonObject;
	const fake = createFakeModels({ models: [{ id: "scripted" }] });
	fake.provider.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Done.")));
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
		const id = await root.commit(
			(tx) => tx.createTask(token, input, { ownership: { kind: "conversation" } }),
			context,
		);
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
			expect(migrated).toMatchObject({ version: to, input });
			expect(JSON.stringify(migrated!.input)).not.toContain("caveat");
		} finally {
			await second.close(context);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(directory, { recursive: true, force: true });
	}
});

it.each([
	["melian.reviews", 3, 4],
	["melian.verdicts", 12, 13],
] as const)("reopens main's version-%s %s document twice, unchanged", async (kind, from, to) => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-caveats-doc-")));
	const file = join(directory, "state.sqlite");
	copyFileSync(new URL("previous.sqlite", fixture), file);
	const fake = createFakeModels();
	try {
		const first = await openHarness(await openSqliteStorage(file), {
			models: fake.models,
			registry: createRegistry(),
		});
		const root = await first.root(context);
		const old =
			kind === "melian.verdicts"
				? defineDoc<JsonObject>({
						kind,
						version: from,
						scope: "conversation",
						history: "rewindable",
						fork: "asOf",
						initial: () => ({}),
					})
				: defineDoc<JsonObject>({
						kind,
						version: from,
						scope: "conversation",
						history: "latest",
						fork: "current",
						initial: () => ({}),
					});
		const previous = await first.snapshot(old, root.id, context);
		expect(JSON.stringify(previous)).not.toContain("caveat");
		await first.close(context);
		for (let pass = 0; pass < 2; pass++) {
			const storage = await openSqliteStorage(file);
			const opened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
			try {
				const snapshot =
					kind === "melian.verdicts"
						? await opened.snapshot(VerdictDocument, root.id, context)
						: await opened.snapshot(ReviewIndex, root.id, context);
				expect(snapshot).toEqual(previous);
				await opened.commit(async (tx) => {
					if (kind === "melian.verdicts") await tx.doc(VerdictDocument, root.id);
					else await tx.doc(ReviewIndex, root.id);
				}, context);
				const document = await storage.findDocument(
					{ kind, scope: { kind: "conversation", conversationId: root.id } },
					"current",
					context,
				);
				expect((await storage.document(document!.id, "current", context))!.version).toBe(to);
			} finally {
				await opened.close(context);
			}
		}
		expect(fake.provider.state.callCount).toBe(0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
