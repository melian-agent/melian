import { rmSync } from "node:fs";
import { Changeset, defaultConfig, Lens, type MelianConfig, type ModelRoute, ReviewPlan } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	planInputs,
	readProvenance,
	reviewChangeset,
	revisionKey,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";

let repo: string;
let fake: FakeModels;
let harness: Harness;
let lenses: Lens[];
let heavy: string;
let backup: string;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }, { id: "backup" }] });
	heavy = `${fake.ref("heavy").provider}/heavy`;
	backup = `${fake.ref("backup").provider}/backup`;
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	lenses = await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/a.ts"]);
});

afterEach(async () => {
	await harness.close(context);
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

// A review whose committed melian.yaml routes heavy as `committed`, with melian.local.yaml routing it to `local`.
async function planned(committed: ModelRoute, local?: string) {
	const config: MelianConfig = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: { heavy: local === undefined ? committed : { ...committed, model: local } },
	};
	const { catalogue, credentials } = await planInputs(fake.review);
	const plan = ReviewPlan.resolve({
		config,
		routes: {
			committed: { heavy: committed },
			overridden: local === undefined ? {} : { heavy: "melian.local.yaml" },
		},
		catalogue,
		credentials,
		lenses,
		checks: ["lens.correctness", "lens.contracts"],
	});
	const changeset = await Changeset.resolve(repo, "main...feature");
	const answered: string[] = [];
	const answer = (_: unknown, modelId: string) => {
		answered.push(modelId);
		return fauxAssistantMessage("No findings.");
	};
	scriptConversations(fake, [
		{ match: correctness, replies: [answer] },
		{ match: contracts, replies: [answer] },
	]);
	const review = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: [],
		models: fake.review,
		plan,
		checks: [
			{ name: "guardrails", status: "ran" },
			{ name: "static.biome", status: "ran" },
			{ name: "static.tsc", status: "ran" },
			{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
			// The host's record of a lens gives way to the lens step's, as without a plan.
			{ name: "lens.correctness", status: "skipped", reason: "lenses run in the review" },
		],
	});
	const root = (await harness.root(context)).id;
	const provenance = await readProvenance(harness, root, revisionKey(changeset.revision), context);
	return { plan, review, answered, provenance };
}

describe("reviewChangeset with a plan", () => {
	it("runs each lens on the plan's route, records the lineage of one a preference file moved, and keeps the plan", async () => {
		const { plan, review, answered, provenance } = await planned({ model: heavy, accept: [heavy] }, backup);

		expect(answered).toEqual(["backup", "backup"]);
		const lineage = { model: backup, wanted: heavy, by: "melian.local.yaml", outside: true };
		expect(review.verdict.status).toBe("passed");
		expect(review.verdict.ran).toEqual(
			expect.arrayContaining([
				{ name: "lens.contracts", status: "ran", level: "careful", lineage },
				{ name: "lens.correctness", status: "ran", level: "careful", lineage },
			]),
		);
		expect(review.verdict.render()).toContain("2 checks left the committed routes:");
		expect(provenance?.plan).toEqual(plan.toJSON());
		expect(ReviewPlan.from(provenance!.plan!).summary()).toContain(`heavy runs ${backup}, set by melian.local.yaml`);
	});

	it("fails every lens on a tier policy refuses without asking a model, so the verdict is not reviewed", async () => {
		const { review, answered } = await planned({ model: heavy, accept: [heavy], acceptOverridden: false }, backup);

		expect(answered).toEqual([]);
		expect(review.verdict.status).toBe("not-reviewed");
		const reason = `models.heavy.acceptOverridden is false, and melian.local.yaml puts it on ${backup}, which models.heavy.accept does not list`;
		const lineage = { model: backup, wanted: heavy, by: "melian.local.yaml", outside: true };
		expect(review.verdict.notRun.filter((check) => check.name.startsWith("lens."))).toEqual([
			{ name: "lens.contracts", status: "failed", level: "careful", reason, lineage },
			{ name: "lens.correctness", status: "failed", level: "careful", reason, lineage },
		]);
	});

	it("runs the committed route with no lineage when the preference file stays on it", async () => {
		const { review, answered } = await planned({ model: heavy, fallbacks: [backup] });

		expect(answered).toEqual(["heavy", "heavy"]);
		expect(review.verdict.ran?.every((check) => check.lineage === undefined)).toBe(true);
	});
});
