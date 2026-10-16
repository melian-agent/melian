import { Changeset, defaultConfig, Lens } from "@melian-agent/core";
import {
	backgroundContext as context,
	openReviewHarness,
	openSqliteStorage,
	reviewChangeset,
} from "../../src/index.ts";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "../../src/testing.ts";
import { isolatedGitEnv } from "./repo.ts";
import { record } from "./review-scenario.ts";

const [repo, database, log] = process.argv.slice(2) as [string, string, string];
Object.assign(process.env, isolatedGitEnv);
const fake = createFakeModels();
scriptConversations(fake, [
	{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Finished.")] },
]);
const storage = await openSqliteStorage(database);
const commit = storage.commit.bind(storage);
storage.commit = async (writes, commitContext) => {
	if (
		writes.some(
			(write) =>
				write.type === "task" && write.value.kind === "melian.lenses" && write.value.state.status === "terminal",
		)
	) {
		record(log, { event: "run-settled" });
		await new Promise<never>(() => setInterval(() => {}, 1000));
	}
	return commit(writes, commitContext);
};
const handle = await openReviewHarness(storage, fake.review, { retry: false });
const changeset = await Changeset.resolve(repo, "main...feature");
await reviewChangeset({
	harness: handle,
	changeset,
	config: {
		...defaultConfig,
		tiers: { full: ["lens.correctness"] },
		models: { heavy: { model: `${fake.ref().provider}/${fake.ref().modelId}` } },
	},
	lenses: await Lens.builtins(),
	standards: [],
	models: fake.review,
	checks: [],
});
await handle.close(context);
