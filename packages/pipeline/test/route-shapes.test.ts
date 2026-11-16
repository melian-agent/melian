import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	Lens,
	type MelianConfig,
	type ModelRoute,
	ReviewPlan,
	resolveModelRoute,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../src/harness.ts";
import { planInputs, RouteTextModel } from "../src/models.ts";
import { openReviewHarness, reviewChangeset } from "../src/review.ts";
import { createFakeModels, fauxAssistantMessage, fauxToolCall, scriptVerifier } from "../src/testing.ts";
import { crashFinding, crashRepository } from "./fixtures/review-scenario.ts";

type Level = NonNullable<ModelRoute["thinking"]>;

// Each shape is a route whose `nowhere/` models no credential reaches, and the models a failover asks, in order, at the
// levels they are asked at. Every caller that drops a model from a route must ask the same, so a new caller that
// derives a level by hand fails here.
const shapes: {
	name: string;
	thinking?: Level;
	models: (string | { model: string; thinking: Level })[];
	asked: [string, Level | undefined][];
}[] = [
	{
		name: "first unreachable, at low",
		thinking: "low",
		models: ["nowhere/a", { model: "b", thinking: "high" }, "c"],
		asked: [
			["b", "high"],
			["c", "low"],
		],
	},
	{
		name: "first unreachable, at high, promoted low",
		thinking: "high",
		models: ["nowhere/a", { model: "b", thinking: "low" }, "c"],
		asked: [
			["b", "low"],
			["c", "high"],
		],
	},
	{
		name: "first two unreachable, at low",
		thinking: "low",
		models: ["nowhere/a", { model: "nowhere/b", thinking: "high" }, { model: "c", thinking: "medium" }, "d"],
		asked: [
			["c", "medium"],
			["d", "low"],
		],
	},
	{
		name: "first unreachable, no level",
		models: ["nowhere/a", "b", "c"],
		asked: [
			["b", undefined],
			["c", undefined],
		],
	},
	{
		name: "first reachable, at low",
		thinking: "low",
		models: ["a", { model: "b", thinking: "high" }, "c"],
		asked: [
			["a", "low"],
			["b", "high"],
			["c", "low"],
		],
	},
];

// A route of `shape` whose reachable models are the faux models `${prefix}-<name>`.
function routeOf(shape: (typeof shapes)[number], prefix: string): ModelRoute {
	const name = (model: string) => (model.startsWith("nowhere/") ? `${model}-${prefix}` : `faux/${prefix}-${model}`);
	const [first, ...rest] = shape.models.map((each) =>
		typeof each === "string" ? name(each) : { model: name(each.model), thinking: each.thinking },
	);
	return {
		...(shape.thinking === undefined ? {} : { thinking: shape.thinking }),
		model: first as string,
		fallbacks: rest,
	};
}

async function review(shape: (typeof shapes)[number], planned: boolean) {
	const repo = crashRepository();
	const ids = shape.asked.flatMap(([model]) => [`lens-${model}`, `judge-${model}`]);
	const fake = createFakeModels({ models: ids.map((id) => ({ id })) });
	const last = shape.asked.at(-1)![0];
	const asked: [string, unknown][] = [];
	let reported = false;
	fake.provider.setResponses(
		Array.from({ length: 24 }, () => (request, options, _state, model) => {
			if (!asked.some(([id]) => id === model.id)) asked.push([model.id, options?.reasoning]);
			if (model.id !== `lens-${last}` && model.id !== `judge-${last}`)
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit exceeded" });
			if (model.id === `judge-${last}`) return scriptVerifier(request.messages);
			if (reported) return fauxAssistantMessage("Done.");
			reported = true;
			return fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" });
		}),
	);
	const opened = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false });
	try {
		const lens = (await Lens.builtins()).find((each) => each.name === "correctness")!;
		const route = routeOf(shape, "lens");
		const config: MelianConfig = {
			...defaultConfig,
			tiers: { full: ["lens.correctness"] },
			lenses: { correctness: { route } },
			models: { verifier: routeOf(shape, "judge") },
		};
		const { catalog, credentials } = await planInputs(fake.review);
		const plan = planned
			? ReviewPlan.resolve({
					config,
					routes: {
						committed: config.models,
						overridden: {},
						lensTiers: {},
						retiered: {},
						lensRoutes: { correctness: route },
						lensRouteThinking: shape.thinking === undefined ? {} : { correctness: "melian.yaml" },
					},
					catalog,
					credentials,
					lenses: [lens],
					checks: ["lens.correctness"],
				})
			: undefined;
		await reviewChangeset({
			harness: opened,
			changeset: await Changeset.resolve(repo, "main...feature"),
			lenses: [lens],
			standards: [],
			models: fake.review,
			checks: [],
			config,
			...(plan === undefined ? {} : { plan }),
		});
		// Triage and the walkthrough pick the first model they reach, so they must pick the first a failover asks.
		const routes = plan === undefined ? config.models : plan.routes();
		const resolved = resolveModelRoute(routes.verifier, "verifier", "models.verifier", "the verifier");
		const text = await RouteTextModel.create(
			fake.review,
			[resolved.model, ...resolved.fallbacks],
			routes.verifier?.thinking,
		);
		return { asked, picked: text?.name };
	} finally {
		await opened.close();
		rmSync(repo, { recursive: true, force: true });
	}
}

describe.each([
	["with a plan", true],
	["with no plan", false],
])("a failover %s", (_, planned) => {
	it.each(shapes)("asks each model of a route, $name, at the level it runs at", async (shape) => {
		const { asked, picked } = await review(shape, planned);
		for (const caller of ["lens", "judge"])
			expect(asked.filter(([id]) => id.startsWith(`${caller}-`))).toEqual(
				shape.asked.map(([model, level]) => [`${caller}-${model}`, level]),
			);
		const [first, level] = shape.asked[0]!;
		expect(picked).toBe(`faux/judge-${first}${level === undefined ? "" : ` thinking=${level}`}`);
	});
});
