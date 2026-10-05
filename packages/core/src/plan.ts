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

/** One chat model of the catalogue the resolver reads: pi-ai's, or a test's. `cost` is dollars per million tokens. */
export interface CatalogueModel {
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
	readonly catalogue: readonly CatalogueModel[];
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
export type PlannedModel = { model: string; credential: string };

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
	/** Why the tier is not routed, or why a check on it fails. */
	reason?: string;
};

/** A lens the review runs, and the tier each of its levels runs on. */
export type PlannedLens = { name: string; levels: { level: ScrutinyLevel; tier: LensTier }[] };

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
	 * model then fallbacks, or its `accept` when it names no model. Only models the catalogue holds and some credential
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

	private static lensesOf({ config, lenses, checks }: PlanInput): PlannedLens[] {
		const named = new Set(checks.filter((check) => check.startsWith("lens.")).map((check) => check.slice(5)));
		const planned = new Map<string, PlannedLens>();
		for (const lens of lenses) {
			const settings = Object.hasOwn(config.lenses, lens.name) ? config.lenses[lens.name] : undefined;
			if (!named.has(lens.name) || settings?.enabled === false || planned.has(lens.name)) continue;
			const levels = scrutinyLevels.flatMap((level) => {
				const declared = lens.levels[level];
				return declared === undefined ? [] : [{ level, tier: settings?.tier ?? declared.tier }];
			});
			planned.set(lens.name, { name: lens.name, levels });
		}
		return [...planned.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	private static resolveTier(tier: ModelTier, input: PlanInput): PlannedTier {
		const { config, routes, catalogue, credentials } = input;
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
			route = effective?.accept ?? [];
		}
		for (const name of [...route, ...accept]) parseModelReference(name, tier);
		const entry = (name: string) => {
			const { provider, modelId } = parseModelReference(name, tier);
			return catalogue.find((model) => model.provider === provider && model.id === modelId);
		};
		const usable = (name: string) => entry(name) !== undefined && Object.hasOwn(credentials, entry(name)!.provider);
		const planned = (names: readonly string[]) =>
			names.map((model) => ({
				model,
				credential: credentials[parseModelReference(model, tier).provider] ?? "none",
			}));
		const base = { tier, ...(wanted === undefined ? {} : { wanted }) };
		if (route.length === 0 && accept.length === 0) {
			return { ...base, status: "unrouted", models: [], reason: `no model is configured for the ${tier} tier` };
		}
		let chosen = route.filter(usable);
		// The committed route stands for policy, so any model policy accepts may stand in for it; a route the
		// maintainer chose is theirs, and is never swapped behind their back.
		if (chosen.length === 0 && by === undefined) chosen = accept.filter(usable);
		if (chosen.length === 0) {
			const tried = by === undefined ? [...new Set([...route, ...accept])] : route;
			if (by === undefined && policy?.unavailable === "fail") {
				return {
					...base,
					status: "unavailable",
					models: [],
					reason: `none of ${listed(tried)}, which models.${tier} accepts, has credentials, and models.${tier}.unavailable is fail`,
				};
			}
			const derived = by === undefined ? ReviewPlan.derive(tried, catalogue, credentials, tier) : undefined;
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
		const outside = accept.length > 0 && !accept.includes(chosen[0]!);
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
		catalogue: readonly CatalogueModel[],
		credentials: Readonly<Record<string, string>>,
		tier: ModelTier,
	): string | undefined {
		const covered = catalogue.filter((model) => Object.hasOwn(credentials, model.provider));
		const known = wanted.flatMap((name) => {
			const { provider, modelId } = parseModelReference(name, tier);
			const found = catalogue.find((model) => model.provider === provider && model.id === modelId);
			return found === undefined ? [] : [found];
		});
		const named = (model: CatalogueModel) => `${model.provider}/${model.id}`;
		for (const target of known) {
			const same = covered.filter((model) => sameModel(model.name) === sameModel(target.name));
			const plain = same.find((model) => !/\(/.test(model.name)) ?? same[0];
			if (plain !== undefined) return named(plain);
		}
		const reference = known[0];
		if (reference === undefined) return undefined;
		const price = (model: CatalogueModel) => Math.log(model.cost.input + model.cost.output + 0.01);
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

	/** Why a check on `tier` from the review's lens must fail without running, or `undefined` when it may run. */
	refusal(tier: ModelTier): string | undefined {
		const { status, reason } = this.tier(tier);
		return status === "unavailable" || status === "refused" ? reason : undefined;
	}

	/** Why a check on `tier` runs on a model the committed route did not choose, or `undefined` when it does not. */
	lineage(tier: ModelTier): CheckLineage | undefined {
		const { models, wanted, by, outside } = this.tier(tier);
		const model = models[0]?.model;
		// With no committed model and nothing outside accept, there was no committed route to leave.
		if (by === undefined || model === undefined || model === wanted || (wanted === undefined && !outside)) {
			return undefined;
		}
		return { model, ...(wanted === undefined ? {} : { wanted }), by, outside: outside === true };
	}

	/**
	 * `records` with each lens's lineage added, for every lens that ran, or was to run, at a level whose tier the plan
	 * routed off the committed route.
	 */
	mark(records: readonly CheckRecord[]): CheckRecord[] {
		return records.map((record) => {
			const lens = this.lenses.find((each) => `lens.${each.name}` === record.name);
			const tier = lens?.levels.find((each) => each.level === record.level)?.tier;
			const lineage = tier === undefined ? undefined : this.lineage(tier);
			return lineage === undefined || record.lineage !== undefined ? record : { ...record, lineage };
		});
	}

	// The tiers the review's lenses run on, with the lenses on each. Every lens runs at its default level until triage
	// chooses one per review, so only that level's tier counts.
	private used(): Map<ModelTier, string[]> {
		const used = new Map<ModelTier, string[]>();
		for (const lens of this.lenses) {
			const tier = lens.levels.find(({ level }) => level === defaultScrutinyLevel)?.tier;
			if (tier !== undefined) used.set(tier, [...(used.get(tier) ?? []), lens.name]);
		}
		return used;
	}

	/** The providers the review's lenses may call, in the order their routes name them, each once. */
	providers(): string[] {
		const providers = [...this.used().keys()].flatMap((tier) => {
			const { status, models } = this.tier(tier);
			return status === "routed" ? models.map(({ model }) => model.slice(0, model.indexOf("/"))) : [];
		});
		return [...new Set(providers)];
	}

	/**
	 * What a maintainer should know before a review runs: every tier the lenses use with no route, no model with
	 * credentials, or a check that will fail; and every route off the committed one, with what put it there.
	 */
	warnings(): string[] {
		const used = this.used();
		return this.tiers.flatMap((planned): string[] => {
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
				return [
					`${tier}${on}: ${reason}; log in with pi, set the provider's API key, or add a credential to melian.secrets.yaml`,
				];
			}
			if (status === "unavailable" || status === "refused") return [`${tier}${on} fails every check: ${reason}`];
			const lineage = this.lineage(tier);
			if (lineage !== undefined) return [`${tier} runs ${lineage.model}, ${ReviewPlan.lineageText(lineage)}`];
			const model = planned.models[0]?.model;
			if (planned.wanted === undefined || model === planned.wanted) return [];
			return [
				`${tier} runs ${model}, which the committed route accepts, since ${planned.wanted} has no credentials`,
			];
		});
	}

	private static lineageText({ wanted, by, outside, model }: CheckLineage): string {
		const why = by === "derived" ? "derived since no model of its route has credentials" : `set by ${by}`;
		const policy = wanted === undefined ? "" : `; the committed route wants ${wanted}`;
		return `${why}${policy}${outside ? `, and does not accept ${model}` : ""}`;
	}

	/**
	 * The plan as `melian doctor` prints it: each tier with a route, which model, from which credential, by which file;
	 * then each lens with the tier and model of each level; then every warning.
	 */
	lines(): PlanLine[] {
		const lines: PlanLine[] = [];
		for (const { tier, status, models, by } of this.tiers) {
			if (status !== "routed") continue;
			const route = models.map(({ model, credential }) => `${model} with ${credential}`).join(", then ");
			lines.push({ state: "ok", text: `${tier}: ${route}; routed by ${by ?? "melian.yaml"}` });
		}
		const model = (tier: ModelTier) => {
			const planned = this.tier(tier);
			return planned.status === "routed" ? planned.models[0]!.model : "no model";
		};
		const groups = new Map<string, string[]>();
		for (const lens of this.lenses) {
			const levels = lens.levels.map(({ level, tier }) => `${level} on ${tier} (${model(tier)})`).join(", ");
			groups.set(levels, [...(groups.get(levels) ?? []), lens.name]);
		}
		for (const [levels, names] of groups) lines.push({ state: "ok", text: `${listed(names)}: ${levels}` });
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
