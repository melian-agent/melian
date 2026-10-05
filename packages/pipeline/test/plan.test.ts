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
	readFindings,
	readProvenance,
	reviewChangeset,
	revisionKey,
	type TaskId,
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
import { LensDocument } from "../src/lens-tools.ts";
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

	it("fails every lens on a tier whose accepted models have no credentials under unavailable: fail, asking no model", async () => {
		const { review, answered } = await planned({
			model: "nowhere/opus",
			accept: ["nowhere/opus"],
			unavailable: "fail",
		});

		expect(answered).toEqual([]);
		expect(review.verdict.status).toBe("not-reviewed");
		const reason =
			"none of nowhere/opus, which models.heavy accepts, has credentials, and models.heavy.unavailable is fail";
		expect(review.verdict.notRun.filter((check) => check.name.startsWith("lens."))).toEqual([
			{ name: "lens.contracts", status: "failed", level: "careful", reason },
			{ name: "lens.correctness", status: "failed", level: "careful", reason },
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

	it("drops an earlier run's sightings even when a review that selected no lens left the index naming no run", async () => {
		await planned({ model: heavy, accept: [heavy] }, backup, { reports: "backup" });
		// A review of the fast tier selects no lens, and rewrites the revision's entry without a lens task.
		const changeset = await Changeset.resolve(repo, "main...feature");
		const config: MelianConfig = { ...defaultConfig, tiers: twoLensTiers, models: { heavy: { model: heavy } } };
		await reviewChangeset({
			harness,
			changeset,
			config,
			lenses,
			standards: [],
			models: fake.review,
			tier: "fast",
			checks: [
				{ name: "guardrails", status: "ran" },
				{ name: "static.biome", status: "ran" },
				{ name: "static.tsc", status: "ran" },
				{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
			],
		});
		const root = await harness.root(context);
		const revision = revisionKey(changeset.revision);
		expect((await harness.snapshot(ReviewIndex, root.id, context))?.reviews[revision]?.task).toBeUndefined();

		const again = await planned({ model: heavy, accept: [heavy] });

		expect(again.answered).toEqual(["heavy", "heavy"]);
		expect(again.review.verdict.attention()).toEqual([]);
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

describe("a lens run a later review replaced", () => {
	// Holds the correctness lens in its first model request, replaces its run in the review index, as a later review's
	// commit does before it aborts the run, then lets the request answer with a report. With `stripTask`, the lens
	// conversations' policies lose their task, as one an older Melian spawned never had it.
	async function reportAfterReplacement(stripTask: boolean) {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached = () => {};
		const asked = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const requests = scriptConversations(fake, [
			{
				match: correctness,
				replies: [
					async () => {
						reached();
						await held;
						return fauxAssistantMessage(fauxToolCall("report_finding", wrongResult), { stopReason: "toolUse" });
					},
					fauxAssistantMessage("Done."),
				],
			},
			{ match: contracts, replies: [fauxAssistantMessage("No findings.")] },
		]);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const config: MelianConfig = { ...defaultConfig, tiers: twoLensTiers, models: { heavy: { model: heavy } } };
		const running = reviewChangeset({ harness, changeset, config, lenses, standards: [], models: fake.review }).catch(
			(error: unknown) => error,
		);
		await asked;
		const root = await harness.root(context);
		const revision = revisionKey(changeset.revision);
		await root.commit(async (tx) => {
			const index = await tx.doc(ReviewIndex, root.id);
			const entry = index.reviews[revision]!;
			const record = await tx.task(entry.task as TaskId);
			const children = (record?.state as { checkpoint?: { children?: Record<string, number> } } | undefined)
				?.checkpoint?.children;
			index.reviews[revision] = { ...entry, task: 999_999 };
			if (!stripTask) return;
			for (const child of Object.values(children ?? {})) {
				const document = await tx.doc(LensDocument, child as never);
				const { task: _, ...policy } = document.lens!;
				document.lens = policy;
			}
		}, context);
		release();
		await running;
		return { requests, findings: await readFindings(harness, root.id, revision, context) };
	}

	it("asks no model on its next attempt once the index names another run", async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached = () => {};
		const asked = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const askedBy: string[] = [];
		const answer = async (_: readonly Message[], model: string) => {
			askedBy.push(model);
			if (model === "backup") return fauxAssistantMessage("No findings.");
			reached();
			await held;
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded_error" });
		};
		scriptConversations(fake, [
			{ match: correctness, replies: [answer, answer] },
			{ match: contracts, replies: [fauxAssistantMessage("No findings.")] },
		]);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const config: MelianConfig = {
			...defaultConfig,
			tiers: twoLensTiers,
			models: { heavy: { model: heavy, fallbacks: [backup] } },
		};
		const running = reviewChangeset({ harness, changeset, config, lenses, standards: [], models: fake.review }).catch(
			(error: unknown) => error,
		);
		await asked;
		const root = await harness.root(context);
		const revision = revisionKey(changeset.revision);
		await root.commit(async (tx) => {
			const index = await tx.doc(ReviewIndex, root.id);
			index.reviews[revision] = { ...index.reviews[revision]!, task: 999_999 };
		}, context);
		release();
		await running;

		// The heavy model failed over, and the next attempt, on backup, never reached the model.
		expect(askedBy).toEqual(["heavy"]);
	});

	it.each([
		["", false],
		[", even in a conversation whose policy names no task, as an older Melian's", true],
	])("has its report refused once the index names another run%s", async (_, stripTask) => {
		const { requests, findings } = await reportAfterReplacement(stripTask);

		const results = requests[correctness]![1]!.filter((message) => message.role === "toolResult");
		expect(results.map((message) => JSON.stringify(message.content))).toEqual([
			expect.stringContaining("superseded: a later review of this revision replaced this run"),
		]);
		expect(findings).toEqual([]);
	});
});
