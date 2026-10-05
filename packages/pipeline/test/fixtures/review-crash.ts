// Runs a review in its own process and parks so the parent can SIGKILL it. `finding` parks once report_finding has
// committed, before the tool's result is stored, with the lens at its full budget of one finding. `legacy` offers
// report_finding as the Melian before failure scenarios defined it, and parks once a call in that shape has been
// accepted, so the parent replays it through the current tool. `request` parks in each lens's first model request.
// `adjudication` lets both lenses finish and parks at the start of adjudication, before it records a verdict. `read`
// parks once read_file has counted its call against a budget of two, before the tool's result is stored. `spent` and
// `tokens` park in the read_file call that ends the lens, once its commit has recorded the spent budget and before the
// tool's result is stored: `spent` in the second read under a budget of one call, `tokens` in the first under a budget
// of one token. `escalation` triages correctness to quick through a recorded decider, has it report a P1, and parks in
// the first model request of the careful run it escalates to, after the commit that created that run's conversation.
// `decision` parks in the decider's first call, with the decision task live and named by the decision document.
// `replacement` first records a verdict, then parks in replacement triage after its decision commit.
import { Changeset, type Decider, defaultConfig, Lens, severitySchema } from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import { AdjudicationTask } from "../../src/adjudication.ts";
import { decisionExtension } from "../../src/decisions.ts";
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
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
} from "../../src/testing.ts";
import { isolatedGitEnv } from "./repo.ts";
import {
	budgetLenses,
	crashFinding,
	crashLenses,
	endingBudgets,
	legacyCrashFinding,
	record,
	twoLensTiers,
} from "./review-scenario.ts";

const [scenario, repo, database, log] = process.argv.slice(2) as [
	(
		| "finding"
		| "legacy"
		| "request"
		| "adjudication"
		| "read"
		| "spent"
		| "tokens"
		| "escalation"
		| "decision"
		| "replacement"
	),
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
		if (scenario !== "read" && !("control" in result)) return result;
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
		tool.name === lensReadTools.read_file.name && ["read", "spent", "tokens"].includes(scenario)
			? parkedRead
			: tool.name !== reportFinding.name || scenario === "escalation"
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
const decider = new RecordedDecider({
	triage: { version: "1", answers: { correctness: { distribution: { quick: 1 } } } },
});
const parkedDecider: Decider = {
	name: "parked",
	calibrated: false,
	decide: () => {
		record(log, { event: "decision-asked" });
		return park();
	},
};
if (scenario === "escalation") registry.install(decisionExtension(decider));
if (scenario === "decision" || scenario === "replacement") registry.install(decisionExtension(parkedDecider));

const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "medium" }, { id: "heavy" }] });
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
const toolUse = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const done = fauxAssistantMessage("Done.");
const correctness: Readonly<Record<typeof scenario, readonly ScriptedReply[]>> = {
	finding: [toolUse("report_finding", crashFinding)],
	legacy: [toolUse("report_finding", legacyCrashFinding)],
	request: [requested("correctness")],
	adjudication: [done],
	read: [toolUse("read_file", { path: "src/user.ts" })],
	spent: [toolUse("read_file", { path: "src/user.ts" }), toolUse("read_file", { path: "src/user.ts", startLine: 7 })],
	tokens: [toolUse("read_file", { path: "src/user.ts" })],
	escalation: [toolUse("report_finding", crashFinding), done, requested("correctness")],
	decision: [done],
	replacement: [done],
};
scriptConversations(fake, [
	{ match: "You are the correctness reviewer", replies: correctness[scenario] },
	{ match: "You are the contracts reviewer", replies: [scenario === "request" ? requested("contracts") : done] },
]);
function lensesFor(lenses: Lens[]) {
	if (scenario === "escalation" || scenario === "decision") return lenses;
	if (scenario === "spent" || scenario === "tokens") return budgetLenses(lenses, endingBudgets[scenario]);
	return scenario === "read" ? budgetLenses(lenses) : crashLenses(lenses);
}
const heavy = fake.ref("heavy");
const medium = fake.ref("medium");
record(log, { event: "review-started" });
const changeset = await Changeset.resolve(repo, "main...feature");
const options = {
	harness,
	changeset,
	config: {
		...defaultConfig,
		tiers:
			scenario === "escalation" || scenario === "decision"
				? { ...defaultConfig.tiers, full: ["standard"] }
				: twoLensTiers,
		models: {
			medium: { model: `${medium.provider}/${medium.modelId}` },
			heavy: { model: `${heavy.provider}/${heavy.modelId}` },
		},
	},
	...(scenario === "escalation" ? { decider } : scenario === "decision" ? { decider: parkedDecider } : {}),
	lenses: lensesFor(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
	checks: [],
	standards: [],
	models: fake.review,
	...(scenario === "replacement"
		? {
				policy: { kind: "revision" as const, commit: changeset.revision.base },
				origin: {
					kind: "pull-request" as const,
					repository: { owner: "test", name: "repo" },
					pullRequest: 62,
					base: changeset.revision.base,
					head: changeset.revision.head,
				},
			}
		: {}),
};
await reviewChangeset(options);
if (scenario === "replacement") {
	record(log, { event: "verdict-recorded" });
	await reviewChangeset({ ...options, decider: parkedDecider });
}
