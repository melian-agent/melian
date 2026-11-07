/**
 * Measures a level that probes live, combination by combination, on the probing goldens and on the `needs-execution`
 * misses. Spends real tokens, so it runs only with `MELIAN_EVAL_LIVE=1`, and never in `npm run check`.
 *
 * - `MELIAN_EVAL_PROBE_ROUTES`: the combinations, `label=planner>prober` entries split by `;`, the planner on the
 *   heavy tier and the prober on medium; `label=model` runs the level without probes on that model, for comparison.
 * - `MELIAN_EVAL_PROBE_PASSES`: passes per combination, three by default.
 * - `MELIAN_EVAL_MISSES`: a JSON file of misses, each `{ name, repo, base, head, file, rule }`, from
 *   `melian compare stats`; without it only the goldens run.
 * - `MELIAN_EVAL_GOLDEN`: one probing golden instead of every one whose name starts `trust-boundary-probe-`.
 * - `MELIAN_EVAL_VERIFIER_MODEL`: the verifier's route; the committed one otherwise.
 * - `MELIAN_EVAL_PROBE_OUT`: a file to write the results to as JSON.
 *
 * Exits 2 before touching a provider for a malformed setting, and 1 when any review failed.
 *
 * @module
 */
import { writeFileSync } from "node:fs";
import { liveModels } from "./credentials.ts";
import { loadGoldens, runGolden, selectGoldens } from "./goldens.ts";
import { loadMisses, measureProbing, parseCombinations, reviewMiss } from "./probing.ts";

if (process.env.MELIAN_EVAL_LIVE !== "1") {
	console.error("Live evals call real models and spend tokens. Set MELIAN_EVAL_LIVE=1 to run them.");
	process.exit(2);
}

let setup: ReturnType<typeof settings>;
function settings() {
	const passes = Number(process.env.MELIAN_EVAL_PROBE_PASSES ?? "3");
	if (!Number.isInteger(passes) || passes < 1)
		throw new Error("MELIAN_EVAL_PROBE_PASSES must be a whole number of 1 or more");
	const probing = loadGoldens().filter((golden) => golden.name.startsWith("trust-boundary-probe-"));
	const misses = process.env.MELIAN_EVAL_MISSES;
	return {
		combinations: parseCombinations(process.env.MELIAN_EVAL_PROBE_ROUTES),
		passes,
		goldens: selectGoldens(probing, process.env.MELIAN_EVAL_GOLDEN),
		misses: misses === undefined || misses === "" ? [] : loadMisses(misses),
	};
}
try {
	setup = settings();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}

const models = await liveModels(process.cwd());
const verifierModel = process.env.MELIAN_EVAL_VERIFIER_MODEL;
const results = await measureProbing(
	setup.combinations,
	setup.goldens,
	setup.misses,
	setup.passes,
	{
		golden: async (golden, probing) => {
			const began = Date.now();
			const run = await runGolden(golden, {
				kind: "live",
				models,
				probing,
				...(verifierModel === undefined ? {} : { verifierModel }),
			});
			return { ...run, milliseconds: Date.now() - began };
		},
		miss: (miss, probing) => reviewMiss(miss, models, probing, verifierModel),
	},
	console.log,
);
const out = process.env.MELIAN_EVAL_PROBE_OUT;
if (out !== undefined && out !== "") writeFileSync(out, `${JSON.stringify(results, null, "\t")}\n`);
process.exit(results.some((result) => result.goldens.failed + result.misses.failed > 0) ? 1 : 0);
