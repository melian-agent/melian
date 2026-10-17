import { rmSync } from "node:fs";
import { Adjudication, Changeset, defaultConfig, evaluateGuardrails, Finding } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	createMemoryStorage,
	dismissFinding,
	publishReview,
	readFindings,
	revisionKey,
	upsertFinding,
} from "@melian-agent/pipeline";
import { VerdictDocument } from "../../../pipeline/src/adjudication.ts";
import { baseAndHead } from "../../../pipeline/test/fixtures/repo.ts";
import { fakeGitHub } from "./fake-github.ts";
import { moveTo, openPublishHarness, pullRequestState, scenarioModels } from "./scenario.ts";

// Run at 3207a611 before changing the publish task. Uses fake models and GitHub alone.
const repo = baseAndHead({ "AGENTS.md": "Old guidance.\n" }, { "AGENTS.md": "New guidance.\n" });
const { revision } = await Changeset.resolve(repo, "main...feature");
const changeset = await Changeset.resolve(repo, "main...feature");
const state = pullRequestState();
moveTo(state, changeset);
state.failReviews = true;
const provider = createGitHubProvider({
	owner: state.owner,
	repo: state.repo,
	token: "test-token",
	fetch: fakeGitHub(state),
});
const storage = createMemoryStorage();
const harness = await openPublishHarness(storage, scenarioModels(), provider);
let task: Awaited<ReturnType<typeof storage.scanTasks>>["items"][number] | undefined;
const post = provider.postReview.bind(provider);
provider.postReview = async (draft) => {
	task = (await storage.scanTasks({}, 100, undefined, context)).items.find((each) => each.kind === "melian.publish");
	return post(draft);
};
try {
	const root = await harness.root(context);
	const key = revisionKey(revision);
	const { findings } = await evaluateGuardrails({
		repoRoot: repo,
		revision,
		source: { kind: "revision", commit: revision.base },
	});
	const notice = findings[0]!;
	const acknowledgement = Finding.create({
		rule: "unsafe",
		file: "src/a.ts",
		startLine: 1,
		snippet: "unsafe(input)",
		occurrence: 0,
		severity: "P2",
		cause: "introduced",
		source: { check: "static.example" },
		message: "Unsafe input.",
		explanation: { what: "Unsafe input.", whyHere: "New call.", whatToDo: "Validate it." },
	});
	await root.commit(async (tx) => {
		await upsertFinding(tx, root.id, notice, key);
		await upsertFinding(tx, root.id, acknowledgement, key);
		await dismissFinding(tx, root.id, notice.id, {
			by: "Maintainer",
			at: "2026-10-17T00:00:00Z",
			reason: "Guidance reviewed.",
		});
	}, context);
	const verdict = new Adjudication({
		findings: await readFindings(harness, root.id, key, context),
		manifest: [],
		checks: [],
		config: defaultConfig,
	}).adjudicate();
	await root.commit(async (tx) => {
		const doc = await tx.doc(VerdictDocument, root.id);
		doc.verdicts[key] = verdict.toJSON();
		doc.provenance = {
			[key]: {
				kind: "pull-request",
				manifest: [],
				lenses: [],
				repository: { owner: state.owner, name: state.repo },
				pullRequest: 7,
				base: revision.base,
				head: revision.head,
				policy: `revision:${revision.base}`,
			},
		};
	}, context);
	try {
		await publishReview({
			harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: revision.base,
			trustedWriters: true,
		});
		throw new Error("Expected the fake to refuse the review");
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("refused")) throw error;
	}
	if (task === undefined || task.state.status !== "running")
		throw new Error("No running publish checkpoint was recorded");
	process.stdout.write(
		`${JSON.stringify({ writtenBy: "3207a611", kind: task.kind, version: task.version, input: task.input, checkpoint: task.state.checkpoint }, null, 2)}\n`,
	);
} finally {
	await harness.close(context);
	rmSync(repo, { recursive: true, force: true });
}
