# Main's version-2 verification task

`recorded.json` holds the `melian.verification` task input that main's code at `ffb710e5` stored for one reviewed
null dereference, with fake finder and verifier models, read back through `Harness.getTask`. Its `initial` checkpoint
comes from that version's own `initial` factory.

The script below wrote it, saved at the root of a worktree of main whose `node_modules` links to this checkout's, and
run as `node --conditions=@melian-agent/source record.ts recorded.json`. It imports main's pipeline by relative path, so
the recorded shape is main's own; core and the decisions package resolve through `node_modules`, and this change leaves
them alone.

```ts
// Records main's version-2 melian.verification task input, for the reopen test of version 3.
import { writeFileSync } from "node:fs";
import { Changeset, defaultConfig, Lens } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	openHarness,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
} from "./packages/pipeline/src/testing.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import { VerificationTask } from "./packages/pipeline/src/verification.ts";
import { verifierMarker } from "./packages/pipeline/src/verification-instructions.ts";
import { gitIn } from "./packages/pipeline/test/fixtures/repo.ts";
import { crashFinding, crashRepository } from "./packages/pipeline/test/fixtures/review-scenario.ts";

const repo = crashRepository();
const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
const harness = await openHarness(createMemoryStorage(), {
	models: fake.models,
	registry: createReviewRegistry(),
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
const entry = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews;
const [revision, indexed] = Object.entries(entry)[0]!;
const task = (await harness.getTask(indexed.verification!.task as never, context))!;
writeFileSync(
	process.argv[2]!,
	`${JSON.stringify(
		{
			recordedBy: gitIn(process.cwd(), "rev-parse", "--short=8", "HEAD"),
			revision,
			repoRoot: changeset.repoRoot,
			tasks: [
				{
					kind: task.kind,
					version: task.version,
					input: task.input,
					initial: VerificationTask.definition.initial(task.input as never),
				},
			],
		},
		null,
		"\t",
	)}\n`,
);
await harness.close(context);
```

`test/verification-v2-reopen.test.ts` stores that input under a version-2 token and reopens it under the current
definition.
