import {
	ConfigError,
	defaultConfig,
	describeLineage,
	loadConfig,
	type ModelRoute,
	type ModelTier,
	ReviewPlan,
	resolveModelForTier,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { gitIn, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

const catalog = ["first", "second", "third"].map((id) => ({
	provider: "faux",
	id,
	name: id,
	reasoning: true,
	contextWindow: 200000,
	cost: { input: 0, output: 0 },
}));

function planOf(models: Partial<Record<ModelTier, ModelRoute>>, model?: string): ReviewPlan {
	return ReviewPlan.resolve({
		config: { ...defaultConfig, models },
		routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
		...(model === undefined ? {} : { model }),
		catalog,
		credentials: { faux: "test" },
		lenses: [],
		checks: [],
	});
}

async function loaded(files: Record<string, string>) {
	const repo = temporaryDirectory();
	try {
		gitIn(repo, "init", "--quiet", "--initial-branch=main");
		writeFiles(repo, files);
		return await loadConfig(repo, { kind: "worktree" }, ".");
	} finally {
		removeDirectory(repo);
	}
}

describe("a fallback's own thinking level", () => {
	it("resolves each fallback with the level its entry names, and none for a bare model", () => {
		expect(
			resolveModelForTier("heavy", {
				heavy: {
					model: "faux/first",
					thinking: "low",
					fallbacks: [{ model: "faux/second", thinking: "medium" }, "faux/third", { model: "faux/first" }],
				},
			}),
		).toEqual({
			tier: "heavy",
			model: { provider: "faux", modelId: "first" },
			fallbacks: [
				{ provider: "faux", modelId: "second", thinking: "medium" },
				{ provider: "faux", modelId: "third" },
				{ provider: "faux", modelId: "first" },
			],
		});
	});

	it("loads a fallback entry with its own level from melian.yaml", async () => {
		const { config } = await loaded({
			"melian.yaml":
				"models:\n  heavy:\n    model: faux/first\n    thinking: low\n    fallbacks: [{ model: faux/second, thinking: medium }, faux/third]\n",
		});
		expect(config.models.heavy).toEqual({
			model: "faux/first",
			thinking: "low",
			fallbacks: [{ model: "faux/second", thinking: "medium" }, "faux/third"],
		});
	});

	it("refuses a fallback entry with a key other than model and thinking", async () => {
		await expect(
			loaded({
				"melian.yaml":
					"models:\n  heavy:\n    model: faux/first\n    fallbacks: [{ model: faux/second, effort: medium }]\n",
			}),
		).rejects.toBeInstanceOf(ConfigError);
	});

	it("refuses a fallback level Pi does not know", async () => {
		await expect(
			loaded({
				"melian.yaml":
					"models:\n  heavy:\n    model: faux/first\n    fallbacks: [{ model: faux/second, thinking: highest }]\n",
			}),
		).rejects.toBeInstanceOf(ConfigError);
	});

	it("plans each model with its own level, and the route's elsewhere", () => {
		const plan = planOf({
			heavy: {
				model: "faux/first",
				thinking: "low",
				fallbacks: [{ model: "faux/second", thinking: "medium" }, "faux/third"],
			},
		});
		expect(plan.tier("heavy")).toMatchObject({
			status: "routed",
			thinking: "low",
			models: [
				{ model: "faux/first", credential: "test", family: "first" },
				{ model: "faux/second", credential: "test", family: "second", thinking: "medium" },
				{ model: "faux/third", credential: "test", family: "third" },
			],
		});
		expect(plan.tier("heavy").models[0]).not.toHaveProperty("thinking");
		expect(plan.tier("heavy").models[2]).not.toHaveProperty("thinking");
		expect(plan.routes().heavy).toEqual({
			model: "faux/first",
			thinking: "low",
			fallbacks: [{ model: "faux/second", thinking: "medium" }, "faux/third"],
		});
		expect(ReviewPlan.from(plan.toJSON()).toJSON()).toEqual(plan.toJSON());
	});

	it("gives the route's own model no level of its own, though a fallback entry names it too", () => {
		const plan = planOf({
			heavy: { model: "faux/first", thinking: "low", fallbacks: [{ model: "faux/first", thinking: "high" }] },
		});
		expect(plan.tier("heavy").models[0]).toEqual({ model: "faux/first", credential: "test", family: "first" });
	});

	it("runs --model at the route's level, though a fallback entry names that model's own", () => {
		const plan = planOf(
			{ heavy: { model: "faux/first", thinking: "low", fallbacks: [{ model: "faux/second", thinking: "medium" }] } },
			"faux/second",
		);
		expect(plan.tier("heavy").models).toEqual([{ model: "faux/second", credential: "test", family: "second" }]);
	});

	it("runs a verifier on its own route's fallback levels", () => {
		const plan = planOf({
			verifier: { model: "faux/first", fallbacks: [{ model: "faux/second", thinking: "high" }] },
		});
		expect(plan.verifierRoute("faux/third")).toEqual([
			{ model: "faux/first", credential: "test", family: "first" },
			{ model: "faux/second", credential: "test", family: "second", thinking: "high" },
		]);
	});

	it("runs a verifier borrowing a lens tier at verifier thinking, not the tier's fallback level", () => {
		const plan = planOf({
			heavy: { model: "faux/first", fallbacks: [{ model: "faux/second", thinking: "high" }] },
			verifier: { thinking: "off" },
		});
		expect(plan.tier("verifier").status).toBe("unrouted");
		expect(plan.verifierRoute("faux/third")).toEqual([
			{ model: "faux/first", credential: "test", family: "first" },
			{ model: "faux/second", credential: "test", family: "second" },
		]);
	});
});

describe("the lineage of a fallback with its own level", () => {
	const verifier = (fallback: string | { model: string; thinking: "medium" }) =>
		planOf({ verifier: { model: "faux/first", thinking: "low", fallbacks: [fallback], accept: ["faux/first"] } });

	it("names the level a fallback outside accept answered at, from its own entry", () => {
		expect(verifier({ model: "faux/second", thinking: "medium" }).verifierLineage("faux/second")).toEqual({
			model: "faux/second",
			wanted: "faux/first",
			by: "melian.yaml",
			outside: true,
			answeredAt: "medium",
		});
	});

	it("names no level for a bare fallback, which answers at its route's", () => {
		expect(verifier("faux/second").verifierLineage("faux/second")).toEqual({
			model: "faux/second",
			wanted: "faux/first",
			by: "melian.yaml",
			outside: true,
		});
	});

	it("leaves no lineage for a committed fallback inside accept, whatever its level", () => {
		const plan = planOf({
			verifier: {
				model: "faux/first",
				thinking: "low",
				fallbacks: [{ model: "faux/second", thinking: "medium" }],
				accept: ["faux/first", "faux/second"],
			},
		});
		expect(plan.verifierLineage("faux/second")).toBeUndefined();
	});

	it("says in the verdict and in doctor the level a fallback answered at", () => {
		const plan = verifier({ model: "faux/second", thinking: "medium" });
		const own = "it answered at thinking medium, its own entry's level";
		expect(describeLineage(plan.verifierLineage("faux/second")!)).toBe(
			`on faux/second, set by melian.yaml, where policy wants faux/first and does not accept faux/second; ${own}`,
		);
		expect(describeLineage(verifier("faux/second").verifierLineage("faux/second")!)).not.toContain("answered at");
	});

	it("says in doctor the level a fallback the plan runs first answers at", () => {
		const plan = planOf({
			verifier: {
				model: "faux/gone",
				thinking: "low",
				fallbacks: [{ model: "faux/second", thinking: "medium" }],
				accept: ["faux/gone"],
			},
		});
		expect(plan.lines().map(({ text }) => text)).toContain(
			"verifier runs faux/second, set by melian.yaml; the committed route wants faux/gone, and does not accept faux/second; it answers at thinking medium, its own entry's level",
		);
		expect(
			planOf({
				verifier: { model: "faux/gone", thinking: "low", fallbacks: ["faux/second"], accept: ["faux/gone"] },
			})
				.lines()
				.map(({ text }) => text)
				.join("\n"),
		).not.toContain("answers at");
	});
});

describe("a preference that changes a fallback's level", () => {
	const committed =
		"models:\n  heavy:\n    model: faux/first\n    thinking: low\n    fallbacks: [{ model: faux/second, thinking: medium }]\n    accept: [faux/first, faux/second]\n";

	async function planWith(local: string, acceptOverridden?: false) {
		const { config, routes } = await loaded({
			"melian.yaml": `${committed}${acceptOverridden === false ? "    acceptOverridden: false\n" : ""}`,
			"melian.local.yaml": local,
		});
		return ReviewPlan.resolve({ config, routes, catalog, credentials: { faux: "test" }, lenses: [], checks: [] });
	}

	it("runs the preference's level where policy allows an override", async () => {
		const plan = await planWith(
			"models:\n  heavy:\n    model: faux/first\n    fallbacks: [{ model: faux/second, thinking: high }]\n",
		);
		expect(plan.tier("heavy")).toMatchObject({ status: "routed", by: "melian.local.yaml" });
		expect(plan.tier("heavy").models[1]).toEqual({
			model: "faux/second",
			credential: "test",
			family: "second",
			thinking: "high",
		});
	});

	it("drops a fallback a preference relevels under acceptOverridden false, and keeps the rest", async () => {
		const plan = await planWith(
			"models:\n  heavy:\n    model: faux/first\n    fallbacks: [{ model: faux/second, thinking: high }]\n",
			false,
		);
		expect(plan.tier("heavy")).toMatchObject({ status: "routed" });
		expect(plan.tier("heavy").models).toEqual([{ model: "faux/first", credential: "test", family: "first" }]);
	});

	it("keeps a fallback a preference restates at its committed level under acceptOverridden false", async () => {
		const plan = await planWith(
			"models:\n  heavy:\n    model: faux/first\n    fallbacks: [{ model: faux/second, thinking: medium }]\n",
			false,
		);
		expect(plan.tier("heavy").models.map(({ model }) => model)).toEqual(["faux/first", "faux/second"]);
	});

	it("drops a fallback whose level a preference removes under acceptOverridden false", async () => {
		const plan = await planWith("models:\n  heavy:\n    model: faux/first\n    fallbacks: [faux/second]\n", false);
		expect(plan.tier("heavy").models.map(({ model }) => model)).toEqual(["faux/first"]);
	});

	it("refuses the tier, naming the level, when the only accepted model left is relevelled", async () => {
		const plan = await planWith(
			"models:\n  heavy:\n    model: faux/second\n    fallbacks: [{ model: faux/first, thinking: high }]\n",
			false,
		);
		expect(plan.tier("heavy")).toMatchObject({
			status: "refused",
			reason:
				"models.heavy.acceptOverridden is false, and melian.local.yaml runs faux/second at thinking low; committed policy wants medium",
		});
	});
});
