// One uninterrupted review of the scenario: the verdict store B must match. Run from the worktree root:
// node --conditions=@melian-agent/source spikes/record-372/reference.ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { backgroundContext as context, reviewChangeset, runChecks } from "@melian-agent/pipeline";
import { config, fakeModels, lensRequests, open, repository, scratch, setup } from "./scenario.ts";

export async function reference(repo: string) {
	const scene = await setup(repo);
	const { fake, requests } = fakeModels(scene.lenses);
	const harness = await open(repo, join(mkdtempSync(join(scratch, "ref-")), "store.sqlite"), fake);
	const policy = config(scene, fake);
	const root = (await harness.root(context)).id;
	const run = await runChecks(
		harness,
		{ rootConversationId: root, changeset: scene.changeset, config: policy, source: scene.source, tier: "full" },
		context,
	);
	const review = await reviewChangeset({
		harness,
		changeset: scene.changeset,
		config: policy,
		lenses: scene.lenses,
		standards: [],
		models: fake.review,
		checks: run.records,
	});
	await harness.close(context);
	return { verdict: review.verdict.toJSON(), checks: run.records, requests: lensRequests(requests, scene.lenses) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const result = await reference(repository());
	console.log(JSON.stringify(result, null, 2));
}
