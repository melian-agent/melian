// Copy to 0b3a0c4b's root; pass the output directory and the rounds-head-only fixture directory.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "./packages/core/src/index.ts";
import { AdjudicationTask, adjudicationInput } from "./packages/pipeline/src/adjudication.ts";
import { lightTriage } from "./packages/pipeline/src/caveats.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import { legacyKey, RoundsDocument, RoundWriter } from "./packages/pipeline/src/rounds.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";

const directory = process.argv[2];
const source = process.argv[3];
const headOnly = JSON.parse(readFileSync(join(source, "recorded.json"), "utf8")).key;
const path = join(directory, "rounds-v2.sqlite");
copyFileSync(join(source, "rounds-v1.sqlite"), path);
const fake = createFakeModels();
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
		manifest: ["lens.correctness", "lens.contracts"],
		checks: [
			{ name: "lens.correctness", status: "ran", reason: "Callers unavailable: graph absent" },
			{ name: "lens.contracts", status: "skipped", reason: lightTriage, caveats: [lightTriage] },
		],
		findingsVersion: 0,
		allowSkip: [],
		producers: [],
		origin: { kind: "range" },
		lenses: [],
	});
	const key = `${input.base}..${input.head}`;
	const task = await root.commit(async (tx) => {
		const task = await tx.createTask(AdjudicationTask, input, { ownership: { kind: "conversation" } });
		(await tx.doc(ReviewIndex, root.id)).reviews[key] = {
			lenses: [],
			adjudication: { task, input: JSON.stringify(input) },
		};
		await new RoundWriter(tx, root.id).mint(key, task, "2026-11-04T00:00:00Z");
		return task;
	}, context);
	const outcome = await harness.waitForTask(task, context);
	if (outcome.state.outcome.status !== "completed" || outcome.state.outcome.result !== "recorded")
		throw new Error("the capture adjudication did not record its verdict");
	writeFileSync(
		join(directory, "recorded.json"),
		`${JSON.stringify(
			{
				commit: "0b3a0c4ba8cfc30adf84f94afad1d52ba881b742",
				version: RoundsDocument.definition.version,
				headOnly,
				legacyRound: legacyKey(headOnly),
				state: await harness.snapshot(RoundsDocument, root.id, context),
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await harness.close(context);
}
