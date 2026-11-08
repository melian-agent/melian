// Copy to 33138ec's root; pass the output directory.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, Lens, ReviewPlan } from "./packages/core/src/index.ts";
import { AdjudicationTask, adjudicationInput, VerdictDocument } from "./packages/pipeline/src/adjudication.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
	planInputs,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import { RoundsDocument, RoundWriter } from "./packages/pipeline/src/rounds.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";

const directory = process.argv[2];
const path = join(directory, "lens-routes-v13.sqlite");
const fake = createFakeModels({ models: [{ id: "heavy" }] });
const heavy = `${fake.ref("heavy").provider}/heavy`;
const { catalog, credentials } = await planInputs(fake.review);
const config = { ...defaultConfig, models: { heavy: { model: heavy, thinking: "high" } } };
const plan = ReviewPlan.resolve({
	config,
	routes: { committed: config.models, overridden: {}, lensTiers: {}, retiered: {} },
	catalog,
	credentials,
	lenses: await Lens.builtins(),
	checks: ["lens.correctness"],
});
const harness = await openHarness(await openSqliteStorage(path), {
	models: fake.models,
	registry: createReviewRegistry(),
});
try {
	const root = await harness.root(context);
	const input = adjudicationInput({
		root: root.id,
		repoRoot: process.cwd(),
		base: "b".repeat(40),
		head: "c".repeat(40),
		policy: undefined,
		config: defaultConfig,
		manifest: ["lens.correctness"],
		checks: [{ name: "lens.correctness", status: "ran", level: "careful" }],
		findingsVersion: 0,
		allowSkip: [],
		producers: [],
		origin: { kind: "range" },
		lenses: ["correctness@v@careful"],
		plan,
	});
	const key = `${input.base}..${input.head}`;
	const task = await root.commit(async (tx) => {
		const task = await tx.createTask(AdjudicationTask, input, { ownership: { kind: "conversation" } });
		(await tx.doc(ReviewIndex, root.id)).reviews[key] = {
			lenses: [],
			adjudication: { task, input: JSON.stringify(input) },
		};
		await new RoundWriter(tx, root.id).mint(key, task, "2026-11-08T00:00:00Z");
		return task;
	}, context);
	const outcome = await harness.waitForTask(task, context);
	if (outcome.state.outcome.status !== "completed" || outcome.state.outcome.result !== "recorded")
		throw new Error("the capture adjudication did not record its verdict");
	const stored = await harness.getTask(task, context);
	writeFileSync(
		join(directory, "recorded.json"),
		`${JSON.stringify(
			{
				commit: "33138ec",
				revision: key,
				versions: {
					verdicts: VerdictDocument.definition.version,
					rounds: RoundsDocument.definition.version,
					adjudication: AdjudicationTask.definition.version,
				},
				task: {
					kind: "melian.adjudication",
					version: stored.version,
					input: stored.input,
					initial: AdjudicationTask.definition.initial(stored.input),
				},
				verdicts: await harness.snapshot(VerdictDocument, root.id, context),
				rounds: await harness.snapshot(RoundsDocument, root.id, context),
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await harness.close(context);
}
