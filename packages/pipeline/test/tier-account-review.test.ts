import { rmSync } from "node:fs";
import {
	Changeset,
	type CheckRecord,
	type Decider,
	defaultConfig,
	Lens,
	type MelianConfig,
	mutationSkips,
	Revision,
	type ScrutinyLevel,
} from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import {
	backgroundContext as context,
	createMemoryStorage,
	type Harness,
	type Review,
	ReviewHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdjudicationTaskInput } from "../src/adjudication.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { gitIn, isolatedGitEnv, writeFiles } from "./fixtures/repo.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

// Pins the account a review gives its adjudication for each reason a skip may pass, one reason at a time: the checks
// its tier names, every check's record, and the skips it allows, in order.

const correctness = "You are the correctness reviewer";
const done = fauxAssistantMessage("Done.");

let repo: string;
let fake: FakeModels;
let reviewHarness: ReviewHarness | undefined;
let harness: Harness;
let lenses: Lens[];
let config: MelianConfig;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = crashRepository();
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "light" }, { id: "medium" }, { id: "heavy" }] });
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	config = {
		...defaultConfig,
		tiers: { ...defaultConfig.tiers, full: ["guardrails", "static", "lens.correctness"] },
		models: { light: route("light"), medium: route("medium"), heavy: route("heavy") },
	};
	lenses = await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"]);
});

afterEach(async () => {
	await reviewHarness?.close(context);
	reviewHarness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

async function open(decider?: Decider): Promise<void> {
	reviewHarness = await ReviewHarness.open(createMemoryStorage(), fake.review, {
		retry: false,
		...(decider === undefined ? {} : { decider }),
	});
	harness = reviewHarness.harness;
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
}

const ran: CheckRecord[] = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
];

function choosing(level: "skip" | ScrutinyLevel): RecordedDecider {
	return new RecordedDecider(
		{ triage: { version: "1", answers: { correctness: { distribution: { [level]: 1 } } } } },
		{ name: "recorded" },
	);
}

async function review(
	options: { config?: Partial<MelianConfig>; checks?: CheckRecord[]; decider?: Decider } = {},
): Promise<Review> {
	await open(options.decider);
	scriptConversations(fake, [{ match: correctness, replies: [done] }]);
	return reviewChangeset({
		harness,
		changeset: await Changeset.resolve(repo, "main...feature"),
		config: { ...config, ...options.config },
		lenses,
		standards: [],
		models: fake.review,
		checks: options.checks ?? ran,
		...(options.decider === undefined ? {} : { decider: options.decider }),
	});
}

// The account the review handed its adjudication: each check's name, status and reason, and the skips it allows.
async function account(): Promise<{
	manifest: string[];
	checks: { name: string; status: string; reason?: string }[];
	allowSkip: string[];
}> {
	const root = await harness.root(context);
	const index = await harness.snapshot(ReviewIndex, root.id, context);
	const revision = Revision.key({
		base: gitIn(repo, "merge-base", "main", "feature"),
		head: gitIn(repo, "rev-parse", "feature"),
	});
	const input = JSON.parse(index!.reviews[revision]!.adjudication!.input) as AdjudicationTaskInput;
	return {
		manifest: input.manifest,
		checks: input.checks.map(({ name, status, reason }) => ({
			name,
			status,
			...(reason === undefined ? {} : { reason }),
		})),
		allowSkip: input.allowSkip,
	};
}

const lensRan = { name: "lens.correctness", status: "ran" };

describe("the account a review gives its adjudication", () => {
	it("allows no skip when every check of the tier ran", async () => {
		const { verdict } = await review();

		expect(verdict.status).toBe("passed");
		expect(await account()).toEqual({
			manifest: ["guardrails", "static.biome", "static.tsc", "lens.correctness"],
			checks: [...ran, lensRan],
			allowSkip: [],
		});
	});

	describe("checks.allowSkip", () => {
		const skipped: CheckRecord[] = [
			{ name: "guardrails", status: "ran" },
			{ name: "static.biome", status: "ran" },
			{ name: "static.tsc", status: "skipped", reason: "no TypeScript" },
		];

		it("lets a skip it names pass", async () => {
			const { verdict } = await review({ checks: skipped, config: { checks: { allowSkip: ["static.tsc"] } } });

			expect(verdict.status).toBe("passed");
			expect(await account()).toEqual({
				manifest: ["guardrails", "static.biome", "static.tsc", "lens.correctness"],
				checks: [...skipped, lensRan],
				allowSkip: ["static.tsc"],
			});
		});

		it("leaves the same skip not reviewed when it names none", async () => {
			const { verdict } = await review({ checks: skipped });

			expect(verdict.status).toBe("not-reviewed");
			expect((await account()).allowSkip).toEqual([]);
		});
	});

	describe("a lens of the tier that covers no changed path", () => {
		const tiered = (extra: string) => ({
			tiers: { ...defaultConfig.tiers, full: ["guardrails", "static", "lens.correctness", extra] },
		});

		it("records it skipped for no paths and allows the skip", async () => {
			const { verdict } = await review({
				config: { ...tiered("lens.contracts"), lenses: { contracts: { paths: ["docs/**"] } } },
			});

			expect(verdict.status).toBe("passed");
			expect(await account()).toEqual({
				manifest: ["guardrails", "static.biome", "static.tsc", "lens.correctness", "lens.contracts"],
				checks: [...ran, lensRan, { name: "lens.contracts", status: "skipped", reason: "no paths" }],
				allowSkip: ["lens.contracts"],
			});
		});

		it("allows no skip of a lens configuration disables", async () => {
			const { verdict } = await review({
				config: { ...tiered("lens.contracts"), lenses: { contracts: { paths: ["docs/**"], enabled: false } } },
			});

			expect(verdict.status).toBe("not-reviewed");
			expect(await account()).toEqual({
				manifest: ["guardrails", "static.biome", "static.tsc", "lens.correctness", "lens.contracts"],
				checks: [
					...ran,
					lensRan,
					{ name: "lens.contracts", status: "skipped", reason: "lenses.contracts.enabled is false" },
				],
				allowSkip: [],
			});
		});

		it("records a lens no file defines as failed, and allows no skip", async () => {
			const { verdict } = await review({ config: tiered("lens.nonesuch") });

			expect(verdict.status).toBe("not-reviewed");
			expect(await account()).toEqual({
				manifest: ["guardrails", "static.biome", "static.tsc", "lens.correctness", "lens.nonesuch"],
				checks: [...ran, lensRan, { name: "lens.nonesuch", status: "failed", reason: "no lens is named nonesuch" }],
				allowSkip: [],
			});
		});
	});

	describe("a decision question of the tier", () => {
		const tiers = { ...defaultConfig.tiers, full: ["guardrails", "static", "decisions.fast", "lens.correctness"] };
		const manifest = ["guardrails", "static.biome", "static.tsc", "decisions.fast", "lens.correctness"];

		it("passes skipped when no decision provider is configured", async () => {
			const { verdict } = await review({ config: { tiers } });

			expect(verdict.status).toBe("passed");
			expect(await account()).toEqual({
				manifest,
				checks: [
					...ran,
					{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
					lensRan,
				],
				allowSkip: ["decisions.fast"],
			});
		});

		it("allows no skip when a provider is configured", async () => {
			const { verdict } = await review({ config: { tiers, decisions: { provider: "acme", thresholds: {} } } });

			expect(verdict.status).toBe("not-reviewed");
			expect(await account()).toEqual({
				manifest,
				checks: [
					...ran,
					{
						name: "decisions.fast",
						status: "skipped",
						reason: "decisions.provider is acme, and Melian has no adapter for a decision provider yet",
					},
					lensRan,
				],
				allowSkip: [],
			});
		});
	});

	describe("static.mutation", () => {
		const tiers = { ...defaultConfig.tiers, full: ["guardrails", "static", "static.mutation", "lens.correctness"] };
		const mutation = (cause: "noProductionLines" | "timeout"): CheckRecord => ({
			name: "static.mutation",
			status: "skipped",
			reason: cause === "noProductionLines" ? mutationSkips.noProductionLines : "it ran past its timeout",
			cause,
		});

		it("passes skipped when the change has no production lines", async () => {
			const { verdict } = await review({ config: { tiers }, checks: [...ran, mutation("noProductionLines")] });

			expect(verdict.status).toBe("passed");
			expect(await account()).toEqual({
				manifest: ["guardrails", "static.biome", "static.tsc", "static.mutation", "lens.correctness"],
				checks: [
					...ran,
					{ name: "static.mutation", status: "skipped", reason: mutationSkips.noProductionLines },
					lensRan,
				],
				allowSkip: ["static.mutation"],
			});
		});

		it("allows no skip for any other cause", async () => {
			const { verdict } = await review({ config: { tiers }, checks: [...ran, mutation("timeout")] });

			expect(verdict.status).toBe("not-reviewed");
			expect((await account()).allowSkip).toEqual([]);
		});
	});

	describe("triage", () => {
		const floor = (level: "skip" | "quick") => ({ lenses: { correctness: { level: { floor: level } } } });
		const skipped = { name: "lens.correctness", status: "skipped", reason: "triage skipped it, as its floor allows" };

		it("passes a lens it skips under a floor of skip", async () => {
			const { verdict } = await review({ decider: choosing("skip"), config: floor("skip") });

			expect(verdict.status).toBe("passed");
			expect(await account()).toEqual({
				manifest: ["guardrails", "static.biome", "static.tsc", "lens.correctness"],
				checks: [...ran, skipped],
				allowSkip: ["lens.correctness"],
			});
		});

		it("runs the lens and allows no skip under a floor of quick", async () => {
			const { verdict } = await review({ decider: choosing("skip"), config: floor("quick") });

			expect(verdict.status).toBe("passed");
			expect(await account()).toMatchObject({ checks: [...ran, lensRan], allowSkip: [] });
		});

		it("runs the lens and allows no skip when it chooses a level under a floor of skip", async () => {
			const { verdict } = await review({ decider: choosing("quick"), config: floor("skip") });

			expect(verdict.status).toBe("passed");
			expect(await account()).toMatchObject({ checks: [...ran, lensRan], allowSkip: [] });
		});

		it("runs the lens and allows no skip when its input was cut", async () => {
			writeFiles(repo, { "src/large.ts": `export const text = "${"x".repeat(210 * 1024)}";\n` });
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "a large change");

			const { verdict } = await review({ decider: choosing("skip"), config: floor("skip") });

			expect(verdict.status).toBe("passed");
			expect(await account()).toMatchObject({ checks: [...ran, lensRan], allowSkip: [] });
		});
	});

	it("allows every reason's skips in one order: configuration, triage, mutation, then the tier's", async () => {
		const { verdict } = await review({
			decider: choosing("skip"),
			config: {
				tiers: {
					...defaultConfig.tiers,
					full: [
						"guardrails",
						"static",
						"static.mutation",
						"decisions.fast",
						"lens.correctness",
						"lens.contracts",
					],
				},
				checks: { allowSkip: ["static.tsc"] },
				lenses: { correctness: { level: { floor: "skip" } }, contracts: { paths: ["docs/**"] } },
			},
			checks: [
				{ name: "guardrails", status: "ran" },
				{ name: "static.biome", status: "ran" },
				{ name: "static.tsc", status: "skipped", reason: "no TypeScript" },
				{
					name: "static.mutation",
					status: "skipped",
					reason: mutationSkips.noProductionLines,
					cause: "noProductionLines",
				},
			],
		});

		expect(verdict.status).toBe("passed");
		expect((await account()).allowSkip).toEqual([
			"static.tsc",
			"lens.correctness",
			"static.mutation",
			"decisions.fast",
			"lens.contracts",
		]);
	});
});
