// Copy to the named historical source tree's root and run with --conditions=@melian-agent/source.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, defaultConfig } from "./packages/core/src/index.ts";
import { createGitHubProvider } from "./packages/github/src/index.ts";
import { fakeGitHub } from "./packages/github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "./packages/github/test/fixtures/scenario.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openReviewHarness,
	openSqliteStorage,
	publishExtension,
	publishReview,
	reviewChangeset,
} from "./packages/pipeline/src/index.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";
import { baseAndHead, gitIn } from "./packages/pipeline/test/fixtures/repo.ts";

const [output, commit] = process.argv.slice(2);
mkdirSync(output, { recursive: true });
const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true } });
// tsc quotes the type it names, so the stored finding holds the fake token as tsc's own text.
const repo = baseAndHead(
	{ "tsconfig.json": tsconfig, "a.ts": "export const n = 1;\n" },
	{ "a.ts": "export const n: { ghp_FAKEoutsideTOKEN281: 1 } = 1;\n" },
);
const changeset = await Changeset.resolve(repo, "main...feature");
const state = pullRequestState();
moveTo(state, changeset);
const provider = createGitHubProvider({
	owner: state.owner,
	repo: state.repo,
	token: "test-token",
	fetch: fakeGitHub(state),
});
const fake = createFakeModels();
const path = join(output, "pending.sqlite");
const review = await openReviewHarness(await openSqliteStorage(path), fake.review, { retry: false, checkout: repo });
const result = await reviewChangeset({
	harness: review,
	changeset,
	config: { ...defaultConfig, tiers: { full: ["static.tsc"] } },
	lenses: [],
	standards: [],
	models: fake.review,
	policy: { kind: "revision", commit: changeset.revision.base },
	origin: {
		kind: "pull-request",
		repository: { owner: state.owner, name: state.repo },
		pullRequest: 7,
		base: changeset.revision.base,
		head: changeset.revision.head,
	},
});
if (!JSON.stringify(result.verdict).includes("ghp_FAKEoutsideTOKEN281")) throw new Error("tsc's text was not stored");
await review.close(context);
const registry = createReviewRegistry();
registry.install(publishExtension(provider));
const harness = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
harness.resume = () => {};
harness.waitForTask = async () => {
	throw new Error("capture before pending publication runs");
};
try {
	await publishReview({
		harness,
		changeset,
		provider,
		pullRequest: await provider.pullRequest(7),
		base: changeset.revision.base,
		trustedWriters: true,
	});
	throw new Error("capture did not park");
} catch (error) {
	if (error.message !== "capture before pending publication runs") throw error;
}
const tasks = (await harness.inspect(context)).tasks.filter((each) => each.record.kind === "melian.publish");
if (tasks.length !== 1) throw new Error("expected one pending publication");
await harness.close(context);
gitIn(repo, "bundle", "create", join(output, "repo.bundle"), "--all");
writeFileSync(
	join(output, "recorded.json"),
	JSON.stringify({ commit, changeset: changeset.toJSON(), pending: tasks[0].record.id, state }, null, 2) + "\n",
);
rmSync(repo, { recursive: true, force: true });
