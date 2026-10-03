// Runs a review in its own process until report_finding has committed, then parks so the parent can SIGKILL it before
// the tool's result is stored. The lens's budget is one finding, so the review is at its full budget when it dies.
import { defaultConfig, loadLenses, resolveRange } from "@melian-agent/core";
import {
	backgroundContext,
	createRegistry,
	defineExtension,
	defineTool,
	openHarness,
	openSqliteStorage,
} from "../../src/harness.ts";
import { reportFinding } from "../../src/lens-tools.ts";
import { lensExtension, reviewChangeset } from "../../src/review.ts";
import { createFakeModels, fauxAssistantMessage, fauxToolCall, scriptConversations } from "../../src/testing.ts";
import { isolatedGitEnv } from "./repo.ts";
import { crashFinding, crashLenses, record } from "./review-scenario.ts";

const [repo, database, log] = process.argv.slice(2) as [string, string, string];
Object.assign(process.env, isolatedGitEnv);

const parkedReport = defineTool({
	...reportFinding,
	execute: async (args, api, context) => {
		const result = await reportFinding.execute(args, api, context);
		record(log, { event: "finding-committed" });
		await new Promise(() => setInterval(() => {}, 60_000));
		return result;
	},
});
// Replaces the installed melian.lenses extension by name, so the lens conversations resolve this report_finding.
const parked = defineExtension({
	...lensExtension,
	tools: lensExtension.tools?.map((tool) => (tool.name === reportFinding.name ? parkedReport : tool)),
});
const registry = createRegistry();
registry.install(parked);

const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
const harness = await openHarness(await openSqliteStorage(database), {
	models: fake.models,
	registry,
	settings: { retry: { enabled: false } },
});
await harness.root(backgroundContext, { agent: { model: fake.ref("orchestrator") } });
scriptConversations(fake, [
	{
		match: "You are the correctness reviewer",
		replies: [fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" })],
	},
	{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
]);
const heavy = fake.ref("heavy");
record(log, { event: "review-started" });
await reviewChangeset({
	harness,
	changeset: await resolveRange(repo, "main...feature"),
	config: { ...defaultConfig, models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } } },
	lenses: crashLenses(await loadLenses(repo, { kind: "worktree" }, ["src/user.ts"])),
	standards: [],
	models: fake.models,
});
