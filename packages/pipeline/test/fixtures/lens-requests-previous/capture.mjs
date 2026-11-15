// Copy to 0129288b's root; pass the output directory. Reviews one change with two lenses into a SQLite store.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, Revision } from "./packages/core/src/index.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
} from "./packages/pipeline/src/testing.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./packages/pipeline/test/fixtures/repo.ts";
import { twoLensTiers } from "./packages/pipeline/test/fixtures/review-scenario.ts";

// Fixed dates, so the test that reopens the store builds the same commits.
const dates = { GIT_AUTHOR_DATE: "2026-11-15T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-15T00:00:00Z" };
Object.assign(process.env, isolatedGitEnv, dates);
const directory = process.argv[2];
const repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
const heavy = fake.ref("heavy");
const config = {
	...defaultConfig,
	tiers: twoLensTiers,
	models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
};
const lenses = (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts");
const finding = {
	file: "src/a.ts",
	line: 1,
	rule: "changed-return",
	severity: "P2",
	explanation: { what: "a is 2 now.", why: "This change rewrote it.", fix: "Restore 1." },
	failureScenario: "A caller that reads a expects 1 and gets 2.",
	evidence: [{ file: "src/a.ts", line: 1, role: "cause" }],
};
const answer = (messages) =>
	systemPromptOf(messages).includes("You are the contracts reviewer") &&
	!messages.some((message) => message.role === "toolResult")
		? fauxAssistantMessage(fauxToolCall("report_finding", finding), { stopReason: "toolUse" })
		: fauxAssistantMessage("No findings.");
scriptConversations(fake, [
	{ match: "You are the correctness reviewer", replies: [answer] },
	{ match: "You are the contracts reviewer", replies: [answer, answer] },
]);
const harness = await openHarness(await openSqliteStorage(join(directory, "state.sqlite")), {
	models: fake.models,
	registry: createReviewRegistry(),
	settings: { retry: { enabled: false } },
});
try {
	const root = await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	const changeset = await Changeset.resolve(repo, "main...feature");
	const review = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: [],
		models: fake.review,
		checks: [
			{ name: "guardrails", status: "ran" },
			{ name: "static.biome", status: "ran" },
			{ name: "static.tsc", status: "ran" },
			{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
		],
	});
	const revision = Revision.key(changeset.revision);
	const entry = (await harness.snapshot(ReviewIndex, root.id, context)).reviews[revision];
	writeFileSync(
		join(directory, "recorded.json"),
		`${JSON.stringify(
			{
				commit: "0129288b",
				base: gitIn(repo, "rev-parse", "main"),
				head: gitIn(repo, "rev-parse", "feature"),
				revision,
				lensTask: { version: (await harness.getTask(entry.task, context)).version },
				verdict: review.verdict.status,
				findings: review.findings.map(({ id }) => id),
				lenses: entry.lenses,
				task: entry.task,
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await harness.close(context);
}
