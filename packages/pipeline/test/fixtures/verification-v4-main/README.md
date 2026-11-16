# A version-4 verification task input, for the version-5 reopen

`v4.json` is the first verification wave's task, recorded by main at `2fae681a`, which stores version 4, before [issue #489](https://github.com/melian-agent/melian/issues/489). The script below was saved as `capture.ts` at the root of a worktree of that commit, with its own `npm ci --ignore-scripts`, and run as `node --conditions=@melian-agent/source capture.ts <file>`. That commit's own `reviewChangeset` stored the task, on fake models; the final verification task reused the wave's outcome and asked no model, so the wave's task is the one recorded, and `Harness.getTask` read it back. No stored shape was assembled by hand.

The review routes the verifier to a first model that fails and one bare fallback, at `thinking: low`, so the stored candidate's route holds two models and names no level of its own. `test/verification-v5-reopen.test.ts` creates the input under a version-4 token, reopens it under the current definition, and expects the fallback asked at `low`, the candidate's level, as version 4 asked it.

```ts
// Copy to the recording commit's root and pass the output file. Records the input of the first verification wave's
// melian.verification task that commit's own code stores for a verifier route of a first model that fails and one bare
// fallback, at thinking low. The final task reuses the wave's outcome and asks no model, so the wave's is recorded.
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
import { VerificationWavesDocument } from "./packages/pipeline/src/verification-waves.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptVerifier,
} from "./packages/pipeline/src/testing.ts";
import { gitIn } from "./packages/pipeline/test/fixtures/repo.ts";
import { crashFinding, crashRepository } from "./packages/pipeline/test/fixtures/review-scenario.ts";

const repo = crashRepository();
const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge-unavailable" }, { id: "judge" }] });
fake.provider.setResponses(
	Array.from({ length: 12 }, () => (request, _options, _state, model) => {
		if (model.id === "judge-unavailable")
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit exceeded" });
		if (model.id === "judge") return scriptVerifier(request.messages);
		return request.messages.some((message) => message.role === "toolResult")
			? fauxAssistantMessage("Done.")
			: fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" });
	}),
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
		models: {
			heavy: { model: "faux/finder", thinking: "low" },
			verifier: { model: "faux/judge-unavailable", thinking: "low", fallbacks: ["faux/judge"] },
		},
	},
});
const [revision] = Object.entries((await harness.snapshot(ReviewIndex, root.id, context))!.reviews)[0]!;
const waves = (await harness.snapshot(VerificationWavesDocument, root.id, context))!.reviews[revision]!.waves;
const definitions = registry.snapshot();
const task = (await harness.getTask(waves[0]!.task as never, context))!;
const definition = definitions.task(task.kind)! as unknown as { definition: { initial: (input: unknown) => unknown } };
writeFileSync(
	process.argv[2]!,
	`${JSON.stringify(
		{
			recordedBy: gitIn(process.cwd(), "rev-parse", "--short=8", "HEAD"),
			revision,
			repoRoot: changeset.repoRoot,
			task: {
				kind: task.kind,
				version: task.version,
				input: task.input,
				initial: definition.definition.initial(task.input),
				state: task.state,
			},
		},
		null,
		"\t",
	)}\n`,
);
await harness.close(context);
```
