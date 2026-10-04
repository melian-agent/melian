// Runs a review in its own process and parks so the parent can SIGKILL it. `finding` parks once report_finding has
// committed, before the tool's result is stored, with the lens at its full budget of one finding. `legacy` offers
// report_finding as the Melian before failure scenarios defined it, and parks once a call in that shape has been
// accepted, so the parent replays it through the current tool. `request` parks in each lens's first model request.
// `adjudication` lets both lenses finish and parks at the start of adjudication, before it records a verdict. `read`
// parks once read_file has counted its call against a budget of two, before the tool's result is stored.
import { defaultConfig, loadLenses, resolveRange, severitySchema } from "@melian-agent/core";
import { AdjudicationTask } from "../../src/adjudication.ts";
import {
	backgroundContext,
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	openHarness,
	openSqliteStorage,
	Type,
} from "../../src/harness.ts";
import { lensReadTools, reportFinding } from "../../src/lens-tools.ts";
import { lensExtension, reviewChangeset } from "../../src/review.ts";
import { createFakeModels, fauxAssistantMessage, fauxToolCall, scriptConversations } from "../../src/testing.ts";
import { isolatedGitEnv } from "./repo.ts";
import { budgetLenses, crashFinding, crashLenses, legacyCrashFinding, record } from "./review-scenario.ts";

const [scenario, repo, database, log] = process.argv.slice(2) as [
	"finding" | "legacy" | "request" | "adjudication" | "read",
	string,
	string,
	string,
];
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
const parkedRead = defineTool({
	...lensReadTools.read_file,
	execute: async (args, api, context) => {
		const result = await lensReadTools.read_file.execute(args, api, context);
		record(log, { event: "read-counted" });
		await park();
		return result;
	},
});
// The report_finding an older Melian offered: evidence one optional location, no failure scenario, and no
// prepareArguments, so a call in that shape is accepted and its intent committed.
const { prepareArguments: _, ...current } = reportFinding;
const legacyReport = defineTool({
	...current,
	parameters: Type.Object({
		file: Type.String(),
		line: Type.Integer(),
		rule: Type.String(),
		severity: severitySchema,
		explanation: Type.Object({ what: Type.String(), why: Type.String(), fix: Type.String() }),
		evidence: Type.Optional(Type.Object({ file: Type.String(), line: Type.Integer() })),
	}),
	execute: async () => {
		record(log, { event: "legacy-call-accepted" });
		return await park();
	},
});
const parkedAdjudication = defineTask({
	...AdjudicationTask.definition,
	phases: {
		adjudicate: async () => {
			record(log, { event: "adjudication-started" });
			await park();
		},
	},
});
// Replaces the installed melian.lenses extension by name, so the lens conversations resolve this report_finding and
// the review creates this adjudication task.
const parked = defineExtension({
	...lensExtension,
	tools: lensExtension.tools?.map((tool) =>
		tool.name === lensReadTools.read_file.name && scenario === "read"
			? parkedRead
			: tool.name !== reportFinding.name
				? tool
				: scenario === "legacy"
					? legacyReport
					: parkedReport,
	),
	tasks: lensExtension.tasks?.map((task) =>
		scenario === "adjudication" && task === AdjudicationTask ? parkedAdjudication : task,
	),
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
	scenario === "finding" || scenario === "legacy"
		? [
				{
					match: "You are the correctness reviewer",
					replies: [
						fauxAssistantMessage(
							fauxToolCall("report_finding", scenario === "legacy" ? legacyCrashFinding : crashFinding),
							{ stopReason: "toolUse" },
						),
					],
				},
				{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
			]
		: scenario === "read"
			? [
					{
						match: "You are the correctness reviewer",
						replies: [
							fauxAssistantMessage(fauxToolCall("read_file", { path: "src/user.ts" }), {
								stopReason: "toolUse",
							}),
						],
					},
					{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
				]
			: scenario === "request"
				? [
						{ match: "You are the correctness reviewer", replies: [requested("correctness")] },
						{ match: "You are the contracts reviewer", replies: [requested("contracts")] },
					]
				: [
						{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
						{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
					],
);
const heavy = fake.ref("heavy");
record(log, { event: "review-started" });
await reviewChangeset({
	harness,
	changeset: await resolveRange(repo, "main...feature"),
	config: { ...defaultConfig, models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } } },
	lenses: (scenario === "read" ? budgetLenses : crashLenses)(
		await loadLenses(repo, { kind: "worktree" }, ["src/user.ts"]),
	),
	standards: [],
	models: fake.review,
});
