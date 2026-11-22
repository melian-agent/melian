# Main's verification of a candidate shown a dismissed root

`state.sqlite` is the closed SQLite store main's code at `2fae681a` wrote. A lens reported a null dereference, a maintainer dismissed it with `recordDismissal`, a commit elsewhere moved the head, and the lens reported the same defect worded afresh. The verifier was shown the dismissed root and judged the restatement the same. The store holds that version 4 verification task, whose candidate names the root by its claim alone, with no dismissal record ID. `recorded.json` holds the revision, the root conversation, the dismissed and restated finding IDs, the review index's verification entry, the task's version and what its candidates were shown, as main read them back. `repo.bundle` holds the review's `main` and `feature` commits. No stored field was written by hand.

The script below wrote all three, saved as `record.ts` at the root of a detached worktree of `2fae681a` with its own `npm ci --ignore-scripts`, and run with `node --conditions=@melian-agent/source record.ts <output directory>` under `GIT_CONFIG_COUNT=0`. Every package it imports is that commit's own.

```ts
// Records main's store after a review whose verifier was shown a dismissed root, with no record ID on it.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens } from "@melian-agent/core";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
	recordDismissal,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import { ReviewIndex } from "./packages/pipeline/src/review-index.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
	systemPromptOf,
} from "./packages/pipeline/src/testing.ts";
import { verifierMarker } from "./packages/pipeline/src/verification-instructions.ts";
import { baseAndHead, gitIn, lines, writeFiles } from "./packages/pipeline/test/fixtures/repo.ts";

const out = process.argv[2]!;
const user = (label: string, body: string) =>
	lines(
		"export interface User {",
		"\tname: string;",
		"\tmanager?: User;",
		"}",
		"",
		"export function managerName(user: User): string {",
		`\tconst label = "${label}";`,
		body,
		"}",
	);
const nullDeref = {
	file: "src/user.ts",
	line: 8,
	rule: "null-dereference",
	severity: "P1",
	explanation: {
		what: "managerName reads name from a manager that may be undefined.",
		why: "This change dropped the optional chain, so a user without a manager throws.",
		fix: "Restore user.manager?.name with a fallback.",
	},
	failureScenario: 'managerName({ name: "Ada" }) throws TypeError: Cannot read properties of undefined.',
	evidence: [{ file: "src/user.ts", line: 8, role: "cause" }],
};
const restatement = {
	...nullDeref,
	line: 7,
	endLine: 8,
	failureScenario: "A user with no manager makes managerName throw on the name read.",
};
const repo = baseAndHead(
	{ "src/user.ts": user("manager", '\treturn user.manager?.name ?? "none";') },
	{ "src/user.ts": user("boss", "\treturn user.manager.name + label;") },
);
const scratch = mkdtempSync(join(tmpdir(), "melian-record-"));
const file = join(scratch, "state.sqlite");
const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
const harness = await openHarness(await openSqliteStorage(file), {
	models: fake.models,
	registry: createReviewRegistry(),
	settings: { retry: { enabled: false } },
});
const root = await harness.root(context, { agent: { model: fake.ref("finder") } });
const lenses = (
	await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"])
).filter((lens) => lens.name === "correctness");
const finder = fake.ref("finder");
const judge = fake.ref("judge");
const config = {
	...defaultConfig,
	tiers: { full: ["lens.correctness"] },
	stages: { "pull-request": "full" as const },
	models: {
		heavy: { model: `${finder.provider}/${finder.modelId}` },
		verifier: { model: `${judge.provider}/${judge.modelId}` },
	},
};
const verify = (messages: Parameters<typeof scriptVerifier>[0]) => {
	const prompt = systemPromptOf(messages);
	const dismissed = [...prompt.matchAll(/Dismissed d[1-9][0-9]* finding ([0-9a-f]{16})/g)].map((m) => m[1]!);
	const claims = [...prompt.matchAll(/Claim c[1-9][0-9]* finding ([0-9a-f]+)/g)].map((m) => m[1]!);
	const matches = Object.fromEntries(dismissed.map((id) => [id, "same"]));
	return scriptVerifier(messages, Object.fromEntries(claims.map((id) => [id, { verdict: "confirmed" as const, matches }])));
};
const review = async (reported: typeof nullDeref) => {
	scriptConversations(fake, [
		{
			match: lenses[0]!.instructions,
			replies: [
				fauxAssistantMessage(fauxToolCall("report_finding", reported), { stopReason: "toolUse" }),
				fauxAssistantMessage("Done."),
			],
		},
		{ match: verifierMarker, replies: [verify, verify, verify, verify] },
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	return { changeset, review: await reviewChangeset({ harness, checks: [], changeset, lenses, standards: [], models: fake.review, config }) };
};
const first = await review(nullDeref);
const dismissed = first.review.verdict.attention()[0]!.id;
await recordDismissal({
	harness,
	revision: first.changeset.revision,
	id: dismissed,
	dismissal: { by: "Tal <tal@melian.invalid>", reason: "Every user here has a manager.", at: "2026-10-04T01:00:00Z" },
	repoRoot: repo,
});
writeFiles(repo, { "src/other.ts": "export const other = 1;\n" });
gitIn(repo, "add", "--all");
gitIn(repo, "commit", "--quiet", "-m", "add other");
const second = await review(restatement);
const revision = `${second.changeset.revision.base}..${second.changeset.revision.head}`;
const indexed = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[revision]!;
const task = (await harness.getTask(indexed.verification!.task as never, context))!;
await harness.close(context);
copyFileSync(file, join(out, "state.sqlite"));
execFileSync("git", ["bundle", "create", join(out, "repo.bundle"), "main", "feature"], { cwd: repo, stdio: "ignore" });
writeFileSync(
	join(out, "recorded.json"),
	`${JSON.stringify(
		{
			recordedBy: gitIn(process.cwd(), "rev-parse", "--short=8", "HEAD"),
			root: root.id,
			revision,
			dismissed,
			restatement: second.review.verdict.dismissed.map((each) => each.id),
			verification: indexed.verification,
			taskVersion: task.version,
			shown: (task.input as { candidates: { dismissed?: unknown }[] }).candidates.map((each) => each.dismissed),
		},
		null,
		"\t",
	)}\n`,
);
```

`test/verification-dismissal-reopen.test.ts` opens a copy of the store with this build, reviews the same revision again, and expects one verifier conversation, a new task under another key, the restatement still dismissed, and the new candidate naming the root's dismissal record by the ID the round exports. Run against main's own code, the same test attaches to the stored task and asks the verifier nothing.
