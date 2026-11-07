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

const [output, commit, tier] = process.argv.slice(2);
const full = tier.split(",");
mkdirSync(output, { recursive: true });
const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true } });
// tsc quotes the type it names, and Biome the unused variable, so a stored finding holds the fake token as a tool's own
// text.
const repo = baseAndHead(
	{ "tsconfig.json": tsconfig, "a.ts": "export const n = 1;\n" },
	{ "a.ts": "const ghp_FAKEoutsideTOKEN281 = 1;\nexport const n: { ghp_FAKEoutsideTOKEN281: 1 } = 1;\n" },
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
	config: { ...defaultConfig, tiers: { full } },
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
const quoted = JSON.stringify(result.verdict.findings).includes("not assignable to type '{ ghp_FAKEoutsideTOKEN281")
	|| JSON.stringify(result.verdict.findings).includes("This variable ghp_FAKEoutsideTOKEN281 is unused");
if (quoted !== full.some((check) => check === "static.biome" || check === "static.tsc"))
	throw new Error(`a tool's text was ${quoted ? "" : "not "}stored for ${tier}`);
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
	`${JSON.stringify({ commit, tier: full, changeset: changeset.toJSON(), pending: tasks[0].record.id, state }, null, 2)}\n`,
);
rmSync(repo, { recursive: true, force: true });
