import {
	defaultConfig,
	describeLineage,
	Lens,
	loadConfig,
	type ModelRoute,
	type ModelTier,
	ReviewPlan,
} from "@melian-agent/core";
import { expect, it } from "vitest";
import { gitIn, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

it("defaults a configured level's source to root policy for library plans", () => {
	const models = { verifier: { thinking: "off" as const } };
	const plan = ReviewPlan.resolve({
		config: { ...defaultConfig, models },
		routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
		catalog: [],
		credentials: {},
		lenses: [],
		checks: [],
	});
	expect(plan.tier("verifier")).toMatchObject({ status: "unrouted", thinking: "off", thinkingBy: "melian.yaml" });
	expect(plan.routes().verifier).toEqual({ thinking: "off" });
});

it("keeps thinking and its source through planning, model overrides and JSON", () => {
	const models = {
		heavy: { model: "faux/finder", thinking: "high" },
		verifier: { thinking: "low" },
	} satisfies Partial<Record<ModelTier, ModelRoute>>;
	const plan = ReviewPlan.resolve({
		config: { ...defaultConfig, models },
		routes: {
			committed: models,
			overridden: {},
			lensTiers: {},
			retiered: {},
			thinking: { heavy: "melian.local.yaml", verifier: "melian.yaml" },
		},
		model: "faux/override",
		catalog: ["finder", "override"].map((id) => ({
			provider: "faux",
			id,
			name: id,
			reasoning: true,
			contextWindow: 200000,
			cost: { input: 0, output: 0 },
		})),
		credentials: { faux: "test" },
		lenses: [],
		checks: [],
	});
	expect(plan.routes().heavy).toEqual({ model: "faux/override", fallbacks: [], thinking: "high" });
	expect(plan.routes().verifier).toEqual({ thinking: "low" });
	expect(ReviewPlan.from(plan.toJSON()).toJSON()).toEqual(plan.toJSON());
	expect(plan.lines().map(({ text }) => text)).toContain("heavy thinking: high; set by melian.local.yaml");
	expect(plan.lines().map(({ text }) => text)).toContain("verifier thinking: low; set by melian.yaml");
	expect(plan.lines().map(({ text }) => text)).toContain("light thinking: unset; Pi default");
});

it.each([false, true, undefined])("guards thinking preferences with acceptOverridden=%s", async (acceptOverridden) => {
	const repo = temporaryDirectory();
	try {
		gitIn(repo, "init", "--quiet", "--initial-branch=main");
		writeFiles(repo, {
			"melian.yaml": `models:\n  heavy:\n    model: faux/finder\n    thinking: high\n${acceptOverridden === undefined ? "" : `    acceptOverridden: ${acceptOverridden}\n`}`,
			"melian.local.yaml": "models:\n  heavy:\n    thinking: off\n",
		});
		const loaded = await loadConfig(repo, { kind: "worktree" }, ".");
		const plan = ReviewPlan.resolve({
			config: loaded.config,
			routes: loaded.routes,
			catalog: [
				{
					provider: "faux",
					id: "finder",
					name: "finder",
					reasoning: true,
					contextWindow: 200000,
					cost: { input: 0, output: 0 },
				},
			],
			credentials: { faux: "test" },
			lenses: await Lens.load(repo, { kind: "worktree" }, []),
			checks: ["lens.correctness"],
		});
		const thinking = { level: "off", wanted: "high", by: "melian.local.yaml" } as const;
		const lineage = {
			model: "faux/finder",
			wanted: "faux/finder",
			by: "melian.local.yaml",
			outside: false,
			thinking,
		};
		expect(plan.tier("heavy").outside ?? false).toBe(false);
		expect(plan.tier("heavy").status).toBe(acceptOverridden === false ? "refused" : "routed");
		expect(plan.judge("correctness", "careful").lineage).toEqual(lineage);
		expect(describeLineage(lineage)).toContain("thinking off set by melian.local.yaml; policy wants high");
		const [record] = plan.mark(
			[{ name: "lens.correctness", status: "ran", level: "careful" }],
			new Map([["correctness", [{ scope: "", level: "careful", model: "faux/finder" }]]]),
		);
		expect(record?.lineage).toEqual(lineage);
		expect(record?.status).toBe(acceptOverridden === false ? "failed" : "ran");
		expect(plan.lines()).toContainEqual({ state: "warn", text: expect.stringContaining("thinking off") });
		expect(plan.lines()).toContainEqual({ state: "warn", text: expect.stringContaining("melian.local.yaml") });
		expect(plan.refusal("heavy") === undefined).toBe(acceptOverridden !== false);
		expect(ReviewPlan.from(plan.toJSON()).judge("correctness", "careful")).toEqual(
			plan.judge("correctness", "careful"),
		);
	} finally {
		removeDirectory(repo);
	}
});

it.each([
	["high", "high", false, false],
	[undefined, "off", false, true],
	["high", undefined, false, true],
	["high", undefined, true, true],
	["high", "off", true, true],
	["high", "high", true, false],
] as const)("judges committed thinking %s against effective %s (moved=%s)", async (wanted, level, moved, changed) => {
	const policy = {
		model: "faux/finder",
		acceptOverridden: false,
		...(wanted === undefined ? {} : { thinking: wanted }),
	};
	const serving = { model: "faux/finder", ...(level === undefined ? {} : { thinking: level }) };
	const heavy = moved ? policy : { ...serving, acceptOverridden: false };
	const plan = ReviewPlan.resolve({
		config: {
			...defaultConfig,
			models: { heavy, light: serving },
			lenses: moved ? { correctness: { tier: "light" } } : {},
		},
		routes: {
			committed: { heavy: policy, light: serving },
			overridden: {},
			thinking: { heavy: "melian.local.yaml", light: "other.local.yaml" },
			lensTiers: {},
			retiered: { correctness: "melian.local.yaml" },
		},
		catalog: [
			{
				provider: "faux",
				id: "finder",
				name: "finder",
				reasoning: true,
				contextWindow: 200000,
				cost: { input: 0, output: 0 },
			},
		],
		credentials: { faux: "test" },
		lenses: await Lens.builtins(),
		checks: ["lens.correctness"],
	});
	const source = moved ? (level === undefined ? "melian.yaml" : "other.local.yaml") : "melian.local.yaml";
	const judgement = plan.judge("correctness", "careful");
	if (!moved && changed)
		expect(plan.tier("heavy").thinkingOverride).toEqual({
			level: level ?? "unset",
			wanted: wanted ?? "unset",
			by: source,
		});
	expect(judgement.refusal !== undefined).toBe(changed);
	expect(judgement.lineage?.thinking).toEqual(
		changed ? { level: level ?? "unset", wanted: wanted ?? "unset", by: source } : undefined,
	);
	if (changed)
		expect(judgement.refusal).toBe(
			`models.heavy.acceptOverridden is false, and ${source} sets thinking ${level ?? "unset"}; committed policy wants ${wanted ?? "unset"}`,
		);
});

it.each([false, true])(
	"records a library override of an unset verifier level with root provenance (accept only=%s)",
	(acceptOnly) => {
		const route = acceptOnly ? { accept: ["faux/finder"] } : { model: "faux/finder" };
		const plan = ReviewPlan.resolve({
			config: { ...defaultConfig, models: { verifier: { ...route, thinking: "off" } } },
			routes: { committed: { verifier: route }, overridden: {}, lensTiers: {}, retiered: {} },
			catalog: [
				{
					provider: "faux",
					id: "finder",
					name: "finder",
					reasoning: true,
					contextWindow: 200000,
					cost: { input: 0, output: 0 },
				},
			],
			credentials: { faux: "test" },
			lenses: [],
			checks: [],
		});
		if (acceptOnly)
			expect(plan.lines()).toContainEqual({
				state: "warn",
				text: expect.stringContaining("the committed route accepts faux/finder"),
			});
		expect(plan.tier("verifier").thinkingOverride).toEqual({ level: "off", wanted: "unset", by: "melian.yaml" });
		expect(plan.lines()).toContainEqual({
			state: "warn",
			text: expect.stringContaining("thinking off set by melian.yaml"),
		});
		expect(plan.verifierLineage("faux/finder")).toEqual({
			model: "faux/finder",
			...(acceptOnly ? {} : { wanted: "faux/finder" }),
			by: "melian.yaml",
			outside: false,
			thinking: { level: "off", wanted: "unset", by: "melian.yaml" },
		});
	},
);

it("keeps a thinking-only verifier override in its lens fallback lineage", () => {
	const heavy = { model: "faux/finder" };
	const plan = ReviewPlan.resolve({
		config: { ...defaultConfig, models: { heavy, verifier: { thinking: "off" } } },
		routes: {
			committed: { heavy, verifier: { thinking: "high" } },
			thinking: { verifier: "melian.local.yaml" },
			overridden: {},
			lensTiers: {},
			retiered: {},
		},
		catalog: [
			{
				provider: "faux",
				id: "finder",
				name: "finder",
				reasoning: true,
				contextWindow: 200000,
				cost: { input: 0, output: 0 },
			},
		],
		credentials: { faux: "test" },
		lenses: [],
		checks: [],
	});
	expect(plan.tier("verifier").status).toBe("unrouted");
	expect(plan.verifierLineage("faux/finder")).toEqual({
		model: "faux/finder",
		by: "lens tiers",
		outside: false,
		thinking: { level: "off", wanted: "high", by: "melian.local.yaml" },
	});
});
