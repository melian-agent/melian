# Main's verification keyed by its JSON text

`state.sqlite` is the closed SQLite store main's code at `21765e50` wrote after one reviewed null dereference, with fake finder and verifier models. Its review index records the verification task and its input as the request's JSON text, the key main used before pull request #436 keyed it by a hash. `recorded.json` holds the revision, the root conversation and that index entry as main read them back. `repo.bundle` holds the review's `main` and `feature` commits, so the test can resolve the same revision. No stored field was written by hand.

The script below wrote all three, saved as `record.ts` at the root of a detached worktree of `21765e50` with its own `npm ci --ignore-scripts`, and run with `node --conditions=@melian-agent/source record.ts <output directory>` under `GIT_CONFIG_COUNT=0`. Every package it imports is that commit's own.

```ts
// Records main's store after one reviewed null dereference whose verification is keyed by its request's JSON text.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens } from "@melian-agent/core";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
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

const out = process.argv[2]!;
const repo = crashRepository();
const scratch = mkdtempSync(join(tmpdir(), "melian-record-"));
const file = join(scratch, "state.sqlite");
const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
const harness = await openHarness(await openSqliteStorage(file), {
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
const [revision, indexed] = Object.entries((await harness.snapshot(ReviewIndex, root.id, context))!.reviews)[0]!;
await harness.close(context);
copyFileSync(file, join(out, "state.sqlite"));
execFileSync("git", ["bundle", "create", join(out, "repo.bundle"), "main", "feature"], { cwd: repo, stdio: "ignore" });
writeFileSync(
	join(out, "recorded.json"),
	`${JSON.stringify(
		{
			recordedBy: gitIn(process.cwd(), "rev-parse", "--short=8", "HEAD"),
			root: root.id,
			revision,
			repoRoot: changeset.repoRoot,
			verification: indexed.verification,
		},
		null,
		"\t",
	)}\n`,
);
```

`test/verification-json-key-reopen.test.ts` opens a copy of the store with this build, reviews the same revision again, and expects one verifier conversation and a hashed key in place of the JSON text. Main's key also names the checkout's path and the verifier version, so the test proves a safe reopen and one fresh verification, not which field broke the match.
