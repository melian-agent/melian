// A review of a level that probes over SQLite, for a crash test: trust-boundary at deep with a prober on its own level's
// route, which holds two providers, `first` and `second`, so a failover is visible in the providers a task resumes.
import { Changeset, defaultConfig, Lens, type MelianConfig } from "@melian-agent/core";
import { openSqliteStorage } from "../../src/harness.ts";
import type { ProbeSandbox } from "../../src/probe.ts";
import { ReviewHarness, reviewChangeset } from "../../src/review.ts";
import { createFakeModels, type ScriptedReply, scriptConversations, unconfinedSandbox } from "../../src/testing.ts";

export const plannerMatch = "Your role at this level: the attack planner";
export const proberMatch = "You are the prober for the trust-boundary lens";

/** The replies each provider gives each role. */
export type ProbingReplies = Record<"first" | "second", { planner: ScriptedReply[]; prober: ScriptedReply[] }>;

export async function probingReview(
	repo: string,
	database: string,
	replies: ProbingReplies,
	sandbox: ProbeSandbox = unconfinedSandbox(),
) {
	const first = createFakeModels({ provider: "first", models: [{ id: "a" }] });
	const second = createFakeModels({ provider: "second", models: [{ id: "b" }] }, first.review);
	const [requests] = (
		[
			[first, replies.first],
			[second, replies.second],
		] as const
	).map(([fake, scripted]) =>
		scriptConversations(fake, [
			{ match: plannerMatch, replies: scripted.planner },
			{ match: proberMatch, replies: scripted.prober },
		]),
	);
	const harness = await ReviewHarness.open(await openSqliteStorage(database), first.review, {
		retry: false,
		probeSandbox: sandbox,
	});
	const changeset = await Changeset.resolve(repo, "main...feature");
	const lenses = (await Lens.load(repo, { kind: "revision", commit: changeset.revision.base }, [])).map((lens) =>
		lens.name === "trust-boundary"
			? Lens.from({ ...lens.toJSON(), levels: { ...lens.levels, deep: { ...lens.level("deep"), probe: {} } } })
			: lens,
	);
	const config: MelianConfig = {
		...defaultConfig,
		tiers: { full: ["lens.trust-boundary"] },
		lenses: { "trust-boundary": { level: { floor: "deep" } } },
		models: { heavy: { model: "first/a", fallbacks: ["second/b"] } },
	};
	const review = () =>
		reviewChangeset({
			harness,
			changeset,
			config,
			lenses,
			standards: [],
			models: first.review,
			writer: { trusted: true, by: "reviewer" },
		});
	return { harness, review, requests: requests! };
}
