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
import { TelemetryReader } from "../src/telemetry.ts";
import { createFakeModels, fauxAssistantMessage } from "../src/testing.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

const fixture = new URL("./fixtures/thinking-main/", import.meta.url);
const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
	recordedBy: string;
	revision: string;
	tasks: { kind: string; version: number; input: JsonObject; initial?: { phase: string } & JsonObject }[];
};

it.each([
	["melian.lenses", 5],
	["melian.verification", 2],
	["melian.summarize", 2],
	["melian.adjudication", 5],
	["melian.adjudication", 5, "thinking-policy-v11"],
] as const)(
	"reopens main's versioned %s input with no invented thinking",
	async (kind, version, priorFixture?: "thinking-policy-v11") => {
		const repo = crashRepository();
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-thinking-reopen-")));
		const file = join(directory, "state.sqlite");
		const prior =
			priorFixture === undefined
				? recorded
				: (JSON.parse(
						readFileSync(new URL(`./fixtures/${priorFixture}/recorded.json`, import.meta.url), "utf8"),
					) as typeof recorded);
		const previous = prior.tasks.find((task) => task.kind === kind)!;
		const changeset = await Changeset.resolve(repo, "main...feature");
		const oldRevision = prior.tasks.find((task) => task.kind === "melian.lenses")!.input.revision as {
			repoRoot: string;
			base: string;
			head: string;
		};
		const input = JSON.parse(
			JSON.stringify(previous.input)
				.replaceAll(oldRevision.repoRoot, repo)
				.replaceAll(oldRevision.base, changeset.revision.base)
				.replaceAll(oldRevision.head, changeset.revision.head),
		) as JsonObject;
		const revision = `${changeset.revision.base}..${changeset.revision.head}`;
		const fake = createFakeModels({
			models: ["unavailable", "finder", "judge-unavailable", "judge", "summary"].map((id) => ({ id })),
		});
		const levels: unknown[] = [];
		fake.provider.setResponses(
			Array.from({ length: 8 }, () => (_request, options) => {
				levels.push(options?.reasoning);
				return fauxAssistantMessage("Done.");
			}),
		);
		try {
			const first = await openHarness(await openSqliteStorage(file), {
				models: fake.models,
				registry: createRegistry(),
			});
			const root = await first.root(context);
			const old = defineTask<JsonObject, { phase: string } & JsonObject, null>({
				name: kind,
				version: previous.version,
				initial: () => previous.initial!,
				abort: async (_task, runtime, abortContext) => {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
				},
				phases: {
					[previous.initial!.phase]: async () => {
						throw new Error("old definition must not execute");
					},
				},
			});
			const id = await root.commit(async (tx) => {
				const task = await tx.createTask(old, input, { ownership: { kind: "conversation" } });
				(await tx.doc(ReviewIndex, root.id)).reviews[revision] = {
					task,
					lenses: [],
					adjudication: { task, input: "old" },
					verification: { task, input: "old" },
				};
				return task;
			}, context);
			await first.close(context);
			const storage = await openSqliteStorage(file);
			const second = await openHarness(storage, {
				models: fake.models,
				registry: createReviewRegistry(),
				settings: { retry: { enabled: false } },
			});
			try {
				second.resume();
				await second.waitForTask(id, context);
				const migrated = await second.getTask(id, context);
				expect(migrated).toMatchObject({
					version,
					input,
					state: { status: "terminal", outcome: { status: "completed" } },
				});
				expect(JSON.stringify(migrated!.input)).not.toContain(
					priorFixture === undefined ? '"thinking"' : '"thinkingOverride"',
				);
				if (kind !== "melian.adjudication") expect(levels.length).toBeGreaterThan(0);
				expect(levels.every((level) => level === undefined)).toBe(true);
				if (kind === "melian.adjudication") {
					const telemetry = await TelemetryReader.open(storage).read(revision);
					expect(telemetry.stages.find((stage) => stage.name === kind)?.timing).toBe("available");
				}
			} finally {
				await second.close(context);
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

it.each(["thinking-main", "thinking-policy-v11"])(
	"reopens %s verdict database twice, retaining provenance without inventing overrides",
	async (priorFixture) => {
		const fixture = new URL(`./fixtures/${priorFixture}/`, import.meta.url);
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-thinking-verdict-")));
		const file = join(directory, "state.sqlite");
		copyFileSync(new URL(priorFixture === "thinking-main" ? "main.sqlite" : "previous.sqlite", fixture), file);
		const fake = createFakeModels();
		try {
			const first = await openHarness(await openSqliteStorage(file), {
				models: fake.models,
				registry: createRegistry(),
			});
			const root = await first.root(context);
			const old = defineDoc<JsonObject>({
				kind: "melian.verdicts",
				version: priorFixture === "thinking-main" ? 10 : 11,
				scope: "conversation",
				history: "rewindable",
				fork: "asOf",
				initial: () => ({}),
			});
			const previous = await first.snapshot(old, root.id, context);
			await first.close(context);
			for (let pass = 0; pass < 2; pass++) {
				const storage = await openSqliteStorage(file);
				const opened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
				try {
					expect(await opened.snapshot(VerdictDocument, root.id, context)).toEqual(previous);
					await opened.commit(async (tx) => {
						await tx.doc(VerdictDocument, root.id);
					}, context);
					const document = await storage.findDocument(
						{ kind: "melian.verdicts", scope: { kind: "conversation", conversationId: root.id } },
						"current",
						context,
					);
					expect((await storage.document(document!.id, "current", context))!.version).toBe(12);
				} finally {
					await opened.close(context);
				}
			}
			expect(fake.provider.state.callCount).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
