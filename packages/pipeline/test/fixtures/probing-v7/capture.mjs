// Copy to 374fdaf7's root; pass the output directory. Reviews one change at a level that probes into a SQLite store:
// the prober runs a probe for attack 1 that a signal ends, which shows nothing, and skips attack 2.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, Revision, Standards } from "./packages/core/src/index.ts";
import {
	backgroundContext as context,
	openReviewHarness,
	openSqliteStorage,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	unconfinedSandbox,
} from "./packages/pipeline/src/testing.ts";
import { baseAndHead, gitIn, isolatedGitEnv } from "./packages/pipeline/test/fixtures/repo.ts";

// Fixed dates, so the test that reopens the store builds the same commits.
const dates = { GIT_AUTHOR_DATE: "2026-11-16T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-16T00:00:00Z" };
Object.assign(process.env, isolatedGitEnv, dates);
const directory = process.argv[2];
const repo = baseAndHead(
	{ "src/load.ts": "export function load(path: string) {\n\treturn path;\n}\n" },
	{
		"src/load.ts":
			'import { readFileSync } from "node:fs";\nexport function load(path: string) {\n\treturn readFileSync(path, "utf8");\n}\n',
	},
);
const attacks = [
	{
		target: "src/load.ts load()",
		reason: "an author's path reaches readFileSync unconfined",
		passing: "the read stays inside the repository and prints held",
		failing: "the read returns a file outside the repository and prints LEAK",
	},
	{
		target: "src/load.ts load() over the network",
		reason: "a path could name a network share",
		passing: "the read is refused",
		failing: "the read reaches the share",
	},
];
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const fake = createFakeModels();
const ref = fake.ref();
scriptConversations(fake, [
	{
		match: "Your role at this level: the attack planner",
		replies: [call("record_plan", { attacks }), fauxAssistantMessage("Planned 2 attacks.")],
	},
	{
		match: "You are the prober for the trust-boundary lens",
		replies: [
			call("run_probe", { attack: 1, script: 'process.kill(process.pid, "SIGKILL");\n' }),
			call("skip_attack", { attack: 2, reason: "it needs the network" }),
			fauxAssistantMessage("Reported 0 findings."),
		],
	},
]);
const storage = await openSqliteStorage(join(directory, "state.sqlite"));
const harness = await openReviewHarness(storage, fake.review, { retry: false, probeSandbox: unconfinedSandbox() });
try {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const policy = { kind: "revision", commit: changeset.revision.base };
	const paths = changeset.revision.paths();
	const lenses = (await Lens.load(repo, policy, paths)).map((lens) =>
		lens.name === "trust-boundary"
			? Lens.from({
					...lens.toJSON(),
					levels: { ...lens.levels, deep: { ...lens.level("deep"), probe: {} } },
				})
			: lens,
	);
	const review = await reviewChangeset({
		harness,
		changeset,
		config: {
			...defaultConfig,
			tiers: { full: ["lens.trust-boundary"] },
			lenses: { "trust-boundary": { level: { floor: "deep" } } },
			models: { heavy: { model: `${ref.provider}/${ref.modelId}` } },
		},
		lenses,
		standards: await Standards.load(repo, policy, paths),
		models: fake.review,
		writer: { trusted: true, by: "reviewer" },
	});
	const revision = Revision.key(changeset.revision);
	const reviewer = harness.harness;
	const root = await reviewer.root(context);
	const entry = (await reviewer.snapshot(ReviewIndex, root.id, context)).reviews[revision];
	const task = await reviewer.getTask(entry.task, context);
	const record = review.verdict.ran.find(({ name }) => name === "lens.trust-boundary");
	writeFileSync(
		join(directory, "recorded.json"),
		`${JSON.stringify(
			{
				commit: gitIn(process.cwd(), "rev-parse", "--short=8", "HEAD"),
				base: gitIn(repo, "rev-parse", "main"),
				head: gitIn(repo, "rev-parse", "feature"),
				revision,
				lensTask: { id: entry.task, version: task.version, result: task.state.outcome.result },
				record,
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await harness.close();
}
