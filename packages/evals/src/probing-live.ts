/**
 * Measures `trust-boundary`'s level that probes against real models: each planner and prober pair in
 * `MELIAN_EVAL_PROBE_ROUTES`, and the level without probes, over the probing goldens and the misses file. Spends real
 * tokens, so it runs only with `MELIAN_EVAL_LIVE=1`, and never in `npm run check`. `ProbingSettings` reads the rest of
 * the settings; a malformed one, a head the invocation does not vouch for, or a host that cannot run probes exits 2
 * before any provider.
 *
 * @module
 */
import { Probe } from "@melian-agent/pipeline";
import { liveModels } from "./credentials.ts";
import { loadGoldens, runGolden, runRange } from "./goldens.ts";
import { measureProbing } from "./probing.ts";

if (process.env.MELIAN_EVAL_LIVE !== "1") {
	console.error("Live evals call real models and spend tokens. Set MELIAN_EVAL_LIVE=1 to run them.");
	process.exit(2);
}

process.exit(
	await measureProbing(
		process.env,
		{
			availability: () => Probe.availability(),
			models: () => liveModels(process.cwd()),
			goldens: loadGoldens,
			golden: runGolden,
			range: runRange,
		},
		console.log,
		console.error,
	),
);
