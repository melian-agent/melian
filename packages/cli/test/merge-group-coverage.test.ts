import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Revision } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	CoverageLedger,
	backgroundContext as context,
	createMemoryStorage,
	type Harness,
	publishReview,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import {
	gitIn,
	isolatedGitEnv,
	lensScript,
	moveTo,
	openPublishHarness,
	pullRequestState,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
} from "../../github/test/fixtures/scenario.ts";
import { MergeGroupStatus } from "../src/merge-group.ts";

let repo: string;
let harness: Harness | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = scenarioRepository();
	// Each line is short, but together they are more than any lens prompt carries, so every lens owes lines of the file.
	const big = Array.from({ length: 6000 }, (_, index) => `export const value${index} = "${"x".repeat(30)}";\n`);
	writeFileSync(join(repo, "src/big.ts"), big.join(""));
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "generated constants");
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

it("posts error naming a coverage gap, which the merge group fails, until a dismissal lets the review pass", async () => {
	const fake = scenarioModels();
	const state = pullRequestState();
	state.branchRules = [{ type: "merge_queue", parameters: { grouping_strategy: "ALLGREEN", merge_method: "MERGE" } }];
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "t",
		fetch: fakeGitHub(state),
	});
	harness = await openPublishHarness(createMemoryStorage(), fake, provider);
	const review = async () => {
		const { changeset, review } = await reviewScenario(repo, harness!, fake, lensScript());
		await review.catch(() => undefined);
		return changeset;
	};
	const changeset = await review();
	moveTo(state, changeset);
	const { base, head } = changeset.revision;
	const publish = async () =>
		publishReview({
			harness: harness!,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base,
			trustedWriters: true,
		});
	const group = gitIn(repo, "commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "group");
	const eventPath = join(repo, "event.json");
	writeFileSync(
		eventPath,
		JSON.stringify({
			merge_group: {
				head_sha: group,
				base_sha: base,
				base_ref: "refs/heads/main",
				head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${base}`,
			},
		}),
	);
	const io = {
		cwd: repo,
		env: {
			GITHUB_EVENT_NAME: "merge_group",
			GITHUB_EVENT_PATH: eventPath,
			GITHUB_REPOSITORY: `${state.owner}/${state.repo}`,
			GITHUB_RUN_ID: "1",
		},
		stdout: vi.fn(),
		stderr: vi.fn(),
		color: false,
	};
	const mergeGroup = async () => (await MergeGroupStatus.load(io, { provider })).post();

	await publish();
	const gap = state.statuses.filter((status) => status.sha === head).at(-1);
	expect(gap).toMatchObject({ state: "error" });
	// GitHub keeps 140 characters of a description, so the status names the first gap and the review body the rest.
	expect(gap?.description).toMatch(
		/^Not reviewed: review\.coverage skipped \(coverage is incomplete: lens\.contracts src\/big\.ts: to…; base /,
	);
	expect(gap?.description).toMatch(new RegExp(`; base ${base}$`));
	const body = state.reviews.at(-1)!.body;
	expect(body).toContain("Coverage: incomplete, partly from rounds r1.");
	expect(body).toContain("Round r1's lenses reviewed 2 of 6002 changed lines:\n\n- `src/user.ts` line 7\n");
	expect(body).toContain(
		"- `lens.contracts` in `src/big.ts` lines 1-6000: too large for the prompt; lines still owed\n- `lens.correctness` in `src/big.ts` lines 1-6000",
	);
	expect(state.ledgers[0]!.body).toContain("Coverage: incomplete, partly from rounds r1.");
	expect(await mergeGroup()).toBe(1);
	expect(state.statuses.at(-1)).toMatchObject({
		sha: group,
		state: "failure",
		description: "PR #7: latest head status is not success",
	});

	const ledger = new CoverageLedger(harness, (await harness.root(context)).id);
	for (const check of ["lens.correctness", "lens.contracts"])
		await ledger.dismiss(
			Revision.key(changeset.revision),
			{ check, file: "src/big.ts", lines: [[1, 6000]], reason: "generated constants", by: "Ada", at: "t" },
			context,
		);
	await review();
	await publish();
	expect(state.statuses.filter((status) => status.sha === head).at(-1)).toMatchObject({
		state: "success",
		description: `Passed; base ${base}`,
	});
	expect(state.reviews.at(-1)!.body).toContain("Coverage: complete, from rounds r");
	expect(state.reviews.at(-1)!.body).toContain("- 2 dismissed by a maintainer, which covers nothing");
	expect(state.ledgers[0]!.body).toContain("Coverage: complete, from rounds r");
	expect(await mergeGroup()).toBe(0);
	expect(state.statuses.at(-1)).toMatchObject({ sha: group, state: "success" });
});
