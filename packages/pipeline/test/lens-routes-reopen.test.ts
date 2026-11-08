import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewPlan, type StoredPlan } from "@melian-agent/core";
import { afterEach, expect, it } from "vitest";
import { AdjudicationTask, VerdictDocument } from "../src/adjudication.ts";
import {
	backgroundContext as context,
	createRegistry,
	defineTask,
	type JsonObject,
	openHarness,
	openSqliteStorage,
	ROOT_CONVERSATION_ID,
	type Storage,
} from "../src/harness.ts";
import { createReviewRegistry } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { RoundsDocument } from "../src/rounds.ts";
import { createFakeModels } from "../src/testing.ts";

const fixture = new URL("./fixtures/lens-routes-main/", import.meta.url);
const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
	revision: string;
	task: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject };
	verdicts: { provenance: Record<string, { plan: StoredPlan }> };
	rounds: JsonObject;
};

const scratch: string[] = [];
afterEach(() => {
	for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function copied(): string {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-lens-routes-")));
	scratch.push(directory);
	const file = join(directory, "state.sqlite");
	copyFileSync(new URL("lens-routes-v13.sqlite", fixture), file);
	return file;
}

async function versionOf(storage: Storage, kind: string): Promise<number | undefined> {
	const root = await storage.findDocument(
		{ kind, scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } },
		"current",
		context,
	);
	return root === undefined ? undefined : (await storage.document(root.id, "current", context))?.version;
}

it("reopens main's verdicts and rounds twice, reading each stored plan as it did", async () => {
	const file = copied();
	const fake = createFakeModels();
	const plan = recorded.verdicts.provenance[recorded.revision]!.plan;
	expect(plan.lensRoutes).toBeUndefined();
	expect(ReviewPlan.from(plan).lensRoutes).toEqual([]);
	expect(ReviewPlan.from(plan).toJSON()).toEqual(plan);
	for (const [pass, versions] of [
		[0, [13, 3]],
		[1, [14, 4]],
	] as const) {
		const storage = await openSqliteStorage(file);
		const harness = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
		try {
			const root = (await harness.root(context)).id;
			expect([await versionOf(storage, "melian.verdicts"), await versionOf(storage, "melian.rounds")]).toEqual(
				versions,
			);
			expect(await harness.snapshot(VerdictDocument, root, context)).toEqual(recorded.verdicts);
			expect(await harness.snapshot(RoundsDocument, root, context)).toEqual(recorded.rounds);
			if (pass === 0) {
				await harness.commit(async (tx) => {
					await tx.doc(VerdictDocument, root);
					await tx.doc(RoundsDocument, root);
				}, context);
			}
		} finally {
			await harness.close(context);
		}
	}
	expect(fake.provider.state.callCount).toBe(0);
});

it("resumes main's version-6 adjudication input unchanged under the current definition", async () => {
	const file = copied();
	const fake = createFakeModels();
	const first = await openHarness(await openSqliteStorage(file), { models: fake.models, registry: createRegistry() });
	const old = defineTask<JsonObject, { phase: string } & JsonObject, null>({
		name: recorded.task.kind,
		version: recorded.task.version,
		initial: () => recorded.task.initial,
		abort: async (_task, runtime, abortContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
		},
		phases: {
			[recorded.task.initial.phase]: async () => {
				throw new Error("old definition must not execute");
			},
		},
	});
	const root = await first.root(context);
	const id = await root.commit(async (tx) => {
		const task = await tx.createTask(old, recorded.task.input, { ownership: { kind: "conversation" } });
		(await tx.doc(ReviewIndex, root.id)).reviews[recorded.revision] = {
			lenses: [],
			adjudication: { task, input: JSON.stringify(recorded.task.input) },
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
		expect(AdjudicationTask.definition.version).toBe(7);
		expect(await second.getTask(id, context)).toMatchObject({
			version: 7,
			input: recorded.task.input,
			state: { status: "terminal", outcome: { status: "completed", result: "recorded" } },
		});
	} finally {
		await second.close(context);
	}
});
