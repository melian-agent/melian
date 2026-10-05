import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	Lens,
	type LensSettings,
	type MelianConfig,
	type ModelRoute,
	ReviewPlan,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	type Message,
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
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewIndex } from "../src/review-index.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";

// The one finding a reporting model's correctness lens reports, on the line the change rewrites.
const wrongResult = {
	file: "src/a.ts",
	line: 1,
	rule: "wrong-result",
	severity: "P2",
	explanation: { what: "a is 2 now.", why: "This change rewrote it.", fix: "Restore 1." },
	failureScenario: "Reading a returns 2 where every caller expects 1.",
	evidence: [{ file: "src/a.ts", line: 1, role: "cause" }],
};
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

// A review whose committed melian.yaml routes heavy as `committed`, with melian.local.yaml routing it to `local`, or,
// with `light`, moving both lenses to a light tier it routes to that model.
async function planned(
	committed: ModelRoute,
	local?: string,
	options: {
		light?: string;
		lightFallbacks?: string[];
		fails?: string;
		reports?: string;
		rerun?: boolean;
		contractsPaths?: string[];
	} = {},
) {
	const { light } = options;
	const moved: Record<string, LensSettings> =
		light === undefined ? {} : { correctness: { tier: "light" }, contracts: { tier: "light" } };
	const config: MelianConfig = {
		...defaultConfig,
		tiers: twoLensTiers,
		lenses: {
			...moved,
			...(options.contractsPaths === undefined
				? {}
				: { contracts: { ...moved.contracts, paths: options.contractsPaths } }),
		},
		models: {
			heavy: local === undefined ? committed : { ...committed, model: local },
			...(light === undefined ? {} : { light: { model: light, fallbacks: options.lightFallbacks ?? [] } }),
		},
	};
	const { catalogue, credentials } = await planInputs(fake.review);
	const plan = ReviewPlan.resolve({
		config,
		routes: {
			committed: { heavy: committed },
			overridden: {
				...(local === undefined ? {} : { heavy: "melian.local.yaml" }),
				...(light === undefined ? {} : { light: "melian.local.yaml" }),
			},
			lensTiers: {},
			retiered: Object.fromEntries(Object.keys(moved).map((name) => [name, "melian.local.yaml"])),
		},
		catalogue,
		credentials,
		lenses,
		checks: ["lens.correctness", "lens.contracts"],
	});
	const changeset = await Changeset.resolve(repo, "main...feature");
	const answered: string[] = [];
	const answer = (messages: readonly Message[], modelId: string) => {
		answered.push(modelId);
		if (modelId === options.fails)
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded_error" });
		const reporting = modelId === options.reports && systemPromptOf(messages).includes(correctness);
		if (reporting && !messages.some((message) => message.role === "toolResult")) {
			return fauxAssistantMessage(fauxToolCall("report_finding", wrongResult), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("No findings.");
	};
	scriptConversations(fake, [
		{ match: correctness, replies: [answer, answer, answer] },
		{ match: contracts, replies: [answer, answer, answer] },
	]);
	const review = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: [],
		models: fake.review,
		plan,
		rerun: options.rerun === true,
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

	it("keeps a lens a preference file moved to another tier under its committed tier's policy", async () => {
		const { review, answered } = await planned(
			{ model: heavy, accept: [heavy], acceptOverridden: false },
			undefined,
			{
				light: backup,
			},
		);

		expect(answered).toEqual([]);
		expect(review.verdict.status).toBe("not-reviewed");
		const reason = `lenses.correctness.tier moves it from heavy to light, and models.heavy.acceptOverridden is false; light runs ${backup}, which models.heavy.accept does not list`;
		expect(review.verdict.notRun.find((check) => check.name === "lens.correctness")).toEqual({
			name: "lens.correctness",
			status: "failed",
			level: "careful",
			reason,
			lineage: {
				model: backup,
				wanted: heavy,
				by: "melian.local.yaml",
				moved: { by: "melian.local.yaml", from: "heavy", to: "light" },
				outside: true,
			},
		});
	});

	it("runs the lenses again under another plan, and records only the lineage of the route that ran", async () => {
		const first = await planned({ model: heavy, accept: [heavy] }, backup);
		const second = await planned({ model: heavy, accept: [heavy] });

		expect(first.answered).toEqual(["backup", "backup"]);
		expect(second.answered).toEqual(["heavy", "heavy"]);
		const lenses = second.review.verdict.ran?.filter((check) => check.name.startsWith("lens.")) ?? [];
		expect(lenses).toHaveLength(2);
		expect(lenses.every((check) => check.lineage === undefined)).toBe(true);
	});

	it("records the fallback a lens finished on, outside accept, when its accepted model failed", async () => {
		const { review, answered } = await planned({ model: heavy, fallbacks: [backup], accept: [heavy] }, undefined, {
			fails: "heavy",
		});

		expect([...answered].sort()).toEqual(["backup", "backup", "heavy", "heavy"]);
		const lineage = { model: backup, wanted: heavy, by: "melian.yaml", outside: true };
		expect(review.verdict.ran).toEqual(
			expect.arrayContaining([
				{ name: "lens.contracts", status: "ran", level: "careful", lineage },
				{ name: "lens.correctness", status: "ran", level: "careful", lineage },
			]),
		);
	});

	it("records a lens on a refused tier whose paths the change does not touch as skipped, not failed", async () => {
		const { review, answered } = await planned({ model: heavy, accept: [heavy], acceptOverridden: false }, backup, {
			contractsPaths: ["docs/**"],
		});

		expect(answered).toEqual([]);
		const record = (name: string) =>
			[...review.verdict.notRun, ...(review.verdict.ran ?? [])].find((check) => check.name === name);
		expect(record("lens.correctness")).toMatchObject({ status: "failed" });
		expect(record("lens.contracts")).toEqual({ name: "lens.contracts", status: "skipped", reason: "no paths" });
	});

	it("runs again under --rerun a lens the plan failed for finishing on a refused fallback", async () => {
		// Each lens moves to light, whose route starts inside heavy's accept and falls back outside it.
		const committed = { model: heavy, accept: [heavy], acceptOverridden: false };
		const options = { light: heavy, lightFallbacks: [backup], fails: "heavy" };
		const first = await planned(committed, undefined, options);
		const again = await planned(committed, undefined, { ...options, rerun: true });

		expect([...first.answered].sort()).toEqual(["backup", "backup", "heavy", "heavy"]);
		expect(first.review.verdict.notRun.find((check) => check.name === "lens.correctness")).toMatchObject({
			status: "failed",
			reason: expect.stringContaining(`light runs ${backup}, which models.heavy.accept does not list`),
		});
		// The stored outcome says done, but the plan refuses the model it finished on, so --rerun does not reuse it.
		expect([...again.answered].sort()).toEqual(["backup", "backup", "heavy", "heavy"]);
	});

	it("reads only the sightings of the run on the route the review ran, not an earlier run's", async () => {
		const first = await planned({ model: heavy, accept: [heavy] }, backup, { reports: "backup" });
		const second = await planned({ model: heavy, accept: [heavy] });

		expect(first.review.verdict.attention().map((finding) => finding.ruleId)).toEqual(["wrong-result"]);
		expect(second.answered).toEqual(["heavy", "heavy"]);
		expect(second.review.findings).toEqual([]);
		expect(second.review.verdict.attention()).toEqual([]);
		expect(second.review.verdict.status).toBe("passed");
	});

	it("treats an index entry from before routes joined its key as stale, and reads only the run that replaces it", async () => {
		await planned({ model: heavy, accept: [heavy] }, undefined, { reports: "heavy" });
		// The entry as review index version 2 stored it: each lens by name and version, with no route.
		const root = await harness.root(context);
		const revision = revisionKey((await Changeset.resolve(repo, "main...feature")).revision);
		await root.commit(async (tx) => {
			const index = await tx.doc(ReviewIndex, root.id);
			const entry = index.reviews[revision]!;
			index.reviews[revision] = { ...entry, lenses: entry.lenses.map((lens) => lens.split(" on ")[0]!) };
		}, context);

		const again = await planned({ model: heavy, accept: [heavy] });

		expect(again.answered).toEqual(["heavy", "heavy"]);
		expect(again.review.verdict.attention()).toEqual([]);
	});

	it("runs the committed route with no lineage when the preference file stays on it", async () => {
		const { review, answered } = await planned({ model: heavy, fallbacks: [backup] });

		expect(answered).toEqual(["heavy", "heavy"]);
		expect(review.verdict.ran?.every((check) => check.lineage === undefined)).toBe(true);
	});
});
