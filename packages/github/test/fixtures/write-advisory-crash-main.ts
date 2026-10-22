import { rmSync } from "node:fs";
import { createGitHubProvider } from "@melian-agent/github";
import { backgroundContext as context, createMemoryStorage, publishReview } from "@melian-agent/pipeline";
import { VerdictDocument } from "../../../pipeline/src/adjudication.ts";
import { FindingsDocument } from "../../../pipeline/src/findings.ts";
import { PublishedDocument, PublisherDocument } from "../../../pipeline/src/publish.ts";
import { fakeGitHub } from "./fake-github.ts";
import {
	emptyName,
	isolatedGitEnv,
	lensScript,
	moveTo,
	openPublishHarness,
	pullRequestState,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
} from "./scenario.ts";

// Run from an archive of 9923246b with workspace imports directed to that archive. That build posts an advisory inline;
// this records the state it leaves when it dies after GitHub accepted the review and before the round's record commit.
Object.assign(process.env, isolatedGitEnv);
const repo = scenarioRepository();
const state = pullRequestState();
const provider = createGitHubProvider({
	owner: state.owner,
	repo: state.repo,
	token: "test-token",
	fetch: fakeGitHub(state),
});
const fake = scenarioModels();
const harness = await openPublishHarness(createMemoryStorage(), fake, provider);
const { changeset, review } = await reviewScenario(repo, harness, fake, lensScript(emptyName));
await review;
moveTo(state, changeset);
const root = await harness.root(context);
const post = provider.postReview.bind(provider);
provider.postReview = async (draft) => {
	await post(draft);
	const recorded = structuredClone({
		writtenBy: "9923246b7814e487f7cc102db68551a7017c9242",
		changeset: changeset.toJSON(),
		state,
		findings: await harness.snapshot(FindingsDocument, root.id, context),
		verdicts: await harness.snapshot(VerdictDocument, root.id, context),
		published: await harness.snapshot(PublishedDocument, root.id, context),
		publisher: await harness.snapshot(PublisherDocument, root.id, context),
	});
	process.stdout.write(`${JSON.stringify(recorded, null, 2)}\n`);
	rmSync(repo, { recursive: true, force: true });
	process.exit(0);
};
await publishReview({
	harness,
	provider,
	changeset,
	pullRequest: await provider.pullRequest(7),
	base: changeset.revision.base,
	trustedWriters: true,
});
throw new Error("The review was never posted");
