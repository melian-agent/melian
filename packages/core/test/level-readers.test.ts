import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, type ModelRoute, ReviewPlan, resolveModelRoute } from "../src/index.ts";
import { gitIn, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

type Level = NonNullable<ModelRoute["thinking"]>;

// Each shape is a route whose `nowhere/` models no credential reaches, and the models that run, in order, at the levels
// they run at. A model that names no level runs at the route's; a route whose model names one names its own, as
// configuration requires. Its last model is on another provider, so doctor's warning about a low level reads it too.
// Every reader of a model's level must agree with `runs`, so one that reads a raw entry, or the route's level alone,
// fails here: the plan's models, its routes, doctor's route line and warning, the verifier's lineage, and the guard.
const shapes: {
	name: string;
	thinking?: Level;
	models: (string | { model: string; thinking: Level })[];
	runs: [string, Level | undefined][];
}[] = [
	{
		name: "first unreachable, at low",
		thinking: "low",
		models: ["nowhere/a", { model: "faux/b", thinking: "high" }, "other/c"],
		runs: [
			["faux/b", "high"],
			["other/c", "low"],
		],
	},
	{
		name: "first unreachable, at high, promoted low",
		thinking: "high",
		models: ["nowhere/a", { model: "faux/b", thinking: "low" }, "other/c"],
		runs: [
			["faux/b", "low"],
			["other/c", "high"],
		],
	},
	{
		name: "first two unreachable, at low",
		thinking: "low",
		models: [
			"nowhere/a",
			{ model: "nowhere/b", thinking: "high" },
			{ model: "faux/c", thinking: "medium" },
			"other/d",
		],
		runs: [
			["faux/c", "medium"],
			["other/d", "low"],
		],
	},
	{
		name: "first unreachable, no level",
		models: ["nowhere/a", "faux/b", "other/c"],
		runs: [
			["faux/b", undefined],
			["other/c", undefined],
		],
	},
	{
		name: "first reachable, at low",
		thinking: "low",
		models: ["faux/a", { model: "faux/b", thinking: "high" }, "other/c"],
		runs: [
			["faux/a", "low"],
			["faux/b", "high"],
			["other/c", "low"],
		],
	},
];

const catalog = ["faux", "other"].flatMap((provider) =>
	["a", "b", "c", "d"].map((id) => ({
		provider,
		id,
		name: `${provider}-${id}`,
		reasoning: true,
		contextWindow: 200000,
		cost: { input: 0, output: 0 },
	})),
);

function routeOf(shape: (typeof shapes)[number], guarded = false): ModelRoute {
	const [first, ...rest] = shape.models;
	const names = shape.models.map((each) => (typeof each === "string" ? each : each.model));
	return {
		...(shape.thinking === undefined ? {} : { thinking: shape.thinking }),
		model: first as string,
		fallbacks: rest,
		...(guarded ? { accept: names, acceptOverridden: false as const } : {}),
	};
}

function planOf(models: Partial<Record<"heavy" | "verifier", ModelRoute>>): ReviewPlan {
	return ReviewPlan.resolve({
		config: { ...defaultConfig, models },
		routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
		catalog,
		credentials: { faux: "test", other: "test" },
		lenses: [],
		checks: [],
	});
}

async function preferred(committed: ModelRoute, preference: ModelRoute): Promise<ReviewPlan> {
	const repo = temporaryDirectory();
	try {
		gitIn(repo, "init", "--quiet", "--initial-branch=main");
		writeFiles(repo, {
			"melian.yaml": JSON.stringify({ models: { heavy: committed } }),
			"melian.local.yaml": JSON.stringify({ models: { heavy: preference } }),
		});
		const { config, routes } = await loadConfig(repo, { kind: "worktree" }, ".");
		return ReviewPlan.resolve({
			config,
			routes,
			catalog,
			credentials: { faux: "test", other: "test" },
			lenses: [],
			checks: [],
		});
	} finally {
		removeDirectory(repo);
	}
}

const lowLevels: (Level | undefined)[] = ["off", "minimal", "low"];

describe.each(shapes)("every reader of a level, for a route $name", (shape) => {
	const plan = planOf({ heavy: routeOf(shape), verifier: { ...routeOf(shape), accept: [routeOf(shape).model!] } });

	it("plans each model at the level it runs at", () => {
		const tier = plan.tier("heavy");
		expect(tier.models.map(({ model, thinking }) => [model, thinking ?? tier.thinking])).toEqual(shape.runs);
	});

	it("writes a route that runs each model at that level", () => {
		const routed = resolveModelRoute(plan.routes().heavy, "heavy", "models.heavy", "the heavy tier");
		const level = plan.routes().heavy?.thinking;
		expect(
			[{ ...routed.model, thinking: undefined }, ...routed.fallbacks].map(({ provider, modelId, thinking }) => [
				`${provider}/${modelId}`,
				thinking ?? level,
			]),
		).toEqual(shape.runs);
	});

	it("prints each model at that level in doctor's route line", () => {
		const line = plan.lines().find(({ text }) => text.startsWith("heavy: "))!.text;
		const route = shape.runs
			.map(
				([model, level]) =>
					`${model}${level === undefined || level === shape.thinking ? "" : ` at ${level}`} with test`,
			)
			.join(", then ");
		expect(line).toBe(`heavy: ${route}; routed by melian.yaml`);
	});

	it("warns of a bare fallback on another provider only where it runs at a low level", () => {
		const [last, level] = shape.runs.at(-1)!;
		const bare = typeof shape.models.at(-1) === "string";
		// A first model that runs at a level of its own was not the one the route's level was chosen for.
		const [running] = shape.runs[0]!;
		const chosenFor = shape.models.includes(running) ? running : routeOf(shape).model;
		const expected =
			bare && lowLevels.includes(level)
				? [`heavy: fallback ${last} names no thinking level, so it runs at ${level}, which was chosen for ${chosenFor}`]
				: [];
		expect(plan.warnings().filter((text) => text.startsWith("heavy: fallback"))).toEqual(expected);
	});

	it("names the level each fallback outside accept answered at in the verifier's lineage", () => {
		const reached = shape.runs.filter(([model]) => model !== routeOf(shape).model);
		for (const [model, level] of reached) {
			const lineage = plan.verifierLineage(model)!;
			expect(lineage.outside).toBe(true);
			expect(lineage.answeredAt ?? lineage.thinking?.level ?? shape.thinking).toBe(level);
		}
	});

	it("keeps every model of a guarded route that policy runs as it stands", () => {
		const guarded = planOf({ heavy: routeOf(shape, true) }).tier("heavy");
		expect(guarded.status).toBe("routed");
		expect(guarded.models.map(({ model, thinking }) => [model, thinking ?? guarded.thinking])).toEqual(shape.runs);
	});

	it("runs no model of a guarded route at a level policy does not, when a preference reverses the models that run", async () => {
		const names = shape.models.map((each) => (typeof each === "string" ? each : each.model));
		const reached = names.filter((name) => !name.startsWith("nowhere/"));
		const entry = (name: string) => shape.models[names.indexOf(name)]!;
		const [first, ...rest] = [...names.filter((name) => name.startsWith("nowhere/")), ...reached.reverse()].map(
			entry,
		);
		const { accept: _accept, acceptOverridden: _overridden, ...committed } = routeOf(shape, true);
		const tier = (
			await preferred(routeOf(shape, true), {
				...committed,
				model: first as string,
				fallbacks: rest,
			})
		).tier("heavy");
		const committedAt = new Map(shape.runs);
		for (const { model, thinking } of tier.models)
			expect([model, thinking ?? tier.thinking]).toEqual([model, committedAt.get(model)]);
	});
});
