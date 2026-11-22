# Main's version-15 verdict document

Recorded by main at `2304de2a`, before a check's lineage could name the level its model answered at. The script below was saved as `capture-v15.ts` at the root of a worktree of that commit, with its own `npm ci --ignore-scripts`, and run as `node --conditions=@melian-agent/source capture-v15.ts <this directory>`. Main's own `reviewChangeset` reviewed one change into a SQLite store on a fake model, so main's adjudication wrote the verdict document. No stored shape was assembled by hand.

`previous.sqlite` is the closed store. `recorded.json` holds the revision key, the root conversation and the verdict document as main read it back. `test/verdicts-v16-reopen.test.ts` reopens it unchanged, writes a lineage that names `answeredAt`, and checks that a version-15 reader then refuses the store.

```ts
// Copy to the recording commit's root and pass the output directory. Reviews one change into a SQLite store and
// records the verdict document that commit's own code wrote.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens } from "./packages/core/src/index.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import { VerdictDocument } from "./packages/pipeline/src/adjudication.ts";
import { createFakeModels, fauxAssistantMessage } from "./packages/pipeline/src/testing.ts";
import { gitIn } from "./packages/pipeline/test/fixtures/repo.ts";
import { crashRepository } from "./packages/pipeline/test/fixtures/review-scenario.ts";

const directory = process.argv[2]!;
const repo = crashRepository();
const fake = createFakeModels({ models: [{ id: "finder" }] });
fake.provider.setResponses(Array.from({ length: 8 }, () => () => fauxAssistantMessage("Done.")));
const harness = await openHarness(await openSqliteStorage(join(directory, "previous.sqlite")), {
	models: fake.models,
	registry: createReviewRegistry(),
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
		models: { heavy: { model: "faux/finder" } },
	},
});
const document = (await harness.snapshot(VerdictDocument, root.id, context))!;
writeFileSync(
	join(directory, "recorded.json"),
	`${JSON.stringify({ recordedBy: gitIn(process.cwd(), "rev-parse", "--short=8", "HEAD"), revision: Object.keys(document.verdicts)[0], root: root.id, document }, null, "\t")}\n`,
);
await harness.close(context);
```
