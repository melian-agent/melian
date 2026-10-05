// Publishes a reviewed pull request in its own process and parks at the review's post, so the parent can SIGKILL it
// there. With `after-review`, the default, it parks once GitHub has accepted the review and before the publish task can
// record it, logging `review-posted`; with `before-review`, it parks before GitHub has anything, logging
// `review-requested`. The fake GitHub's state is written to a file after every write, so a post outlives the child.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Changeset } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { openSqliteStorage, publishReview } from "@melian-agent/pipeline";
import { type Call, type FakeState, fakeGitHub } from "./fake-github.ts";
import { isolatedGitEnv, openPublishHarness, scenarioModels } from "./scenario.ts";

const [repo, database, stateFile, log, mode = "after-review", range = "main...feature"] = process.argv.slice(2) as [
	string,
	string,
	string,
	string,
	string?,
	string?,
];
Object.assign(process.env, isolatedGitEnv);

const isReview = (call: Call) => call.method === "POST" && call.path.endsWith("/reviews");
const park = (event: string) => {
	appendFileSync(log, `${event}\n`);
	return new Promise<void>(() => setInterval(() => {}, 60_000));
};

const state = JSON.parse(readFileSync(stateFile, "utf8")) as FakeState;
const fetch = fakeGitHub(
	state,
	async (call) => {
		writeFileSync(stateFile, JSON.stringify(state));
		if (mode === "after-review" && isReview(call)) await park("review-posted");
		if (mode === "after-ledger-edit" && call.method === "PATCH" && call.path.includes("/issues/comments/"))
			await park("ledger-edited");
	},
	async (call) => {
		if (mode === "before-review" && isReview(call)) await park("review-requested");
	},
);
const provider = createGitHubProvider({ owner: state.owner, repo: state.repo, token: "test-token", fetch });
const harness = await openPublishHarness(await openSqliteStorage(database), scenarioModels(), provider);
const changeset = await Changeset.resolve(repo, range);
await publishReview({
	harness,
	provider,
	changeset,
	base: changeset.revision.base,
	pullRequest: await provider.pullRequest(state.pull.number),
});
