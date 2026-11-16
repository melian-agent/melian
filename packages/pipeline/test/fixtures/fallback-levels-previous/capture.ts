// Copy to the recording commit's root and pass the output file. Records the melian.lenses task input that commit's own
// code stores for a heavy route of a first model that fails and one bare fallback, at thinking low.
import { writeFileSync } from "node:fs";
import { Changeset, defaultConfig, Lens } from "./packages/core/src/index.ts";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	openHarness,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import { createFakeModels, fauxAssistantMessage } from "./packages/pipeline/src/testing.ts";
import { gitIn } from "./packages/pipeline/test/fixtures/repo.ts";
import { crashRepository } from "./packages/pipeline/test/fixtures/review-scenario.ts";

const repo = crashRepository();
const fake = createFakeModels({ models: [{ id: "unavailable" }, { id: "finder" }] });
fake.provider.setResponses(
	Array.from({ length: 8 }, () => (_request, _options, _state, model) =>
		model.id === "unavailable"
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit exceeded" })
			: fauxAssistantMessage("Done."),
	),
);
const registry = createReviewRegistry();
const harness = await openHarness(createMemoryStorage(), {
	models: fake.models,
	registry,
	settings: { retry: { enabled: false } },
});
const root = await harness.root(context, { agent: { model: fake.ref("finder") } });
const changeset = await Changeset.resolve(repo, "main...feature");
const lenses = (
	await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"])
).filter((lens) => lens.name === "correctness");
await reviewChangeset({
	harness,
	checks: [],
	changeset,
	lenses,
	standards: [],
	models: fake.review,
	config: {
		...defaultConfig,
		tiers: { full: ["lens.correctness"] },
		stages: { "pull-request": "full" },
		models: { heavy: { model: "faux/unavailable", thinking: "low", fallbacks: ["faux/finder"] } },
	},
});
const [revision, indexed] = Object.entries((await harness.snapshot(ReviewIndex, root.id, context))!.reviews)[0]!;
const definitions = registry.snapshot();
const task = (await harness.getTask(indexed.task as never, context))!;
const definition = definitions.task(task.kind)! as unknown as { definition: { initial: (input: unknown) => unknown } };
writeFileSync(
	process.argv[2]!,
	`${JSON.stringify(
		{
			recordedBy: gitIn(process.cwd(), "rev-parse", "--short=8", "HEAD"),
			revision,
			repoRoot: changeset.repoRoot,
			task: { kind: task.kind, version: task.version, input: task.input, initial: definition.definition.initial(task.input), state: task.state },
		},
		null,
		"\t",
	)}\n`,
);
await harness.close(context);
