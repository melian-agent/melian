// Copy to the recording commit's root; pass the output directory and that commit. Reviews one change with two lenses,
// exporting its records, and writes them as JSON.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, MemoryRecordStore, reviewPayloads } from "./packages/core/src/index.ts";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	openHarness,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
} from "./packages/pipeline/src/testing.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./packages/pipeline/test/fixtures/repo.ts";
import { twoLensTiers } from "./packages/pipeline/test/fixtures/review-scenario.ts";

const dates = { GIT_AUTHOR_DATE: "2026-11-16T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-16T00:00:00Z" };
Object.assign(process.env, isolatedGitEnv, dates);
const [directory, commit] = process.argv.slice(2);
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
	{ match: "", replies: [fauxAssistantMessage("No findings.")] },
]);
const harness = await openHarness(createMemoryStorage(), {
	models: fake.models,
	registry: createReviewRegistry(),
	settings: { retry: { enabled: false } },
});
try {
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	const changeset = await Changeset.resolve(repo, "main...feature");
	const store = new MemoryRecordStore({ payloads: reviewPayloads });
	const review = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: [],
		models: fake.review,
		checks: [
			{ name: "guardrails", status: "ran" },
			{ name: "static.biome", status: "ran", version: "2.5.0", findings: 0, notes: [] },
			{ name: "static.tsc", status: "ran", version: "5.9.3", findings: 0, notes: [] },
			{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
		],
		records: store,
	}).catch((error) => ({ verdict: error.verdict }));
	writeFileSync(
		join(directory, "recorded.json"),
		`${JSON.stringify(
			{
				commit,
				changeset: changeset.id,
				revision: changeset.revision,
				status: review.verdict?.status,
				records: await store.list(changeset.id),
			},
			null,
			"\t",
		)}\n`,
	);
} finally {
	await harness.close(context);
}
