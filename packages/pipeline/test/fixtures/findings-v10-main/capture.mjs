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
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "./packages/pipeline/src/testing.ts";
import { baseAndHead, gitIn, lines } from "./packages/pipeline/test/fixtures/repo.ts";

const out = process.argv[2];
const numbered = (count, label) => lines(...Array.from({ length: count }, (_, index) => `${label} ${index + 1}`));
const repo = baseAndHead(
	{ "src/a.ts": numbered(20, "a"), "src/b.ts": numbered(20, "b") },
	{ "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n"), "src/c.ts": numbered(20, "c") },
);
const base = gitIn(repo, "rev-parse", "main");
const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
const heavy = fake.ref("heavy");
const config = {
	...defaultConfig,
	tiers: { ...defaultConfig.tiers, full: ["standard", "lens.contracts"] },
	models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
};
const changeset = await Changeset.resolve(repo, `${base}..feature`);
const harness = await openHarness(await openSqliteStorage(join(out, "main.sqlite")), {
	models: fake.models,
	registry: createReviewRegistry(),
	settings: { retry: { enabled: false } },
});
await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
const lenses = await Lens.load(repo, { kind: "revision", commit: base }, ["src/a.ts"]);
const finding = {
	file: "src/a.ts",
	line: 3,
	rule: "null-dereference",
	severity: "P1",
	explanation: { what: "A 3 reads a missing value.", why: "The change made it.", fix: "Guard it." },
	failureScenario: "Calling it with no value throws a TypeError.",
	evidence: [{ file: "src/a.ts", line: 3, role: "cause" }],
};
scriptConversations(fake, [
	{
		match: "You are the correctness reviewer",
		replies: [
			fauxAssistantMessage(fauxToolCall("report_finding", finding), { stopReason: "toolUse" }),
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
const { verdict } = await reviewChangeset({
	harness,
	changeset,
	config,
	lenses,
	standards: [{ path: "AGENTS.md", content: "Be careful." }],
	models: fake.review,
	checks,
});
await harness.close(context);
gitIn(repo, "bundle", "create", join(out, "repo.bundle"), "--all");
writeFileSync(
	join(out, "recorded.json"),
	`${JSON.stringify({ commit: "73e7a399", changeset: changeset.id, key: revisionKey(changeset.revision), base, head: changeset.revision.head, finding: verdict.findings.block[0].id }, null, 2)}\n`,
);
