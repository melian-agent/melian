import { defaultConfig, type ModelRoute, type ModelTier, ReviewPlan } from "@melian-agent/core";
import { expect, it } from "vitest";

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
