// Copy this file to the root of the 73e7a399 source tree and run it there with Node 24 and
// --conditions=@melian-agent/source, passing an absolute output directory.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens } from "./packages/core/src/index.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
	reviewChangeset,
	revisionKey,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "./packages/pipeline/src/testing.ts";
import { baseAndHead, gitIn, lines } from "./packages/pipeline/test/fixtures/repo.ts";

const out = process.argv[2];
const user = (body) =>
	lines(
		"export interface User {",
		"\tname: string;",
		"\tmanager?: User;",
		"}",
		"",
		"export function managerName(user: User): string {",
		body,
		"}",
	);
const repo = baseAndHead(
	{ "src/user.ts": user('\treturn user.manager?.name ?? "none";') },
	{ "src/user.ts": user("\treturn user.manager.name;") },
);
const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
const heavy = fake.ref("heavy");
const config = {
	...defaultConfig,
	tiers: { ...defaultConfig.tiers, full: ["standard", "lens.contracts"] },
	models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
};
const changeset = await Changeset.resolve(repo, "main...feature");
const key = revisionKey(changeset.revision);
const harness = await openHarness(await openSqliteStorage(join(out, "main.sqlite")), {
	models: fake.models,
	registry: createReviewRegistry(),
	settings: { retry: { enabled: false } },
});
const root = await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
const lenses = await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"]);
scriptConversations(fake, [
	{
		match: "You are the correctness reviewer",
		replies: [
			fauxAssistantMessage(fauxToolCall("read_file", { path: "src/user.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		],
	},
	{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
]);
const checks = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
	{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
];
await reviewChangeset({
	harness,
	changeset,
	config,
	lenses,
	standards: [{ path: "AGENTS.md", content: "Be careful." }],
	models: fake.review,
	checks,
});
const lensTask = (await harness.snapshot(ReviewIndex, root.id, context)).reviews[key].task;
await harness.close(context);
gitIn(repo, "bundle", "create", join(out, "repo.bundle"), "--all");
writeFileSync(
	join(out, "recorded.json"),
	`${JSON.stringify({ commit: "73e7a399", changeset: changeset.id, key, base: changeset.revision.base, head: changeset.revision.head, lensTask }, null, 2)}\n`,
);
