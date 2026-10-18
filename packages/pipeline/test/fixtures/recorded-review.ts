import type { ReviewProvider } from "@melian-agent/core";
import { FindingsDocument } from "../../src/findings.ts";
import {
	type Context,
	type ConversationId,
	backgroundContext as context,
	createRegistry,
	defineTask,
	type Harness,
	openHarness,
	type Storage,
} from "../../src/harness.ts";
import { modelsOf, type ReviewModels } from "../../src/models.ts";
import { publishExtension } from "../../src/publish.ts";
import { ReviewIndex } from "../../src/review-index.ts";

export const recordedReviewTask = defineTask<
	{ root: ConversationId; revision: string; findingsVersion: number },
	{ phase: "record" },
	"recorded"
>({
	name: "test.recorded-review",
	version: 1,
	initial: () => ({ phase: "record" }),
	phases: {
		record: async (task, runtime, context) => {
			const { root, revision, findingsVersion } = task.input;
			await runtime.commit(async (tx) => {
				(await tx.doc(ReviewIndex, root)).reviews[revision] = {
					lenses: [],
					adjudication: { task: task.id, input: JSON.stringify({ findingsVersion }) },
				};
				return { status: "terminal", outcome: { status: "completed", result: "recorded" } };
			}, context);
		},
	},
	abort: async () => {},
});

export class RecordedReview {
	readonly harness: Harness;

	constructor(harness: Harness) {
		this.harness = harness;
	}

	static async open(storage: Storage, models: ReviewModels, provider: ReviewProvider): Promise<RecordedReview> {
		const registry = createRegistry();
		registry.install(publishExtension(provider));
		registry.install({ name: "test.recorded-review", tasks: [recordedReviewTask] });
		return new RecordedReview(await openHarness(storage, { models: modelsOf(models), registry }));
	}

	async record(revision: string): Promise<void> {
		const root = await this.harness.root(context);
		const findingsVersion =
			(await this.harness.snapshot(FindingsDocument, root.id, context))?.versions[revision] ?? 0;
		const task = await root.commit(
			(tx) =>
				tx.createTask(
					recordedReviewTask,
					{ root: root.id, revision, findingsVersion },
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		await this.harness.waitForTask(task, context);
	}

	close(context: Context): Promise<void> {
		return this.harness.close(context);
	}
}
