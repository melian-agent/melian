// Runs a review in its own process and parks so the parent can SIGKILL it. `finding` parks once report_finding has
// committed, before the tool's result is stored, with the lens at its full budget of one finding. `request` parks in
// each lens's first model request.
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

const [scenario, repo, database, log] = process.argv.slice(2) as ["finding" | "request", string, string, string];
const park = () => new Promise<never>(() => setInterval(() => {}, 60_000));
Object.assign(process.env, isolatedGitEnv);

const parkedReport = defineTool({
	...reportFinding,
	execute: async (args, api, context) => {
		const result = await reportFinding.execute(args, api, context);
		record(log, { event: "finding-committed" });
		await park();
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
const requested = (lens: string) => () => {
	record(log, { event: "model-request", lens });
	return park();
};
scriptConversations(
	fake,
	scenario === "finding"
		? [
				{
					match: "You are the correctness reviewer",
					replies: [fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" })],
				},
				{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
			]
		: [
				{ match: "You are the correctness reviewer", replies: [requested("correctness")] },
				{ match: "You are the contracts reviewer", replies: [requested("contracts")] },
			],
);
const heavy = fake.ref("heavy");
record(log, { event: "review-started" });
await reviewChangeset({
	harness,
	changeset: await resolveRange(repo, "main...feature"),
	config: { ...defaultConfig, models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } } },
	lenses: crashLenses(await loadLenses(repo, { kind: "worktree" }, ["src/user.ts"])),
	standards: [],
	models: fake.review,
});
