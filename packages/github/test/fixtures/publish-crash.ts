// Publishes a reviewed pull request in its own process until GitHub has accepted the review, then parks before the
// publish task can record it, so the parent can SIGKILL it between the post and its checkpoint. The fake GitHub's
// state is written to a file after every write, so the review the child posted outlives it.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolveRange } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { openSqliteStorage, publishReview } from "@melian-agent/pipeline";
import { type FakeState, fakeGitHub } from "./fake-github.ts";
import { isolatedGitEnv, openPublishHarness, scenarioModels } from "./scenario.ts";

const [repo, database, stateFile, log] = process.argv.slice(2) as [string, string, string, string];
Object.assign(process.env, isolatedGitEnv);

const state = JSON.parse(readFileSync(stateFile, "utf8")) as FakeState;
const fetch = fakeGitHub(state, async (call) => {
	writeFileSync(stateFile, JSON.stringify(state));
	if (call.method !== "POST" || !call.path.endsWith("/reviews")) return;
	appendFileSync(log, "review-posted\n");
	await new Promise(() => setInterval(() => {}, 60_000));
});
const provider = createGitHubProvider({ owner: state.owner, repo: state.repo, token: "test-token", fetch });
const harness = await openPublishHarness(await openSqliteStorage(database), scenarioModels(), provider);
const changeset = await resolveRange(repo, "main...feature");
await publishReview({
	harness,
	provider,
	changeset,
	base: changeset.revision.base,
	pullRequest: await provider.pullRequest(state.pull.number),
});
