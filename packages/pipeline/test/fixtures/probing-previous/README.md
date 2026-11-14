# Main's version-5 lens task and version-3 verification task

`recorded.json` holds the `melian.lenses` and `melian.verification` task inputs that main's code at `572cfa77`, the merge base of pull request #296, stored for one reviewed null dereference, with fake finder and verifier models, read back through `Harness.getTask`. Each `initial` checkpoint comes from that version's registered task definition's `initial(input)` factory, read through the review registry's snapshot.

The script below wrote it, saved at the root of a worktree of `572cfa77` with its own `npm ci --ignore-scripts`, and run as `node --conditions=@melian-agent/source record.ts recorded.json`. Every package it imports is that commit's own, so the recorded shapes are main's.

```ts
// Records main's version-5 melian.lenses and version-3 melian.verification task inputs, for the reopen tests of
// versions 6 and 4.
import { writeFileSync } from "node:fs";
import { Changeset, defaultConfig, Lens } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	openHarness,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
} from "./packages/pipeline/src/testing.ts";
import { verifierMarker } from "./packages/pipeline/src/verification-instructions.ts";
import { gitIn } from "./packages/pipeline/test/fixtures/repo.ts";
import { crashFinding, crashRepository } from "./packages/pipeline/test/fixtures/review-scenario.ts";

const repo = crashRepository();
const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
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
scriptConversations(fake, [
	{
		match: lenses[0]!.instructions,
		replies: [
			fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		],
	},
	{ match: verifierMarker, replies: [(messages) => scriptVerifier(messages), (messages) => scriptVerifier(messages)] },
]);
const finder = fake.ref("finder");
const judge = fake.ref("judge");
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
		models: {
			heavy: { model: `${finder.provider}/${finder.modelId}` },
			verifier: { model: `${judge.provider}/${judge.modelId}` },
		},
	},
});
const [revision, indexed] = Object.entries((await harness.snapshot(ReviewIndex, root.id, context))!.reviews)[0]!;
const definitions = registry.snapshot();
const tasks = [];
for (const id of [indexed.task, indexed.verification!.task]) {
	const task = (await harness.getTask(id as never, context))!;
	const definition = definitions.task(task.kind)! as unknown as { definition: { initial: (input: unknown) => unknown } };
	tasks.push({ kind: task.kind, version: task.version, input: task.input, initial: definition.definition.initial(task.input) });
}
writeFileSync(
	process.argv[2]!,
	`${JSON.stringify({ recordedBy: gitIn(process.cwd(), "rev-parse", "--short=8", "HEAD"), revision, repoRoot: changeset.repoRoot, tasks }, null, "\t")}\n`,
);
await harness.close(context);
```

`test/probing-reopen.test.ts` stores each input under a token of its recorded version and reopens it under the current definition.
