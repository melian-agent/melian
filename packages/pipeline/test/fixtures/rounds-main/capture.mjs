// Copy this file to the root of the ac4e8c07 source tree before running it.
import { copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Changeset, defaultConfig, ExternalFinding, Finding } from "./packages/core/src/index.ts";
import { AdjudicationTask } from "./packages/pipeline/src/adjudication.ts";
import {
	CompareHarness,
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
	reviewChangeset,
	upsertFinding,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";
import { baseAndHead, gitIn } from "./packages/pipeline/test/fixtures/repo.ts";

const repo = baseAndHead({ "a.ts": "export const n = 1;\n" }, { "a.ts": "export const n = 2;\n" });
const path = process.argv[2];
const fake = createFakeModels();
const changeset = await Changeset.resolve(repo, "main...feature");
const key = `${changeset.revision.base}..${changeset.revision.head}`;
const finding = Finding.create({
	rule: "static-defect",
	message: "n is wrong",
	file: "a.ts",
	startLine: 1,
	snippet: "export const n = 2;",
	occurrence: 0,
	cause: "introduced",
	severity: "nit",
	explanation: { what: "wrong", whyHere: "here", whatToDo: "fix" },
	source: { check: "static.mutation", version: "1" },
});
let harness = await openHarness(await openSqliteStorage(path), {
	models: fake.models,
	registry: createReviewRegistry(),
});
let root = await harness.root(context, { agent: { model: fake.ref() } });
await root.commit((tx) => upsertFinding(tx, root.id, finding, key), context);
await reviewChangeset({
	harness,
	changeset,
	config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
	lenses: [],
	standards: [],
	models: fake.review,
	checks: [{ name: "static.mutation", status: "ran" }],
});
await harness.close(context);
const comparison = await CompareHarness.open(await openSqliteStorage(path), fake.review);
const external = ExternalFinding.create({
	reviewer: { name: "codex" },
	file: "a.ts",
	line: 1,
	title: "Check n",
	body: "n may be wrong",
	source: { kind: "file", path: "review.json", position: 0 },
});
await comparison.importFindings(
	changeset.revision,
	[{ source: "file:review.json", imported: { findings: [external], skippedBodies: 0 } }],
	"2026-10-18T00:00:00Z",
);
await comparison.close(context);
copyFileSync(path, join(dirname(path), "decided.sqlite"));
harness = await openHarness(await openSqliteStorage(path), { models: fake.models, registry: createReviewRegistry() });
root = await harness.root(context);
const pending = await root.commit(async (tx) => {
	const index = await tx.doc(ReviewIndex, root.id);
	const input = JSON.parse(index.reviews[key].adjudication.input);
	input.checks = [{ name: "static.mutation", status: "failed" }];
	const task = await tx.createTask(AdjudicationTask, input, { ownership: { kind: "conversation" } });
	index.reviews[key].adjudication = { task, input: JSON.stringify(input) };
	return task;
}, context);
await harness.close(context);
gitIn(repo, "bundle", "create", join(dirname(path), "repo.bundle"), "--all");
writeFileSync(
	join(dirname(path), "recorded.json"),
	JSON.stringify(
		{ commit: "ac4e8c07", changeset: changeset.id, key, pending, finding: finding.id, external: external.id },
		null,
		2,
	) + "\n",
);
