import { writeFileSync } from "node:fs";
import { Changeset, Lens, loadConfig } from "@melian-agent/core";
import { openReviewHarness, openSqliteStorage, reviewChangeset } from "../../src/index.ts";
import { createFakeModels, scriptConversations } from "../../src/testing.ts";

const [repo, base, head, database, ready] = process.argv.slice(2) as [string, string, string, string, string];
const fake = createFakeModels();
scriptConversations(fake, [
	{
		match: "You are the correctness reviewer",
		replies: [
			() => {
				writeFileSync(ready, "ready");
				return new Promise<never>(() => setInterval(() => {}, 60_000));
			},
		],
	},
]);
const policy = { kind: "revision", commit: base } as const;
const { config } = await loadConfig(repo, policy, ".");
const ref = fake.ref();
const changeset = await Changeset.resolve(repo, `${base}..${head}`);
const harness = await openReviewHarness(await openSqliteStorage(database), fake.review, {
	checkout: repo,
	retry: false,
});
await reviewChangeset({
	harness,
	changeset,
	policy,
	config: {
		...config,
		tiers: { full: ["guardrails", "static.tsc", "lens.correctness"] },
		models: { heavy: { model: `${ref.provider}/${ref.modelId}` } },
	},
	lenses: await Lens.load(repo, policy, changeset.revision.paths()),
	standards: [],
	models: fake.review,
});
