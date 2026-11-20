// Copy this file to the root of the a69fac993 source tree before running it, and pass an absolute output directory.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig } from "./packages/core/src/index.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";
import { baseAndHead, gitIn } from "./packages/pipeline/test/fixtures/repo.ts";

const out = process.argv[2];
const repo = baseAndHead({ "a.ts": "export const n = 1;\n" }, { "a.ts": "export const n = 2;\n" });
const fake = createFakeModels();
const changeset = await Changeset.resolve(repo, "main...feature");
const key = `${changeset.revision.base}..${changeset.revision.head}`;
const harness = await openHarness(await openSqliteStorage(join(out, "decided.sqlite")), {
	models: fake.models,
	registry: createReviewRegistry(),
});
const root = await harness.root(context, { agent: { model: fake.ref() } });
await reviewChangeset({
	harness,
	changeset,
	config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
	lenses: [],
	standards: [],
	models: fake.review,
	checks: [{ name: "static.mutation", status: "ran" }],
});
const adjudication = (await harness.snapshot(ReviewIndex, root.id, context)).reviews[key].adjudication;
await harness.close(context);
gitIn(repo, "bundle", "create", join(out, "repo.bundle"), "--all");
writeFileSync(
	join(out, "recorded.json"),
	`${JSON.stringify({ commit: "a69fac993", changeset: changeset.id, key, adjudication }, null, 2)}\n`,
);
