import { readFileSync } from "node:fs";
import {
	Changeset,
	type Finding,
	Lens,
	loadConfig,
	type MelianConfig,
	type RepositorySource,
	Revision,
	Standards,
	visibleText,
} from "@melian-agent/core";
import {
	backgroundContext,
	createMemoryStorage,
	openReviewHarness,
	type ProbeSandbox,
	type ReviewModels,
	reviewChangeset,
	TelemetryReader,
} from "@melian-agent/pipeline";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { type Golden, type GoldenRun, type ProbingRoutes, routedProbing, scoreCorpus, scoreGolden } from "./goldens.ts";

/** One combination a measurement runs, by a label of its own, and its routes. */
export interface ProbingCombination {
	readonly label: string;
	readonly routes: ProbingRoutes;
}

const reference = /^[^/\s]+\/\S+$/;

/**
 * The combinations `MELIAN_EVAL_PROBE_ROUTES` names: `label=planner>prober` entries split by `;`, or `label=model` for
 * the level without probes on that model. Throws naming the entry for any other shape, a repeated label, or none.
 */
export function parseCombinations(text: string | undefined): ProbingCombination[] {
	const entries = (text ?? "")
		.split(";")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0)
		throw new Error("MELIAN_EVAL_PROBE_ROUTES names no combination, as label=planner>prober;label=model");
	const combinations = entries.map((entry): ProbingCombination => {
		const match = /^([a-z0-9][a-z0-9-]*)=([^>]+?)(?:>(.+))?$/.exec(entry);
		const [planner, prober] = [match?.[2]?.trim(), match?.[3]?.trim()];
		if (match === null || !reference.test(planner!) || (prober !== undefined && !reference.test(prober)))
			throw new Error(
				`MELIAN_EVAL_PROBE_ROUTES entry ${JSON.stringify(entry)} is not label=provider/model>provider/model`,
			);
		return { label: match[1]!, routes: { planner: planner!, ...(prober === undefined ? {} : { prober }) } };
	});
	const labels = combinations.map((each) => each.label);
	const repeated = labels.find((label, index) => labels.indexOf(label) !== index);
	if (repeated !== undefined) throw new Error(`MELIAN_EVAL_PROBE_ROUTES names ${repeated} twice`);
	return combinations;
}

const text = Type.String({ minLength: 1 });

/**
 * The JSON Schema of a misses file: the `needs-execution` misses `melian compare stats` counts, each a range of a
 * repository on this machine and the file and rule the review of record found there.
 */
export const missesSchema = Type.Array(
	Type.Object(
		{ name: text, repo: text, base: text, head: text, file: text, rule: text },
		{ additionalProperties: false },
	),
	{ minItems: 1 },
);

export type Miss = Static<typeof missesSchema>[number];

/** Reads a misses file, refusing one that is not {@link missesSchema}, naming the first problem. */
export function loadMisses(path: string): Miss[] {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	const error = [...Value.Errors(missesSchema, value)][0];
	if (error !== undefined) throw new Error(`${path}: ${error.instancePath || "(root)"} ${error.message}`);
	return value as Miss[];
}

/** One review a measurement ran: what it reported and what it spent. */
export interface MeasuredRun {
	readonly findings: readonly Finding[];
	readonly tokens: number;
	readonly cost: number;
	readonly milliseconds: number;
}

/**
 * Reviews a miss's range under `routes`, with `trust-boundary` alone at `deep` and the rest of the policy the base's.
 * The base's policy is read but not handed to the review, so the configuration's band holds for every path.
 */
export async function reviewMiss(
	miss: Miss,
	models: ReviewModels,
	routes: ProbingRoutes,
	verifierModel?: string,
	probeSandbox?: ProbeSandbox,
): Promise<MeasuredRun> {
	const source: RepositorySource = { kind: "revision", commit: miss.base };
	const changeset = await Changeset.resolve(miss.repo, `${miss.base}...${miss.head}`);
	const paths = changeset.revision.paths();
	const loaded = (await loadConfig(miss.repo, source, ".")).config;
	const scoped: MelianConfig = {
		...loaded,
		tiers: { ...loaded.tiers, full: ["lens.trust-boundary"] },
		stages: { ...loaded.stages, "pull-request": "full" },
		lenses: { "trust-boundary": { level: { floor: "deep", ceiling: "deep" } } },
		models: {
			...loaded.models,
			...(verifierModel === undefined ? {} : { verifier: { model: verifierModel } }),
		},
	};
	const { lenses, config } = routedProbing(routes, await Lens.load(miss.repo, source, paths), scoped);
	const storage = createMemoryStorage();
	const harness = await openReviewHarness(storage, models, probeSandbox === undefined ? {} : { probeSandbox });
	const began = Date.now();
	try {
		const { verdict } = await reviewChangeset({
			harness,
			changeset,
			config,
			lenses,
			standards: await Standards.load(miss.repo, source, paths),
			models,
			writer: { trusted: true, by: "reviewer" },
		});
		const telemetry = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		return {
			findings: Object.values(verdict.findings).flat(),
			tokens: telemetry.total?.total.totalTokens ?? 0,
			cost: telemetry.total?.total.cost.total ?? 0,
			milliseconds: Date.now() - began,
		};
	} finally {
		await harness.close(backgroundContext);
	}
}

/** Whether a review's findings hold the miss: a finding at its file under its rule, from `trust-boundary`. */
export function foundMiss(miss: Miss, findings: readonly Finding[]): boolean {
	return findings.some(
		(finding) =>
			finding.properties.path === miss.file &&
			finding.ruleId === miss.rule &&
			finding.properties.verification?.verdict !== "refuted" &&
			finding.properties.source?.check === "lens.trust-boundary",
	);
}

/** What one combination scored: the goldens' corpus scores, the misses found, and the spend, over every pass. */
export interface CombinationResult {
	readonly label: string;
	readonly routes: ProbingRoutes;
	readonly passes: number;
	readonly goldens: { readonly precision: number; readonly recall: number; readonly failed: number };
	readonly misses: {
		readonly found: number;
		readonly total: number;
		readonly recall: number;
		readonly failed: number;
	};
	readonly tokens: number;
	readonly cost: number;
	readonly milliseconds: number;
}

/** How a measurement reviews one golden or one miss under a combination's routes. */
export interface ProbingRunners {
	golden(golden: Golden, routes: ProbingRoutes): Promise<GoldenRun & { readonly milliseconds: number }>;
	miss(miss: Miss, routes: ProbingRoutes): Promise<MeasuredRun>;
}

/**
 * Runs every combination over the goldens and the misses `passes` times each, and prints each review's score and spend
 * and each combination's totals: the goldens' corpus micro-average, the misses' recall, and the tokens, cost and
 * time. A review that throws counts as failed, prints why, and the rest still run.
 */
export async function measureProbing(
	combinations: readonly ProbingCombination[],
	goldens: readonly Golden[],
	misses: readonly Miss[],
	passes: number,
	runners: ProbingRunners,
	print: (line: string) => void,
): Promise<CombinationResult[]> {
	const results: CombinationResult[] = [];
	for (const { label, routes } of combinations) {
		const scores = [];
		let found = 0;
		let goldenFailures = 0;
		let missFailures = 0;
		let tokens = 0;
		let cost = 0;
		let milliseconds = 0;
		for (let pass = 1; pass <= passes; pass++) {
			for (const golden of goldens) {
				try {
					const run = await runners.golden(golden, routes);
					const score = scoreGolden(golden, run.findings);
					scores.push(score);
					tokens += run.telemetry.total?.total.totalTokens ?? 0;
					cost += run.telemetry.total?.total.cost.total ?? 0;
					milliseconds += run.milliseconds;
					print(
						visibleText(
							`${label} pass ${pass} ${golden.name}: precision ${score.precision.toFixed(2)}, recall ${score.recall.toFixed(2)}, ${run.telemetry.spend()}, ${run.milliseconds} ms`,
						),
					);
				} catch (error) {
					goldenFailures++;
					print(visibleText(`${label} pass ${pass} ${golden.name}: no score (${String(error)})`));
				}
			}
			for (const miss of misses) {
				try {
					const run = await runners.miss(miss, routes);
					const hit = foundMiss(miss, run.findings);
					if (hit) found++;
					tokens += run.tokens;
					cost += run.cost;
					milliseconds += run.milliseconds;
					print(
						visibleText(
							`${label} pass ${pass} ${miss.name}: ${hit ? "found" : "missed"}, ${run.findings.length} reported, ${run.tokens} tokens, $${run.cost}, ${run.milliseconds} ms`,
						),
					);
				} catch (error) {
					missFailures++;
					print(visibleText(`${label} pass ${pass} ${miss.name}: no result (${String(error)})`));
				}
			}
		}
		const corpus = scoreCorpus(scores);
		const total = misses.length * passes;
		const result: CombinationResult = {
			label,
			routes,
			passes,
			goldens: { ...corpus, failed: goldenFailures },
			misses: { found, total, recall: total === 0 ? 1 : found / total, failed: missFailures },
			tokens,
			cost,
			milliseconds,
		};
		results.push(result);
		print(
			visibleText(
				`${label} (${routes.planner} planning, ${routes.prober ?? "no probes"} probing): goldens precision ${corpus.precision.toFixed(2)}, recall ${corpus.recall.toFixed(2)}; misses recall ${result.misses.recall.toFixed(2)} (${found} of ${total}); ${tokens} tokens, $${cost.toFixed(2)}, ${(milliseconds / 1000).toFixed(0)} s; ${goldenFailures + missFailures} failed`,
			),
		);
	}
	return results;
}
