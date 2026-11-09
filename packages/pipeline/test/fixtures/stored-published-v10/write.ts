import { rmSync } from "node:fs";
import { Revision } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	openSqliteStorage,
	publishReview,
	ReviewError,
	readFindings,
	recordDismissal,
} from "@melian-agent/pipeline";
import { fakeGitHub } from "../../../../github/test/fixtures/fake-github.ts";
import {
	emptyName,
	isolatedGitEnv,
	lensScript,
	moveTo,
	nanRetries,
	openPublishHarness,
	pullRequestState,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
	unsafeManager,
} from "../../../../github/test/fixtures/scenario.ts";
import { PublishedDocument } from "../../../src/publish.ts";

// Publishes a review, dismisses one finding and publishes again, into the SQLite file named by the first argument, and
// prints the published document with its root's ID.
const [path] = process.argv.slice(2);
Object.assign(process.env, isolatedGitEnv);
const repo = scenarioRepository();
const fake = scenarioModels();
const state = pullRequestState();
const github = createGitHubProvider({
	owner: state.owner,
	repo: state.repo,
	token: "test-token",
	fetch: fakeGitHub(state),
});
const harness = await openPublishHarness(await openSqliteStorage(path!), fake, github);
try {
	const { changeset, review } = await reviewScenario(
		repo,
		harness,
		fake,
		lensScript(unsafeManager, emptyName, nanRetries),
	);
	await review.catch((error: unknown) => {
		if (!(error instanceof ReviewError)) throw error;
	});
	moveTo(state, changeset);
	const publish = async () =>
		publishReview({
			harness,
			provider: github,
			changeset,
			pullRequest: await github.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: true,
		});
	await publish();
	const root = await harness.root(context);
	const revision = Revision.key(changeset.revision);
	const manager = (await readFindings(harness, root.id, revision, context)).find(
		(finding) => finding.ruleId === "null-dereference",
	)!;
	await recordDismissal({
		harness,
		revision: changeset.revision,
		id: manager.properties.id,
		dismissal: { by: "Tal", reason: "The manager is always set here.", at: "2026-10-04T00:00:00.000Z" },
		repoRoot: repo,
	});
	await publish();
	const published = await harness.snapshot(PublishedDocument, root.id, context);
	process.stdout.write(
		`${JSON.stringify({ root: root.id, version: PublishedDocument.definition.version, published }, null, 2)}\n`,
	);
} finally {
	await harness.close(context);
	rmSync(repo, { recursive: true, force: true });
}
