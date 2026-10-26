// Copy to the root of main at edbef2a8; run with --conditions=@melian-agent/source and an output directory.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, resolveRange } from "./packages/core/src/index.ts";
import { VerdictDocument } from "./packages/pipeline/src/adjudication.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";
import { baseAndHead, gitIn } from "./packages/pipeline/test/fixtures/repo.ts";

const output = process.argv[2];
const repo = baseAndHead({ "notes.txt": "ready\n" }, { "notes.txt": "done\n" });
const changeset = await resolveRange(repo, "main...feature");
const fake = createFakeModels();
const harness = await openHarness(await openSqliteStorage(join(output, "main.sqlite")), {
	models: fake.models,
	registry: createReviewRegistry(),
});
try {
	await harness.root(context, { agent: { model: fake.ref() } });
	await reviewChangeset({
		harness,
		changeset,
		config: { ...defaultConfig, tiers: { full: [] } },
		lenses: [],
		standards: [],
		models: fake.review,
		checks: [],
	});
	const root = await harness.root(context);
	const document = await harness.snapshot(VerdictDocument, root.id, context);
	writeFileSync(
		join(output, "recorded.json"),
		`${JSON.stringify({ commit: "edbef2a81b3780c1a91974cad5a9c22d27ee1888", changeset: changeset.id, key: Object.keys(document.verdicts)[0] }, null, 2)}\n`,
	);
} finally {
	await harness.close(context);
}
gitIn(repo, "bundle", "create", join(output, "repo.bundle"), "--all");
