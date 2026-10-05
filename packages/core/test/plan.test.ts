import {
	type CatalogModel,
	defaultConfig,
	Lens,
	type LensTier,
	type MelianConfig,
	type ModelRoute,
	ModelRoutingError,
	type PlanInput,
	ReviewPlan,
} from "@melian-agent/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

function model(provider: string, id: string, name: string, input: number, output: number): CatalogModel {
	return { provider, id, name, contextWindow: 1_000_000, reasoning: true, cost: { input, output } };
}

const catalog: CatalogModel[] = [
	model("amazon-bedrock", "us.anthropic.claude-opus-5-5", "Claude Opus 5.5 (US)", 4.4, 22),
	model("amazon-bedrock", "anthropic.claude-opus-5-5", "Claude Opus 5.5", 4, 20),
	model("anthropic", "claude-opus-5-5", "Claude Opus 5.5", 4, 20),
	model("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10),
	model("openai", "gpt-5.5", "GPT-5.5", 5, 30),
	model("openai", "gpt-5.4-mini", "GPT-5.4 mini", 0.75, 4.5),
	model("openrouter", "anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", 4, 20),
];

const opus = "anthropic/claude-opus-5-5";
const gpt = "openai/gpt-5.5";

let lenses: Lens[];
let repo: string;

beforeAll(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	lenses = await Lens.load(repo, { kind: "worktree" }, []);
});

afterAll(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

type Routes = MelianConfig["models"];

// A plan where `committed` is what melian.yaml routes, `preferences` what melian.local.yaml adds over it.
function plan(
	committed: Routes,
	credentials: Record<string, string>,
	options: {
		preferences?: Routes;
		model?: string;
		checks?: string[];
		retier?: Record<string, LensTier>;
		committedTiers?: Record<string, LensTier>;
		catalog?: CatalogModel[];
	} = {},
): ReviewPlan {
	const preferences = options.preferences ?? {};
	const models: Record<string, unknown> = { ...committed };
	for (const [tier, route] of Object.entries(preferences)) {
		models[tier] = { ...(committed[tier as keyof Routes] ?? {}), ...route };
	}
	const retier = options.retier ?? {};
	const committedTiers = options.committedTiers ?? {};
	const input: PlanInput = {
		config: {
			...defaultConfig,
			models: models as Routes,
			lenses: Object.fromEntries(
				Object.entries({ ...committedTiers, ...retier }).map(([name, tier]) => [name, { tier }]),
			),
		},
		routes: {
			committed,
			overridden: Object.fromEntries(Object.keys(preferences).map((tier) => [tier, "melian.local.yaml"])),
			lensTiers: committedTiers,
			retiered: Object.fromEntries(Object.keys(retier).map((name) => [name, "melian.local.yaml"])),
		},
		...(options.model === undefined ? {} : { model: options.model }),
		catalog: options.catalog ?? catalog,
		credentials,
		lenses,
		checks: options.checks ?? ["lens.correctness"],
	};
	return ReviewPlan.resolve(input);
}

describe("ReviewPlan.resolve", () => {
	it("routes the committed route, keeping only the models the catalogue holds and some credential covers", () => {
		const resolved = plan(
			{ heavy: { model: opus, fallbacks: ["nowhere/model", "openai/gpt-5.4-mini", gpt] } },
			{ anthropic: "ANTHROPIC_API_KEY", openai: "work-openai in melian.secrets.yaml" },
		);

		expect(resolved.tier("heavy")).toEqual({
			tier: "heavy",
			status: "routed",
			wanted: opus,
			accept: [opus, "nowhere/model", "openai/gpt-5.4-mini", gpt],
			models: [
				{ model: opus, credential: "ANTHROPIC_API_KEY" },
				{ model: "openai/gpt-5.4-mini", credential: "work-openai in melian.secrets.yaml" },
				{ model: gpt, credential: "work-openai in melian.secrets.yaml" },
			],
		});
		expect(resolved.routes()).toEqual({ heavy: { model: opus, fallbacks: ["openai/gpt-5.4-mini", gpt] } });
		expect(resolved.lineage("heavy")).toBeUndefined();
		expect(resolved.warnings()).toEqual([]);
	});

	it("routes a route that names only accept to its first accepted model with credentials, saying nothing", () => {
		const resolved = plan({ verifier: { accept: [gpt, opus] } }, { anthropic: "ANTHROPIC_API_KEY" }, { checks: [] });
		expect(resolved.tier("verifier")).toMatchObject({ status: "routed", models: [{ model: opus }] });
		expect(resolved.warnings()).toEqual([]);
	});

	it("stands an accepted model in for a committed one with no credentials, and says so", () => {
		const resolved = plan({ heavy: { model: opus, accept: [opus, gpt] } }, { openai: "OPENAI_API_KEY" });
		expect(resolved.tier("heavy")).toMatchObject({ status: "routed", models: [{ model: gpt }] });
		expect(resolved.lineage("heavy")).toBeUndefined();
		expect(resolved.warnings()).toEqual([
			`heavy runs ${gpt}, which the committed route accepts, since ${opus} has no credentials`,
		]);
	});

	it("derives the same model from another provider, preferring a name with no region", () => {
		const resolved = plan({ heavy: { model: opus } }, { "amazon-bedrock": "AWS_PROFILE" });
		expect(resolved.tier("heavy")).toMatchObject({
			status: "routed",
			by: "derived",
			outside: true,
			models: [{ model: "amazon-bedrock/anthropic.claude-opus-5-5", credential: "AWS_PROFILE" }],
		});
		expect(resolved.lineage("heavy")).toEqual({
			model: "amazon-bedrock/anthropic.claude-opus-5-5",
			wanted: opus,
			by: "derived",
			outside: true,
		});
		expect(resolved.warnings()).toEqual([
			`heavy runs amazon-bedrock/anthropic.claude-opus-5-5, derived since no model of its route has credentials; the committed route wants ${opus}, and does not accept amazon-bedrock/anthropic.claude-opus-5-5`,
		]);
	});

	it("tells doctor a derived route was derived, and an accept-only route that it left accept", () => {
		const derived = plan({ verifier: { accept: [opus] } }, { "amazon-bedrock": "AWS_PROFILE" }, { checks: [] });
		expect(derived.lines()).toEqual([
			{
				state: "ok",
				text: "verifier: amazon-bedrock/anthropic.claude-opus-5-5 with AWS_PROFILE; derived, since no model of the committed route has credentials",
			},
			{
				state: "warn",
				text: "verifier runs amazon-bedrock/anthropic.claude-opus-5-5, derived since no model of its route has credentials; the committed route does not accept amazon-bedrock/anthropic.claude-opus-5-5",
			},
		]);
	});

	it("matches a model across a provider's prefix in its name", () => {
		const resolved = plan({ heavy: { model: opus } }, { openrouter: "OPENROUTER_API_KEY" });
		expect(resolved.tier("heavy").models[0]?.model).toBe("openrouter/anthropic/claude-opus-5.5");
	});

	it("derives the model whose price is nearest when no provider with credentials serves the same one", () => {
		const resolved = plan({ heavy: { model: opus } }, { openai: "OPENAI_API_KEY" });
		expect(resolved.tier("heavy")).toMatchObject({ status: "routed", by: "derived", models: [{ model: gpt }] });
		const light = plan({ heavy: { model: "openai/gpt-5.4-mini" } }, { anthropic: "ANTHROPIC_API_KEY" });
		expect(light.tier("heavy").models[0]?.model).toBe("anthropic/claude-sonnet-5-5");
	});

	describe("by price, when no provider with credentials serves the same model", () => {
		// The wanted model, which no credential covers, and candidates from a provider that has credentials.
		const wanted = model("anthropic", "wanted", "Wanted", 4, 20);
		const derive = (...candidates: CatalogModel[]) =>
			plan(
				{ heavy: { model: "anthropic/wanted" } },
				{ other: "OTHER_API_KEY" },
				{
					catalog: [wanted, ...candidates],
				},
			).tier("heavy").models[0]?.model;
		const priced = (id: string, input: number, output: number, change: Partial<CatalogModel> = {}) => ({
			...model("other", id, id, input, output),
			...change,
		});

		it("skips a model that differs in reasoning, however close its price", () => {
			expect(derive(priced("flat", 4, 20, { reasoning: false }), priced("far", 1, 5))).toBe("other/far");
		});

		it("skips a model whose context window is below the wanted model's or 200,000 tokens", () => {
			expect(derive(priced("small", 4, 20, { contextWindow: 32_000 }), priced("far", 1, 5))).toBe("other/far");
		});

		it("measures price distance as a ratio, not a difference", () => {
			// From 24 dollars, 6 is 18 away and 60 is 36 away, but 60 is the nearer ratio, 2.5 to 4.
			expect(derive(priced("cheap", 1, 5), priced("dear", 10, 50))).toBe("other/dear");
		});

		it("takes a window between 200,000 tokens and the wanted model's, and no smaller", () => {
			const mid = priced("mid", 4, 20, { contextWindow: 500_000 });
			expect(derive(mid, priced("far", 1, 5))).toBe("other/mid");
			expect(derive(priced("small", 4, 20, { contextWindow: 150_000 }), priced("far", 1, 5))).toBe("other/far");
		});

		it("breaks a tie in price by the larger context window, then by provider and ID", () => {
			expect(derive(priced("narrow", 4, 20, { contextWindow: 400_000 }), priced("wide", 4, 20))).toBe("other/wide");
			expect(derive(priced("b", 4, 20), priced("a", 4, 20))).toBe("other/a");
		});
	});

	it("leaves a route uncredentialed when nothing can be derived, so the review says no model has credentials", () => {
		const resolved = plan({ heavy: { model: opus, fallbacks: [gpt] } }, {});
		expect(resolved.tier("heavy")).toMatchObject({
			status: "uncredentialed",
			models: [
				{ model: opus, credential: "none" },
				{ model: gpt, credential: "none" },
			],
		});
		expect(resolved.routes()).toEqual({ heavy: { model: opus, fallbacks: [gpt] } });
		expect(resolved.warnings()[0]).toMatch(/^heavy, for correctness: none of .* has credentials; log in with pi/);
	});

	it("says nothing of a refused tier that no lens the review runs uses", () => {
		const resolved = plan(
			{ verifier: { model: opus, accept: [opus], acceptOverridden: false } },
			{ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" },
			{ preferences: { verifier: { model: gpt } }, checks: [] },
		);
		expect(resolved.tier("verifier").status).toBe("refused");
		expect(resolved.warnings()).toEqual([]);
	});

	it("says nothing of a tier with no credentials that no lens the review runs uses", () => {
		const resolved = plan({ verifier: { model: gpt } }, {}, { checks: [] });
		expect(resolved.tier("verifier").status).toBe("uncredentialed");
		expect(resolved.warnings()).toEqual([]);
	});

	it("fails every check on a tier whose policy says unavailable: fail and none of whose accepted models has credentials", () => {
		const resolved = plan(
			{ heavy: { model: opus, accept: [opus, gpt], unavailable: "fail" } },
			{ "amazon-bedrock": "AWS_PROFILE" },
		);
		expect(resolved.tier("heavy")).toMatchObject({ status: "unavailable", models: [] });
		expect(resolved.refusal("heavy")).toBe(
			`none of ${opus} and ${gpt}, which models.heavy accepts, has credentials, and models.heavy.unavailable is fail`,
		);
		expect(resolved.routes()).toEqual({});
	});

	it("records the lineage of a route a preference file changed, inside accept or outside it", () => {
		const committed = { heavy: { model: opus, accept: [opus, gpt] } };
		const credentials = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
		const inside = plan(committed, credentials, { preferences: { heavy: { model: gpt } } });
		const outside = plan(committed, credentials, { preferences: { heavy: { model: "openai/gpt-5.4-mini" } } });

		expect(inside.lineage("heavy")).toEqual({ model: gpt, wanted: opus, by: "melian.local.yaml", outside: false });
		expect(outside.lineage("heavy")).toEqual({
			model: "openai/gpt-5.4-mini",
			wanted: opus,
			by: "melian.local.yaml",
			outside: true,
		});
		expect(outside.tier("heavy").status).toBe("routed");
	});

	it("never replaces a preference file's route, even one with no credentials", () => {
		const resolved = plan(
			{ heavy: { model: opus } },
			{ anthropic: "ANTHROPIC_API_KEY" },
			{ preferences: { heavy: { model: gpt } } },
		);
		expect(resolved.tier("heavy")).toMatchObject({ status: "uncredentialed", by: "melian.local.yaml" });
	});

	it("refuses a route outside accept where policy says acceptOverridden: false, and keeps one inside it", () => {
		const committed = { heavy: { model: opus, accept: [opus, gpt], acceptOverridden: false } };
		const credentials = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
		const refused = plan(committed, credentials, { preferences: { heavy: { model: "openai/gpt-5.4-mini" } } });
		const flagged = plan(committed, credentials, { model: "openai/gpt-5.4-mini" });
		const kept = plan(committed, credentials, {
			preferences: { heavy: { model: gpt, fallbacks: ["openai/gpt-5.4-mini"] } },
		});

		expect(refused.tier("heavy")).toMatchObject({ status: "refused", by: "melian.local.yaml", outside: true });
		expect(refused.refusal("heavy")).toBe(
			"models.heavy.acceptOverridden is false, and melian.local.yaml puts it on openai/gpt-5.4-mini, which models.heavy.accept does not list",
		);
		expect(refused.warnings()).toEqual([`heavy, for correctness fails every check: ${refused.refusal("heavy")}`]);
		expect(flagged.refusal("heavy")).toContain("--model puts it on openai/gpt-5.4-mini");
		// A fallback outside accept is dropped, so a failover never leaves policy either.
		expect(kept.tier("heavy")).toMatchObject({ status: "routed", models: [{ model: gpt }] });
		expect(kept.tier("heavy").outside).toBeUndefined();
		expect(kept.lineage("heavy")).toEqual({ model: gpt, wanted: opus, by: "melian.local.yaml", outside: false });
		expect(kept.refusal("heavy")).toBeUndefined();
	});

	it("judges a lens a preference file moved to another tier by its committed tier's policy", () => {
		const credentials = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
		const committed = { heavy: { model: opus, accept: [opus], acceptOverridden: false } };
		const moved = plan(committed, credentials, {
			preferences: { light: { model: "openai/gpt-5.4-mini" } },
			retier: { correctness: "light" },
		});
		const refusal = `lenses.correctness.tier moves it from heavy to light, and models.heavy.acceptOverridden is false; light runs openai/gpt-5.4-mini, which models.heavy.accept does not list`;
		const lineage = {
			model: "openai/gpt-5.4-mini",
			wanted: opus,
			by: "melian.local.yaml",
			moved: { by: "melian.local.yaml", from: "heavy", to: "light" },
			outside: true,
		};
		expect(moved.judge("correctness", "careful")).toEqual({ refusal, lineage });
		expect(moved.warnings()).toContain(`correctness fails: ${refusal}`);
		expect(moved.mark([{ name: "lens.correctness", status: "ran", level: "careful" }])[0]?.lineage).toEqual(lineage);
		// Without the guard, the move only records the lineage.
		const open = plan({ heavy: { model: opus } }, credentials, {
			preferences: { light: { model: "openai/gpt-5.4-mini" } },
			retier: { correctness: "light" },
		});
		expect(open.judge("correctness", "careful")).toEqual({ lineage });
		expect(open.warnings()).toContain(
			`correctness runs openai/gpt-5.4-mini, moved from heavy to light by melian.local.yaml, whose route is set by melian.local.yaml; the committed route wants ${opus}, and does not accept openai/gpt-5.4-mini`,
		);
	});

	it("runs a lens the committed files retiered on that tier, under that tier's own policy", () => {
		const credentials = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
		const resolved = plan(
			{ heavy: { model: opus, accept: [opus], acceptOverridden: false }, light: { model: gpt } },
			credentials,
			{ committedTiers: { correctness: "light" } },
		);
		expect(resolved.lenses.find((lens) => lens.name === "correctness")?.levels).toEqual([
			{ level: "quick", tier: "light" },
			{ level: "careful", tier: "light" },
			{ level: "deep", tier: "light" },
		]);
		// The committed files chose light, so heavy's guard does not reach it, and nothing left a committed route.
		expect(resolved.judge("correctness", "careful")).toEqual({});
	});

	it("records both what moved a lens and what routed the tier it moved to", () => {
		const credentials = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
		const flagged = plan({ heavy: { model: opus } }, credentials, { model: gpt, retier: { correctness: "light" } });
		expect(flagged.judge("correctness", "careful").lineage).toEqual({
			model: gpt,
			wanted: opus,
			by: "--model",
			moved: { by: "melian.local.yaml", from: "heavy", to: "light" },
			outside: true,
		});
		const derived = plan(
			{ heavy: { model: opus }, light: { model: gpt } },
			{ "amazon-bedrock": "AWS_PROFILE" },
			{
				retier: { correctness: "light" },
			},
		);
		expect(derived.judge("correctness", "careful").lineage).toMatchObject({
			by: "derived",
			moved: { by: "melian.local.yaml", from: "heavy", to: "light" },
		});
	});

	describe("an accepted model with credentials comes before a fallback outside accept", () => {
		const bedrock = "amazon-bedrock/anthropic.claude-opus-5-5";
		const route = (extra: Partial<ModelRoute> = {}) => ({
			heavy: { model: opus, fallbacks: [gpt], accept: [opus, bedrock], ...extra },
		});
		const both = { openai: "OPENAI_API_KEY", "amazon-bedrock": "AWS_PROFILE" };

		it("under derive", () => {
			const resolved = plan(route(), both);
			expect(resolved.tier("heavy")).toMatchObject({
				status: "routed",
				models: [{ model: bedrock }, { model: gpt }],
			});
			expect(resolved.lineage("heavy")).toBeUndefined();
		});

		it("under acceptOverridden: false, which then drops the fallback", () => {
			const resolved = plan(route({ acceptOverridden: false }), both);
			expect(resolved.tier("heavy")).toMatchObject({ status: "routed", models: [{ model: bedrock }] });
		});

		it("under unavailable: fail, which fails only when no accepted model has credentials", () => {
			expect(plan(route({ unavailable: "fail" }), both).tier("heavy").models[0]?.model).toBe(bedrock);
			const onlyFallback = plan(route({ unavailable: "fail" }), { openai: "OPENAI_API_KEY" });
			expect(onlyFallback.tier("heavy")).toMatchObject({ status: "unavailable" });
		});
	});

	it("refuses a derived route outside accept where policy says acceptOverridden: false", () => {
		const resolved = plan({ heavy: { model: opus, acceptOverridden: false } }, { openai: "OPENAI_API_KEY" });
		expect(resolved.tier("heavy")).toMatchObject({ status: "refused", by: "derived" });
	});

	it("routes every lens tier, and only those, to --model", () => {
		const resolved = plan(
			{ heavy: { model: opus }, verifier: { model: opus } },
			{ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" },
			{ model: gpt },
		);
		expect(resolved.routes()).toEqual({
			light: { model: gpt, fallbacks: [] },
			medium: { model: gpt, fallbacks: [] },
			heavy: { model: gpt, fallbacks: [] },
			verifier: { model: opus, fallbacks: [] },
		});
		expect(resolved.lineage("heavy")).toEqual({ model: gpt, wanted: opus, by: "--model", outside: true });
		// No committed route names light, so the flag leaves nothing.
		expect(resolved.lineage("light")).toBeUndefined();
	});

	it("warns for a tier the lenses run on that no file routes, naming the lenses", () => {
		const resolved = plan({}, { anthropic: "ANTHROPIC_API_KEY" }, { checks: ["lens.correctness", "lens.tests"] });
		expect(resolved.tier("heavy").status).toBe("unrouted");
		// Every lens runs at careful until triage chooses a level, so quick's medium tier needs no route yet.
		expect(resolved.warnings()).toEqual([
			"no model for heavy, for correctness and tests; set models.heavy.model in melian.local.yaml, or pass --model to review",
		]);
	});

	it("refuses a model that is not provider/model-id", () => {
		expect(() => plan({ heavy: { model: "opus" } }, {})).toThrow(ModelRoutingError);
		expect(() => plan({ verifier: { accept: ["opus"] } }, {})).toThrow(ModelRoutingError);
	});
});

describe("a lens two folders define", () => {
	it("judges each variant by its own tier, so one on a refused tier fails and the other runs", async () => {
		const folder = temporaryDirectory();
		try {
			gitIn(folder, "init", "--quiet", "--initial-branch=main");
			writeFiles(folder, {
				"services/pay/.melian/lenses/correctness/LENS.md": lines(
					"---",
					"name: correctness",
					"extends: correctness",
					"tier: light",
					"---",
				),
				"services/pay/a.ts": lines("export {};"),
			});
			const variants = await Lens.load(folder, { kind: "worktree" }, ["a.ts", "services/pay/a.ts"]);
			const credentials = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
			const input: PlanInput = {
				config: { ...defaultConfig, models: { heavy: { model: opus }, light: { model: "openai/gpt-5.4-mini" } } },
				routes: {
					committed: { heavy: { model: opus }, light: { model: gpt, acceptOverridden: false } },
					overridden: { light: "melian.local.yaml" },
					lensTiers: {},
					retiered: {},
				},
				catalog,
				credentials,
				lenses: variants,
				checks: ["lens.correctness"],
			};
			const resolved = ReviewPlan.resolve(input);

			expect(resolved.lenses.filter((lens) => lens.name === "correctness").map((lens) => lens.scope)).toEqual([
				"",
				"services/pay",
			]);
			expect(resolved.judge("correctness", "careful", undefined, "").refusal).toBeUndefined();
			expect(resolved.judge("correctness", "careful", undefined, "services/pay").refusal).toContain(
				"models.light.acceptOverridden is false",
			);
			expect(resolved.warnings()).toContain(
				`light, for correctness in services/pay/ fails every check: ${resolved.refusal("light")}`,
			);
			const ran = new Map([
				[
					"correctness",
					[
						{ scope: "", model: opus },
						{ scope: "services/pay", model: "openai/gpt-5.4-mini" },
					],
				],
			]);
			const [record] = resolved.mark([{ name: "lens.correctness", status: "ran", level: "careful" }], ran);
			expect(record).toMatchObject({
				status: "failed",
				reason: expect.stringContaining("acceptOverridden is false"),
			});
		} finally {
			removeDirectory(folder);
		}
	});
});

describe("a resolved plan", () => {
	it("marks each lens record whose level's tier left the committed route, and only those", () => {
		const resolved = plan(
			{ heavy: { model: opus }, medium: { model: "anthropic/claude-sonnet-5-5" } },
			{ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" },
			{ preferences: { heavy: { model: gpt } } },
		);
		const records = resolved.mark([
			{ name: "lens.correctness", status: "ran", level: "careful" },
			{ name: "lens.correctness", status: "ran", level: "quick" },
			{ name: "static.biome", status: "ran" },
		]);
		expect(records).toEqual([
			{
				name: "lens.correctness",
				status: "ran",
				level: "careful",
				lineage: { model: gpt, wanted: opus, by: "melian.local.yaml", outside: true },
			},
			{ name: "lens.correctness", status: "ran", level: "quick" },
			{ name: "static.biome", status: "ran" },
		]);
	});

	it("judges each lens record on the model it finished on, and fails one that finished outside a guarded accept", () => {
		const credentials = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
		const resolved = plan({ heavy: { model: opus, accept: [opus], acceptOverridden: false } }, credentials, {
			preferences: { light: { model: opus, fallbacks: ["openai/gpt-5.4-mini"] } },
			retier: { correctness: "light" },
		});
		// The first model of the moved lens's route is inside accept, so the plan lets it run.
		expect(resolved.judge("correctness", "careful").refusal).toBeUndefined();
		const record = { name: "lens.correctness", status: "ran", level: "careful" } as const;
		expect(resolved.mark([record], new Map([["correctness", [{ scope: "", model: opus }]]]))).toEqual([record]);
		const [fallback] = resolved.mark(
			[record],
			new Map([["correctness", [{ scope: "", model: "openai/gpt-5.4-mini" }]]]),
		);
		expect(fallback).toMatchObject({
			status: "failed",
			reason: expect.stringContaining("light runs openai/gpt-5.4-mini, which models.heavy.accept does not list"),
			lineage: {
				model: "openai/gpt-5.4-mini",
				wanted: opus,
				by: "melian.local.yaml",
				moved: { by: "melian.local.yaml", from: "heavy", to: "light" },
				outside: true,
			},
		});
	});

	it("prints each routed tier, each lens's levels, and every warning for doctor", () => {
		const resolved = plan(
			{ heavy: { model: opus, fallbacks: [gpt] }, medium: { model: "anthropic/claude-sonnet-5-5" } },
			{ anthropic: "ANTHROPIC_API_KEY" },
			{ checks: ["lens.correctness", "lens.tests"] },
		);
		expect(resolved.lines()).toEqual([
			{ state: "ok", text: "medium: anthropic/claude-sonnet-5-5 with ANTHROPIC_API_KEY; routed by melian.yaml" },
			{ state: "ok", text: `heavy: ${opus} with ANTHROPIC_API_KEY; routed by melian.yaml` },
			{
				state: "ok",
				text: `correctness and tests: quick on medium (anthropic/claude-sonnet-5-5), careful on heavy (${opus}), deep on heavy (${opus})`,
			},
		]);
		expect(resolved.summary()).toBe("");
	});

	it("names the providers the review's lenses may call, and no other tier's", () => {
		const resolved = plan(
			{
				heavy: { model: opus, fallbacks: [gpt, "anthropic/claude-sonnet-5-5"] },
				verifier: { model: "openai/gpt-5.4-mini" },
			},
			{ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" },
		);
		expect(resolved.providers()).toEqual(["anthropic", "openai"]);
		expect(plan({ verifier: { model: gpt } }, { openai: "OPENAI_API_KEY" }).providers()).toEqual([]);
	});

	it("escapes a model name from melian.yaml in every line it prints", () => {
		const forged = "openai/gpt-5.5\u001b]0;pwned\u0007";
		const resolved = plan({ heavy: { model: forged } }, { openai: "OPENAI_API_KEY" });
		const printed = [...resolved.lines().map(({ text }) => text), resolved.summary()].join("\n");
		expect(printed).toContain("\\u001b]0;pwned\\u0007");
		expect(printed).not.toContain("\u001b");
		expect(printed).not.toContain("\u0007");
	});

	it("survives its JSON", () => {
		const resolved = plan({ heavy: { model: opus } }, { "amazon-bedrock": "AWS_PROFILE" });
		const stored = JSON.parse(JSON.stringify(resolved));
		expect(ReviewPlan.from(stored).toJSON()).toEqual(resolved.toJSON());
		expect(ReviewPlan.from(stored).summary()).toBe(`Plan: ${resolved.warnings()[0]}\n`);
	});
});
