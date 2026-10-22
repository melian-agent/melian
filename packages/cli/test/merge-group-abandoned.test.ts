import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitHubProvider } from "@melian-agent/github";
import { backgroundContext as context, createMemoryStorage, type Harness, publishReview } from "@melian-agent/pipeline";
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
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

it("a passing head whose review is abandoned after three refusals cannot enter a merge group", async () => {
	const fake = scenarioModels();
	const state = pullRequestState();
	state.branchRules = [
		{ type: "merge_queue", parameters: { grouping_strategy: "ALLGREEN", merge_method: "MERGE" } },
	];
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test-token",
		fetch: fakeGitHub(state),
	});
	harness = await openPublishHarness(createMemoryStorage(), fake, provider);
	const { changeset, review } = await reviewScenario(repo, harness, fake, lensScript());
	await review;
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

	state.failReviews = true;
	await expect(publish()).rejects.toThrow("Server Error");
	expect(state.statuses.at(-1)).toMatchObject({ sha: head, state: "success" });
	await expect(publish()).rejects.toThrow("Server Error");
	await expect(publish()).rejects.toThrow("so Melian abandoned it and set the status to error");

	expect(state.statuses.at(-1)).toMatchObject({
		sha: head,
		state: "error",
		description: `Melian could not post its review; see the publish record; base ${base}`,
	});
	expect(await mergeGroup()).toBe(1);
	expect(state.statuses.at(-1)).toMatchObject({
		sha: group,
		state: "failure",
		description: "PR #7: latest head status is not success",
	});

	state.failReviews = false;
	await publish();
	expect(state.statuses.at(-1)).toMatchObject({ sha: head, state: "success" });
	expect(await mergeGroup()).toBe(0);
});
