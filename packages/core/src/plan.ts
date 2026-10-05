import type { CheckLineage, CheckRecord } from "./adjudication.ts";
import {
	type LensTier,
	type MelianConfig,
	type ModelRoute,
	type ModelTier,
	modelTiers,
	type RouteLineage,
} from "./config.ts";
import { defaultScrutinyLevel, type Lens, type ScrutinyLevel, scrutinyLevels } from "./lens.ts";
import { parseModelReference } from "./models.ts";
import { visibleText } from "./render.ts";

/** One chat model of the catalogue the resolver reads: pi-ai's, or a test's. `cost` is dollars per million tokens. */
export interface CatalogModel {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly reasoning: boolean;
	readonly cost: { readonly input: number; readonly output: number };
}

/** What {@link ReviewPlan.resolve} reads. */
export interface PlanInput {
	/** The effective configuration, preference files included. */
	readonly config: MelianConfig;
	/** What the committed files route each tier to, and the preference file that changed it, from `loadConfig`. */
	readonly routes: RouteLineage;
	/** `--model`, which routes every lens tier to one model. */
	readonly model?: string;
	readonly catalog: readonly CatalogModel[];
	/** Each provider that holds credentials, to where they come from, such as `ANTHROPIC_API_KEY`. Never a value. */
	readonly credentials: Readonly<Record<string, string>>;
	/** The lenses loaded for the review, and the checks its tiers name: a lens runs only where a `lens.<name>` is named. */
	readonly lenses: readonly Lens[];
	readonly checks: readonly string[];
}

/**
 * How a tier resolved. `routed` runs `models`, each with credentials. `unrouted` names no model. `uncredentialed`
 * names models none of which has credentials, and nothing could be derived. `unavailable` is a route whose policy
 * says `unavailable: fail` and none of whose accepted models has credentials. `refused` is a route that left `accept`
 * where policy says `acceptOverridden: false`. A check on an `unavailable` or `refused` tier records `failed`.
 */
export type TierStatus = "routed" | "unrouted" | "uncredentialed" | "unavailable" | "refused";

// Type aliases with mutable arrays: the plan is stored as JSON in a durable task's input.
/** One model of a tier's route, and where its credentials come from, or `none`. */
export type PlannedModel = { model: string; credential: string; family?: string };

/** One tier of a {@link ReviewPlan}, as stored. */
export type PlannedTier = {
	tier: ModelTier;
	status: TierStatus;
	/** The route a check on the tier tries, in order. */
	models: PlannedModel[];
	/** The model the committed route names, where it names one. */
	wanted?: string;
	/** What put the route there when the committed route did not: a preference file, `--model`, or `derived`. */
	by?: string;
	/** Whether the route's first model is outside the committed `accept`. */
	outside?: boolean;
	/** The models the committed route accepts: its `accept`, else its own model and fallbacks. */
	accept?: string[];
	/** Present, as `false`, when the committed route refuses a check that runs outside `accept`. */
	acceptOverridden?: false;
	/** Why the tier is not routed, or why a check on it fails. */
	reason?: string;
};

/**
 * One level of a lens: the tier it runs on, and, where a preference file moved it there, the tier the committed files
 * give it, whose route's policy still judges it, and the file that moved it.
 */
export type PlannedLevel = { level: ScrutinyLevel; tier: LensTier; committed?: LensTier; by?: string };

/**
 * A lens the review runs, and the tier each of its levels runs on. `scope` is the folder whose `.melian/` defined it,
 * empty for the root's and the built-ins: two folders may each define a lens of one name, on different tiers. Absent
 * from a plan stored before Melian kept it.
 */
export type PlannedLens = { name: string; scope?: string; levels: PlannedLevel[] };

/** What the plan says of one lens check: why it must fail without counting, and the lineage it records. */
export interface LensJudgement {
	readonly refusal?: string;
	readonly lineage?: CheckLineage;
}

/** A {@link ReviewPlan} as stored. */
export type StoredPlan = { tiers: PlannedTier[]; lenses: PlannedLens[] };

/** One line `melian doctor` prints for a plan. */
export interface PlanLine {
	readonly state: "ok" | "warn";
	readonly text: string;
}

const lensTiers: readonly ModelTier[] = ["light", "medium", "heavy"];

// A model's name across providers: Bedrock's "Claude Opus 5.5 (US)" and OpenRouter's "Anthropic: Claude Opus 5.5" are
// Anthropic's "Claude Opus 5.5".
function sameModel(name: string): string {
	return name
		.replace(/^[^:]*:\s*/, "")
		.replace(/\s*\([^)]*\)\s*$/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// A lens as a reader tells it from another of its name: the root's and the built-ins by name, a folder's with its folder.
function labelOf({ name, scope }: PlannedLens): string {
	return scope === undefined || scope === "" ? name : `${name} in ${scope}/`;
}

function listed(names: readonly string[]): string {
	if (names.length < 3) return names.join(" and ");
	return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * The review plan: which model plays each role in one review, resolved by a lookup, never a model's judgement, from
 * the routes, the catalogue, and the credentials present. Each tier gets a route; each lens the review runs gets the
 * tier of each of its levels. A route a preference file, `--model`, or a derivation put outside the committed one
 * carries that lineage, which every check on it records.
 */
export class ReviewPlan {
	readonly tiers: readonly PlannedTier[];
	readonly lenses: readonly PlannedLens[];

	private constructor(stored: StoredPlan) {
		this.tiers = stored.tiers;
		this.lenses = stored.lenses;
	}

	/** The plan a stored one describes, trusted as stored. */
	static from(stored: StoredPlan): ReviewPlan {
		return new ReviewPlan(stored);
	}

	/**
	 * Resolves the plan. For each tier: `--model` routes a lens tier to that model alone; otherwise the effective route,
	 * model then fallbacks, or its `accept` then fallbacks when it names no model. Only models the catalogue holds and some credential
	 * covers count. When none of the committed route does, the first accepted model with credentials stands in; when
	 * none of those does either, `unavailable: fail` fails the tier, and `derive`, the default, takes the same model
	 * from another provider with credentials, else the model whose price is nearest. A route from a preference file or
	 * `--model` is never replaced. Throws core's `ModelRoutingError` `invalidModel` for a model that is not
	 * `provider/model-id`.
	 */
	static resolve(input: PlanInput): ReviewPlan {
		const lenses = ReviewPlan.lensesOf(input);
		const tiers = modelTiers.map((tier) => ReviewPlan.resolveTier(tier, input));
		return new ReviewPlan({ tiers, lenses });
	}

	private static lensesOf({ config, routes, lenses, checks }: PlanInput): PlannedLens[] {
		const named = new Set(checks.filter((check) => check.startsWith("lens.")).map((check) => check.slice(5)));
		const planned = new Map<string, PlannedLens>();
		for (const lens of lenses) {
			const settings = Object.hasOwn(config.lenses, lens.name) ? config.lenses[lens.name] : undefined;
			const key = `${lens.name}\0${lens.scope}`;
			if (!named.has(lens.name) || settings?.enabled === false || planned.has(key)) continue;
			const levels = scrutinyLevels.flatMap((level): PlannedLevel[] => {
				const declared = lens.levels[level];
				if (declared === undefined) return [];
				const tier = settings?.tier ?? declared.tier;
				const committed = Object.hasOwn(routes.lensTiers, lens.name) ? routes.lensTiers[lens.name]! : declared.tier;
				if (committed === tier) return [{ level, tier }];
				const by = Object.hasOwn(routes.retiered, lens.name) ? routes.retiered[lens.name]! : "a preference file";
				return [{ level, tier, committed, by }];
			});
			planned.set(key, { name: lens.name, scope: lens.scope, levels });
		}
		return [...planned.values()].sort(
			(left, right) => left.name.localeCompare(right.name) || (left.scope ?? "").localeCompare(right.scope ?? ""),
		);
	}

	private static resolveTier(tier: ModelTier, input: PlanInput): PlannedTier {
		const { config, routes, catalog, credentials } = input;
		const policy: ModelRoute | undefined = routes.committed[tier];
		const effective: ModelRoute | undefined = config.models[tier];
		const accept = policy?.accept ?? (policy?.model === undefined ? [] : [policy.model, ...(policy.fallbacks ?? [])]);
		const wanted = policy?.model;
		const flag = input.model !== undefined && lensTiers.includes(tier) ? input.model : undefined;
		let by: string | undefined;
		let route: readonly string[];
		if (flag !== undefined) {
			route = [flag];
			by = "--model";
		} else if (effective?.model !== undefined) {
			route = [effective.model, ...(effective.fallbacks ?? [])];
			by = routes.overridden[tier];
		} else {
			route = [...new Set([...(effective?.accept ?? []), ...(effective?.fallbacks ?? [])])];
			by = routes.overridden[tier];
		}
		for (const name of [...route, ...accept]) parseModelReference(name, tier);
		const entry = (name: string) => {
			const { provider, modelId } = parseModelReference(name, tier);
			return catalog.find((model) => model.provider === provider && model.id === modelId);
		};
		const usable = (name: string) => entry(name) !== undefined && Object.hasOwn(credentials, entry(name)!.provider);
		const planned = (names: readonly string[]) =>
			names.map((model) => ({
				model,
				credential: credentials[parseModelReference(model, tier).provider] ?? "none",
				...(entry(model) === undefined ? {} : { family: sameModel(entry(model)!.name).split(" ")[0]! }),
			}));
		const base = {
			tier,
			...(wanted === undefined ? {} : { wanted }),
			...(accept.length === 0 ? {} : { accept: [...accept] }),
			...(policy?.acceptOverridden === false ? { acceptOverridden: false as const } : {}),
		};
		if (route.length === 0 && accept.length === 0) {
			return { ...base, status: "unrouted", models: [], reason: `no model is configured for the ${tier} tier` };
		}
		const accepted = (model: string) => accept.includes(model);
		// The committed route stands for policy, so an accepted model with credentials, from the route or from accept,
		// comes before any fallback outside accept; a route the maintainer chose is theirs, and is never reordered or
		// swapped behind their back.
		const inside =
			by === undefined
				? [...new Set([...route, ...accept])].filter((model) => usable(model) && accepted(model))
				: [];
		let chosen =
			by === undefined
				? [...inside, ...route.filter((model) => usable(model) && !accepted(model))]
				: route.filter(usable);
		if (by === undefined && inside.length === 0 && policy?.unavailable === "fail") {
			return {
				...base,
				status: "unavailable",
				models: [],
				reason: `none of ${listed(accept)}, which models.${tier} accepts, has credentials, and models.${tier}.unavailable is fail`,
			};
		}
		if (chosen.length === 0) {
			const tried = by === undefined ? [...new Set([...route, ...accept])] : route;
			const derived = by === undefined ? ReviewPlan.derive(tried, catalog, credentials, tier) : undefined;
			if (derived === undefined) {
				return {
					...base,
					status: "uncredentialed",
					models: planned(route.length > 0 ? route : accept),
					...(by === undefined ? {} : { by }),
					reason: `none of ${listed(tried)} has credentials`,
				};
			}
			chosen = [derived];
			by = "derived";
		}
		if (policy?.acceptOverridden === false && accept.length > 0) {
			const kept = chosen.filter((model) => accept.includes(model));
			if (kept.length === 0) {
				return {
					...base,
					status: "refused",
					models: planned(chosen),
					...(by === undefined ? {} : { by }),
					outside: true,
					reason: `models.${tier}.acceptOverridden is false, and ${by ?? "its route"} puts it on ${chosen[0]}, which models.${tier}.accept does not list`,
				};
			}
			chosen = kept;
		}
		// From the route the fail-closed branch kept, so an accepted fallback it promoted reads as inside accept.
		const outside = accept.length > 0 && !accept.includes(chosen[0]!);
		return {
			...base,
			status: "routed",
			models: planned(chosen),
			...(by === undefined ? {} : { by }),
			...(outside ? { outside } : {}),
		};
	}

	// The same model from another provider with credentials, by name, preferring a name without a qualifier such as a
	// region; else, among models with credentials, reasoning alike, and a context window at least the wanted model's
	// or 200,000 tokens, the one whose price is nearest. Deterministic: ties go to the larger context window, then by
	// provider and ID.
	private static derive(
		wanted: readonly string[],
		catalog: readonly CatalogModel[],
		credentials: Readonly<Record<string, string>>,
		tier: ModelTier,
	): string | undefined {
		const covered = catalog.filter((model) => Object.hasOwn(credentials, model.provider));
		const known = wanted.flatMap((name) => {
			const { provider, modelId } = parseModelReference(name, tier);
			const found = catalog.find((model) => model.provider === provider && model.id === modelId);
			return found === undefined ? [] : [found];
		});
		const named = (model: CatalogModel) => `${model.provider}/${model.id}`;
		for (const target of known) {
			const same = covered.filter((model) => sameModel(model.name) === sameModel(target.name));
			const plain = same.find((model) => !/\(/.test(model.name)) ?? same[0];
			if (plain !== undefined) return named(plain);
		}
		const reference = known[0];
		if (reference === undefined) return undefined;
		const price = (model: CatalogModel) => Math.log(model.cost.input + model.cost.output + 0.01);
		const floor = Math.min(reference.contextWindow, 200_000);
		const [nearest] = covered
			.filter((model) => model.reasoning === reference.reasoning && model.contextWindow >= floor)
			.sort(
				(left, right) =>
					Math.abs(price(left) - price(reference)) - Math.abs(price(right) - price(reference)) ||
					right.contextWindow - left.contextWindow ||
					named(left).localeCompare(named(right)),
			);
		return nearest === undefined ? undefined : named(nearest);
	}

	/** The tier's resolution. */
	tier(tier: ModelTier): PlannedTier {
		return this.tiers.find((each) => each.tier === tier)!;
	}

	/**
	 * The configuration's routes as the plan resolved them: each routed tier to its models, an uncredentialed tier to
	 * the route it names, so the review says no model has credentials, and no route for a tier that is unrouted, or
	 * whose checks fail without running.
	 */
	routes(): MelianConfig["models"] {
		const routes: Partial<Record<ModelTier, ModelRoute>> = {};
		for (const { tier, status, models } of this.tiers) {
			const [first, ...rest] = models.map((each) => each.model);
			if (first === undefined || (status !== "routed" && status !== "uncredentialed")) continue;
			routes[tier] = { model: first, fallbacks: rest };
		}
		return routes;
	}

	/** The verifier route for a finder, other families first, preserving order within each family. */
	verifierRoute(finder: string): PlannedModel[] {
		const own = this.tier("verifier");
		if (this.refusal("verifier") !== undefined) return [];
		const tiers =
			own.status === "routed"
				? [own]
				: (["heavy", "medium", "light"] as const)
						.map((tier) => this.tier(tier))
						.filter((tier) => tier.status === "routed");
		const models = [...new Map(tiers.flatMap((tier) => tier.models).map((model) => [model.model, model])).values()];
		const family = this.tiers.flatMap((tier) => tier.models).find((model) => model.model === finder)?.family;
		return models.sort(
			(left, right) =>
				Number(left.family === family || left.family === undefined) -
				Number(right.family === family || right.family === undefined),
		);
	}

	/** The lineage of the verifier on the model it actually used, including a lens-tier fallback. */
	verifierLineage(model: string): CheckLineage | undefined {
		const own = this.tier("verifier");
		if (own.status === "routed" || own.status === "refused") return ReviewPlan.leaving(own, model, own.by);
		const fallback = (["heavy", "medium", "light"] as const)
			.map((tier) => this.tier(tier))
			.find((tier) => tier.models.some((each) => each.model === model));
		return {
			model,
			...(own.wanted === undefined ? {} : { wanted: own.wanted }),
			by: `lens tiers${fallback?.by === undefined ? "" : ` via ${fallback.by}`}`,
			outside: (own.accept?.length ?? 0) > 0 && !own.accept!.includes(model),
		};
	}

	/** Why a check on `tier` from the review's lens must fail without running, or `undefined` when it may run. */
	refusal(tier: ModelTier): string | undefined {
		const { status, reason } = this.tier(tier);
		return status === "unavailable" || status === "refused" ? reason : undefined;
	}

	/** Why a check on `tier` runs on a model the committed route did not choose, or `undefined` when it does not. */
	lineage(tier: ModelTier): CheckLineage | undefined {
		const { models, by } = this.tier(tier);
		const model = models[0]?.model;
		return model === undefined ? undefined : ReviewPlan.leaving(this.tier(tier), model, by);
	}

	// The lineage of a check on `model` judged by `policy`'s route, `by` having put it there. Nothing when the committed
	// route put it there inside its own accept, when it is the model policy wants, or when there was no committed route
	// to leave. A model outside accept always records, the committed route's own fallback included.
	private static leaving(policy: PlannedTier, model: string, by: string | undefined): CheckLineage | undefined {
		const { wanted } = policy;
		const accept = policy.accept ?? [];
		const outside = accept.length > 0 && !accept.includes(model);
		if (model === wanted || (by === undefined && !outside) || (wanted === undefined && !outside)) return undefined;
		return { model, ...(wanted === undefined ? {} : { wanted }), by: by ?? "melian.yaml", outside };
	}

	/**
	 * What the plan says of the check of lens `name` at `level`, on `ran`, the model it finished on, or the first of its
	 * route when it has not run: why it must fail, and its lineage. A lens a preference file moved to another tier runs
	 * on that tier's route but stays under its committed tier's policy, so it cannot leave a route
	 * `acceptOverridden: false` guards by moving to a tier that guards nothing.
	 */
	judge(name: string, level: ScrutinyLevel, ran?: string, scope?: string): LensJudgement {
		const variants = this.lenses.filter((each) => each.name === name);
		const lens = scope === undefined ? variants[0] : variants.find((each) => (each.scope ?? "") === scope);
		const entry = lens?.levels.find((each) => each.level === level);
		if (entry === undefined) return {};
		const planned = this.tier(entry.tier);
		const model = ran ?? planned.models[0]?.model;
		const policyTier = entry.committed ?? entry.tier;
		const policy = this.tier(policyTier);
		// A moved lens owes its model to two things: the file that moved it, and whatever routed the tier it moved to,
		// a preference file, --model, a derivation, or the committed route itself.
		const moved =
			entry.committed === undefined
				? undefined
				: { by: entry.by ?? "a preference file", from: policyTier, to: entry.tier };
		const by = moved === undefined ? planned.by : moved.by;
		const left = model === undefined ? undefined : ReviewPlan.leaving(policy, model, by);
		const lineage: CheckLineage | undefined =
			left === undefined || moved === undefined ? left : { ...left, by: planned.by ?? "melian.yaml", moved };
		const outside = policy.acceptOverridden === false && lineage?.outside === true;
		const unlisted = `which models.${policyTier}.accept does not list`;
		const why =
			entry.committed === undefined
				? `models.${policyTier}.acceptOverridden is false, and ${by ?? "its route"} puts it on ${model}, ${unlisted}`
				: `lenses.${name}.tier moves it from ${policyTier} to ${entry.tier}, and models.${policyTier}.acceptOverridden is false; ${entry.tier} runs ${model}, ${unlisted}`;
		const refusal = this.refusal(entry.tier) ?? (outside ? why : undefined);
		return { ...(refusal === undefined ? {} : { refusal }), ...(lineage === undefined ? {} : { lineage }) };
	}

	/**
	 * `records` with each lens's lineage added, judged on the model it finished on, from `ranOn`, each variant of a lens
	 * name by its scope and level, or the first of its route. A lens that finished on a model its policy refuses, such as a
	 * fallback outside `accept`, records `failed`, since its result cannot count; so does a lens of which any variant at that level did.
	 */
	mark(
		records: readonly CheckRecord[],
		ranOn: ReadonlyMap<
			string,
			readonly { readonly scope: string; readonly level: ScrutinyLevel; readonly model: string }[]
		> = new Map(),
	): CheckRecord[] {
		return records.map((record) => {
			if (!record.name.startsWith("lens.") || record.level === undefined || record.lineage !== undefined)
				return record;
			const name = record.name.slice("lens.".length);
			const { level } = record;
			const ran = (ranOn.get(name) ?? []).filter((variant) => variant.level === level);
			const judged =
				ran.length === 0
					? [this.judge(name, level)]
					: ran.map(({ scope, model }) => this.judge(name, level, model, scope));
			const refusal = judged.find((each) => each.refusal !== undefined)?.refusal;
			const lineage = judged.find((each) => each.lineage !== undefined)?.lineage;
			const marked = lineage === undefined ? record : { ...record, lineage };
			if (refusal === undefined || record.status === "failed" || ran.length === 0) return marked;
			return { ...marked, status: "failed", reason: refusal };
		});
	}

	// The tiers the review's lenses run on, with the lenses on each: at their default level, which a review without a
	// decider runs and whose tier must reach a model, or, with `every`, at any level, since triage may choose any level a
	// lens declares and escalation may move it to the next.
	private used(every = false): Map<ModelTier, string[]> {
		const used = new Map<ModelTier, string[]>();
		for (const lens of this.lenses) {
			const levels = lens.levels.filter(({ level }) => every || level === defaultScrutinyLevel);
			for (const tier of new Set(levels.map(({ tier }) => tier))) {
				used.set(tier, [...(used.get(tier) ?? []), labelOf(lens)]);
			}
		}
		return used;
	}

	/**
	 * The providers the review's lenses may call at any level, in the order their routes name them, each once, so a
	 * credential only a quick or deep level needs is unlocked too.
	 */
	providers(): string[] {
		const providers = [...this.used(true).keys(), ...(this.lenses.length === 0 ? [] : ["verifier" as const])].flatMap(
			(tier) => {
				const { status, models } = this.tier(tier);
				return status === "routed" ? models.map(({ model }) => model.slice(0, model.indexOf("/"))) : [];
			},
		);
		return [
			...new Set([
				...providers,
				...(this.lenses.length === 0
					? []
					: this.verifierRoute("").map(({ model }) => model.slice(0, model.indexOf("/")))),
			]),
		];
	}

	/**
	 * What a maintainer should know before a review runs: every tier the lenses use with no route, no model with
	 * credentials, or a check that will fail; and every route off the committed one, with what put it there.
	 */
	warnings(): string[] {
		// Model and file names come from a melian.yaml in the working tree, which a change may write.
		return this.warningsUnescaped().map(visibleText);
	}

	private warningsUnescaped(): string[] {
		const used = this.used();
		const moved = this.lenses.flatMap((lens): string[] => {
			const entry = lens.levels.find(({ level }) => level === defaultScrutinyLevel);
			if (entry?.committed === undefined) return [];
			const { refusal, lineage } = this.judge(lens.name, entry.level, undefined, lens.scope ?? "");
			if (refusal !== undefined) return [`${labelOf(lens)} fails: ${refusal}`];
			if (lineage === undefined) return [];
			return [`${labelOf(lens)} runs ${lineage.model}, ${ReviewPlan.lineageText(lineage)}`];
		});
		const tiers = this.tiers.flatMap((planned): string[] => {
			const { tier, status, reason } = planned;
			const lenses = used.get(tier);
			const on = lenses === undefined ? "" : `, for ${listed(lenses)}`;
			if (status === "unrouted") {
				if (lenses === undefined) return [];
				return [
					`no model for ${tier}${on}; set models.${tier}.model in melian.local.yaml, or pass --model to review`,
				];
			}
			if (status === "uncredentialed") {
				if (lenses === undefined) return [];
				return [
					`${tier}${on}: ${reason}; log in with pi, set the provider's API key, or add a credential to melian.secrets.yaml`,
				];
			}
			if (status === "unavailable" || status === "refused") {
				return lenses === undefined ? [] : [`${tier}${on} fails every check: ${reason}`];
			}
			const lineage = this.lineage(tier);
			if (lineage !== undefined) return [`${tier} runs ${lineage.model}, ${ReviewPlan.lineageText(lineage)}`];
			const model = planned.models[0]?.model;
			if (planned.wanted === undefined || model === planned.wanted) return [];
			return [
				`${tier} runs ${model}, which the committed route accepts, since ${planned.wanted} has no credentials`,
			];
		});
		const verification: string[] = [];
		if (this.lenses.length > 0) {
			const own = this.tier("verifier");
			if (own.status !== "routed" && this.refusal("verifier") === undefined)
				verification.push(
					"lenses verify, but the verifier tier routes no model of its own; verification falls back to lens tiers, heavy then medium then light",
				);
			if (this.refusal("verifier") !== undefined) verification.push(`verifier fails: ${this.refusal("verifier")}`);
			const finders = [...used.keys()].flatMap((tier) => this.tier(tier).models);
			if (
				finders.length > 0 &&
				finders.every((finder) => this.verifierRoute(finder.model).every((model) => model.family === finder.family))
			)
				verification.push("every verification candidate would be judged by its finder's own family");
		}
		return [...tiers, ...moved, ...verification];
	}

	private static lineageText({ wanted, by, moved, outside, model }: CheckLineage): string {
		const routed = by === "derived" ? "derived since no model of its route has credentials" : `set by ${by}`;
		const why =
			moved === undefined
				? routed
				: `moved from ${moved.from} to ${moved.to} by ${moved.by}, whose route is ${routed}`;
		if (wanted === undefined) return `${why}; the committed route does not accept ${model}`;
		return `${why}; the committed route wants ${wanted}${outside ? `, and does not accept ${model}` : ""}`;
	}

	/**
	 * The plan as `melian doctor` prints it: each tier with a route, which model, from which credential, by which file;
	 * then each lens with the tier and model of each level; then every warning.
	 */
	lines(): PlanLine[] {
		const lines: PlanLine[] = [];
		for (const { tier, status, models, by } of this.tiers) {
			if (status !== "routed") continue;
			const route = models
				.map(
					({ model, credential, family }) =>
						`${model}${tier === "verifier" ? ` (${family ?? "unknown family"})` : ""} with ${credential}`,
				)
				.join(", then ");
			const origin =
				by === "derived"
					? "derived, since no model of the committed route has credentials"
					: `routed by ${by ?? "melian.yaml"}`;
			lines.push({ state: "ok", text: visibleText(`${tier}: ${route}; ${origin}`) });
		}
		if (this.lenses.length > 0 && this.tier("verifier").status !== "routed") {
			const route = this.verifierRoute("")
				.map(({ model, family }) => `${model} (${family ?? "unknown family"})`)
				.join(", then ");
			if (route !== "")
				lines.push({ state: "warn", text: visibleText(`verifier: ${route}; fallback from lens tiers`) });
		}
		const model = (tier: ModelTier) => {
			const planned = this.tier(tier);
			return planned.status === "routed" ? planned.models[0]!.model : "no model";
		};
		const groups = new Map<string, string[]>();
		for (const lens of this.lenses) {
			const levels = lens.levels.map(({ level, tier }) => `${level} on ${tier} (${model(tier)})`).join(", ");
			groups.set(levels, [...(groups.get(levels) ?? []), labelOf(lens)]);
		}
		for (const [levels, names] of groups) {
			lines.push({ state: "ok", text: visibleText(`${listed(names)}: ${levels}`) });
		}
		for (const warning of this.warnings()) lines.push({ state: "warn", text: warning });
		return lines;
	}

	/** The warnings a review prints beside its verdict, one per line, or the empty string when there are none. */
	summary(): string {
		return this.warnings()
			.map((warning) => `Plan: ${warning}\n`)
			.join("");
	}

	toJSON(): StoredPlan {
		return {
			tiers: this.tiers.map((tier) => structuredClone(tier)),
			lenses: this.lenses.map((lens) => structuredClone(lens)),
		};
	}
}
